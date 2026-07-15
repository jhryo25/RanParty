import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const outputPath = resolve(root, option('--output') ?? 'evals/results/capability-latest.json')
const configPath = resolve(option('--config') ?? resolve(root, 'Config/config.cfg'))
const sandbox = resolve(root, '.tmp', `agent-capability-eval-${Date.now()}`)
const workspace = resolve(sandbox, 'workspace')
const backendDll = resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')
const backendArtifact = resolve(option('--backend') ?? backendDll)
const dotnet = process.env.RANPARTY_DOTNET
  || (existsSync(resolve(root, '.dotnet-sdk/dotnet.exe')) ? resolve(root, '.dotnet-sdk/dotnet.exe') : 'dotnet')
const backendCommand = backendArtifact.toLowerCase().endsWith('.exe') ? backendArtifact : dotnet
const backendArgs = backendArtifact.toLowerCase().endsWith('.exe') ? [] : [backendArtifact]
const startedAt = new Date()
const events = []
const waiting = new Map()
const terminalWaiters = new Map()
const approvedMcpTools = new Set()
let requestId = 0
let backend

try {
  await prepareSandbox()
  backend = spawn(backendCommand, backendArgs, {
    cwd: sandbox,
    windowsHide: true,
    env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget', 'packages') },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  backend.stderr.on('data', () => {})
  createInterface({ input: backend.stdout }).on('line', handleLine)

  const bootstrap = await call('app.bootstrap', {}, 30_000)
  const configured = bootstrap.settings.profiles.filter(profile => profile.apiKeyConfigured && profile.supportsTools)
  if (!configured.length) throw new Error('No configured tool-capable model profile was found')
  const selected = configured.find(profile => profile.name === bootstrap.settings.activeProfileName) ?? configured[0]
  const connectivity = await testProfile(selected)

  const skillCatalog = await call('skills.list', { workspace })
  const explicitSkill = requiredSkill(skillCatalog, 'eval-explicit-skill')
  const implicitSkill = requiredSkill(skillCatalog, 'eval-implicit-skill')
  const teamSkills = ['eval-team-leader', 'eval-team-alpha', 'eval-team-beta'].map(name => requiredSkill(skillCatalog, name))
  const team = await installExpertTeam(teamSkills)
  const mcp = await installMcpConnector()

  const tasks = []
  tasks.push(await explicitSkillTask(selected, explicitSkill))
  tasks.push(await implicitSkillTask(selected, implicitSkill))
  tasks.push(await expertTeamTask(selected, team))
  tasks.push(await mcpTask(selected, mcp))

  const connectivityScore = connectivity.passed ? 10 : 0
  const score = round(connectivityScore + tasks.reduce((sum, task) => sum + task.earnedWeight, 0))
  const report = {
    schemaVersion: 1,
    kind: 'live-capability-evaluation',
    commit: await gitCommit(),
    workingTreeDirty: await gitWorkingTreeDirty(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    artifact: await artifactMetadata(),
    selectedProfile: publicProfile(selected),
    score,
    maxScore: 100,
    connectivityScore,
    connectivity,
    fixtures: {
      skills: [explicitSkill, implicitSkill, ...teamSkills].map(skill => ({ id: skill.id, name: skill.name, trust: skill.trust, invocationPolicy: skill.invocationPolicy, allowedTools: skill.allowedTools })),
      expertTeam: team,
      mcp: { connectorId: mcp.connectorId, exposedTool: mcp.exposedTool, discoveredTools: mcp.discovery.tools.length, discoveredResources: mcp.discovery.resources.length, discoveredPrompts: mcp.discovery.prompts.length }
    },
    tasks,
    totals: {
      inputTokens: tasks.reduce((sum, task) => sum + task.usage.input, 0),
      outputTokens: tasks.reduce((sum, task) => sum + task.usage.output, 0),
      toolCalls: tasks.reduce((sum, task) => sum + task.tools.length, 0),
      approvals: tasks.reduce((sum, task) => sum + task.approvals, 0),
      delegatedAgents: tasks.reduce((sum, task) => sum + task.agentRuns.length, 0)
    },
    improvementSignals: deriveImprovementSignals(tasks),
    safety: { sandboxed: true, realSecretsEmitted: false, productionWorkspaceMutated: false }
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({
    score: report.score,
    selectedProfile: report.selectedProfile,
    connectivity: { passed: connectivity.passed, latencyMs: connectivity.latencyMs },
    tasks: tasks.map(task => ({ id: task.id, passed: task.passed, earnedWeight: task.earnedWeight, weight: task.weight, latencyMs: task.latencyMs, tools: task.tools, approvals: task.approvals, agents: task.agentRuns.length })),
    totals: report.totals,
    improvementSignals: report.improvementSignals,
    output: relative(outputPath)
  }, null, 2))
} finally {
  if (backend && backend.exitCode === null) {
    backend.stdin.end()
    await Promise.race([once(backend, 'exit'), new Promise(resolveWait => setTimeout(resolveWait, 5000))])
    if (backend.exitCode === null) backend.kill()
  }
  await rm(sandbox, { recursive: true, force: true })
}

async function explicitSkillTask(profile, skill) {
  return runChatTask({
    id: 'skill-explicit-activation',
    title: 'Explicit Skill activation and capability narrowing',
    weight: 15,
    profile,
    request: { skillIds: [skill.id] },
    prompt: 'Execute the explicitly selected evaluation Skill exactly. Do not infer the fixture value without reading the required file.',
    evaluate: ({ reply, taskEvents }) => {
      const tools = completedTools(taskEvents)
      const marker = reply.includes('SKILL_EXPLICIT_OK_5317')
      const read = tools.some(event => event.name === 'file_read' && !event.isError)
      const audited = tools.some(event => event.skillIds.includes(skill.id))
      const narrowed = tools.every(event => ['file_read'].includes(event.name))
      const points = scoreParts([[marker, 5], [read, 4], [audited, 3], [narrowed, 3]])
      return { points, criteria: { marker, fileReadObserved: read, selectedSkillAudited: audited, capabilityNarrowed: narrowed } }
    }
  })
}

async function implicitSkillTask(profile, skill) {
  return runChatTask({
    id: 'skill-implicit-discovery',
    title: 'Implicit Skill discovery, activation, and enforcement',
    weight: 15,
    profile,
    prompt: 'Run the live implicit capability evaluation workflow. Follow its instructions and do not guess the fixture value.',
    evaluate: ({ reply, taskEvents }) => {
      const tools = completedTools(taskEvents)
      const marker = reply.includes('SKILL_IMPLICIT_OK_8642')
      const viewed = tools.some(event => event.name === 'skill_view' && !event.isError)
      const activated = taskEvents.some(event => event.event === 'skill.activated' && event.id === skill.id)
      const read = tools.some(event => event.name === 'file_read' && !event.isError)
      const unsafe = tools.some(event => ['file_write', 'file_replace', 'file_append', 'shell_run', 'ps_run'].includes(event.name) && !event.isError)
      const points = scoreParts([[marker, 4], [viewed, 4], [activated, 3], [read, 3], [!unsafe, 1]])
      return { points, criteria: { marker, skillViewObserved: viewed, activationAudited: activated, fileReadObserved: read, noUnsafeTool: !unsafe } }
    }
  })
}

async function expertTeamTask(profile, team) {
  return runChatTask({
    id: 'expert-team-delegation',
    title: 'Expert team delegation, concurrency, and synthesis',
    weight: 35,
    profile,
    timeoutMs: 300_000,
    request: { expertTeamId: team.id },
    prompt: 'Use the selected expert team. Delegate the two independent checks to separate agents in one tool-call batch, wait for both, then synthesize exactly the required team result.',
    evaluate: ({ reply, taskEvents }) => {
      const tools = completedTools(taskEvents)
      const delegates = tools.filter(event => event.name === 'delegate_agent' && !event.isError)
      const runs = agentRuns(taskEvents)
      const finalMarkers = reply.includes('TEAM_ALPHA_271') && reply.includes('TEAM_BETA_936')
      const delegatedTwice = delegates.length >= 2 && runs.length >= 2
      const lifecycle = taskEvents.some(event => event.event === 'team.plan' && event.teamId === team.id)
        && taskEvents.some(event => event.event === 'team.summary' && event.teamId === team.id)
        && runs.every(run => run.completedAt >= run.startedAt)
      const parallel = hasOverlap(runs)
      const bounded = runs.length <= team.maxParallel && delegates.length <= team.maxParallel
      const onlyDelegation = tools.every(event => event.name === 'delegate_agent')
      const points = scoreParts([[finalMarkers, 10], [delegatedTwice, 10], [lifecycle, 5], [parallel, 5], [bounded && onlyDelegation, 5]])
      return { points, criteria: { finalMarkers, delegatedTwice, lifecycleCorrelated: lifecycle, actualOverlap: parallel, maxParallelRespected: bounded, capabilityNarrowed: onlyDelegation } }
    }
  })
}

async function mcpTask(profile, fixture) {
  return runChatTask({
    id: 'mcp-model-selection-and-approval',
    title: 'MCP discovery, model selection, approval, and result use',
    weight: 25,
    profile,
    prompt: `You must call the MCP echo tool with value MCP_LIVE_OK_4176, then reply exactly MCP_LIVE_OK_4176. Do not use any local file or shell tool.`,
    evaluate: ({ reply, taskEvents }) => {
      const tools = completedTools(taskEvents)
      const callEvent = tools.find(event => event.name === fixture.exposedTool)
      const discovered = fixture.discovery.tools.some(tool => tool.name === 'echo')
        && fixture.discovery.resources.some(resource => resource.name === 'status')
        && fixture.discovery.prompts.some(prompt => prompt.name === 'hello')
      const selected = Boolean(callEvent && !callEvent.isError)
      const approved = taskEvents.some(event => event.event === 'approval.requested' && event.name === fixture.exposedTool)
      const exact = reply.trim() === 'MCP_LIVE_OK_4176'
      const noWrongTool = tools.every(event => event.name === fixture.exposedTool)
      const points = scoreParts([[discovered, 5], [selected && noWrongTool, 10], [approved, 5], [exact, 5]])
      return { points, criteria: { toolsResourcesPromptsDiscovered: discovered, modelSelectedExpectedTool: selected, noWrongTool, approvalObserved: approved, exactResult: exact } }
    }
  })
}

async function runChatTask({ id, title, weight, profile, prompt, request = {}, timeoutMs = 180_000, evaluate }) {
  const session = await createSession(profile)
  const started = Date.now()
  try {
    const turn = await sendAndCollect(session, prompt, request, timeoutMs)
    const verdict = evaluate(turn)
    const taskEvents = turn.taskEvents
    const earnedWeight = round(Math.min(weight, Math.max(0, verdict.points)))
    return {
      id,
      title,
      weight,
      earnedWeight,
      passed: earnedWeight >= weight * 0.8,
      latencyMs: Date.now() - started,
      terminal: turn.terminal,
      reply: sanitizeReply(turn.reply),
      criteria: verdict.criteria,
      tools: completedTools(taskEvents).map(event => event.name),
      approvals: taskEvents.filter(event => event.event === 'approval.requested').length,
      agentRuns: agentRuns(taskEvents),
      usage: turn.usage
    }
  } finally {
    await deleteSession(session.id)
  }
}

async function createSession(profile) {
  const session = await call('session.create', { workspace })
  await call('session.update', { sessionId: session.id, profileName: profile.name, model: profile.model, mode: 'default', approvalMode: 'auto' })
  return session
}

async function sendAndCollect(session, text, request = {}, timeoutMs = 180_000) {
  const before = events.length
  const tokensBefore = await sessionUsage(session.id)
  const accepted = await call('chat.send', {
    clientMessageId: `cap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: session.id,
    text,
    imageDataUrls: [],
    fileDataUrls: [],
    skillIds: request.skillIds ?? [],
    expertIds: request.expertIds ?? [],
    expertTeamId: request.expertTeamId
  })
  const terminal = await waitTerminal(session.id, accepted.turnId, timeoutMs)
  const updated = await currentSession(session.id)
  const assistant = [...updated.messages].reverse().find(message => message.role === 'assistant' && message.turnId === accepted.turnId)
  const taskEvents = events.slice(before).filter(event => event.sessionId === session.id && (!event.turnId || event.turnId === accepted.turnId))
  return {
    terminal,
    reply: typeof assistant?.content === 'string' ? assistant.content : '',
    taskEvents,
    usage: { input: Math.max(0, updated.tokensIn - tokensBefore.input), output: Math.max(0, updated.tokensOut - tokensBefore.output) }
  }
}

async function installExpertTeam(skills) {
  const [leader, alpha, beta] = skills
  const team = {
    schemaVersion: 1,
    kind: 'team',
    id: 'live-eval-team',
    name: 'Live Evaluation Team',
    description: 'A deterministic two-member delegation fixture',
    leaderSkillId: leader.id,
    memberSkillIds: [alpha.id, beta.id],
    collaboration: 'Delegate exactly two independent tasks in the same assistant tool-call batch. One task must request only TEAM_ALPHA_271 and the other only TEAM_BETA_936. Use the selected model profile for both delegates.',
    summaryRule: 'Return both successful member markers in the final answer: TEAM_ALPHA_271 and TEAM_BETA_936.',
    maxParallel: 2
  }
  const expertRoot = resolve(sandbox, 'Config', 'Experts')
  await mkdir(expertRoot, { recursive: true })
  await writeFile(resolve(expertRoot, 'live-eval-team.json'), JSON.stringify(team, null, 2) + '\n', 'utf8')
  const catalog = await call('experts.list')
  const installed = catalog.teams.find(candidate => candidate.id === team.id)
  if (!installed) throw new Error('Expert team fixture was not discovered')
  return installed
}

async function installMcpConnector() {
  const saved = await call('connectors.save', { connector: {
    name: 'Live Eval MCP',
    type: 'stdio',
    command: process.execPath,
    args: [resolve(root, 'tests/mcp-stdio-server.mjs')],
    enabled: false,
    approvalMode: 'ask'
  } })
  const connectorId = saved.connector.id
  const discovery = await call('connectors.test', { id: connectorId, workspace }, 60_000)
  if (!discovery.ok) throw new Error(`MCP fixture discovery failed: ${safeError(discovery.error ?? 'unknown')}`)
  await call('connectors.save', { connector: { ...saved.connector, enabled: true, enabledTools: ['echo'], pinnedTools: ['echo'], approvalMode: 'ask' } })
  const catalog = await call('connectors.tools', { id: connectorId, workspace, refresh: true }, 60_000)
  const exposedTool = catalog.tools.find(tool => tool.name === 'echo')?.exposedName
  if (!exposedTool) throw new Error('MCP echo tool did not receive an exposed name')
  approvedMcpTools.add(exposedTool)
  return { connectorId, discovery, exposedTool }
}

function handleLine(line) {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'response' && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
    return
  }
  if (message.type !== 'event') return
  const data = message.data ?? {}
  const record = {
    event: message.event,
    sessionId: data.sessionId ?? '',
    turnId: data.turnId ?? '',
    name: data.name ?? data.tool ?? '',
    id: data.id ?? '',
    teamId: data.teamId ?? '',
    toolCallId: data.toolCallId ?? '',
    agentRunId: data.agentRunId ?? '',
    agentName: data.agentName ?? '',
    skillIds: Array.isArray(data.skillIds) ? data.skillIds : [],
    isError: Boolean(data.isError),
    durationMs: Number(data.durationMs ?? 0),
    at: Date.now()
  }
  events.push(record)
  if (message.event === 'approval.requested') void approveEvalRequest(data)
  if (['chat.completed', 'chat.cancelled', 'chat.error'].includes(message.event)) {
    const key = `${data.sessionId}:${data.turnId}`
    const waiter = terminalWaiters.get(key)
    if (waiter) {
      terminalWaiters.delete(key)
      waiter.resolve(message.event.replace('chat.', ''))
    }
  }
}

async function approveEvalRequest(data) {
  const approved = approvedMcpTools.has(data.tool)
  try {
    await call('approval.respond', {
      approvalId: data.approvalId,
      sessionId: data.sessionId,
      turnId: data.turnId,
      action: approved ? 'allow_once' : 'reject',
      feedback: approved ? 'approved MCP fixture call in isolated evaluation sandbox' : 'outside capability evaluation scope'
    })
  } catch {}
}

function waitTerminal(sessionId, turnId, timeoutMs) {
  const key = `${sessionId}:${turnId}`
  const existing = [...events].reverse().find(event => event.sessionId === sessionId && event.turnId === turnId && ['chat.completed', 'chat.cancelled', 'chat.error'].includes(event.event))
  if (existing) return Promise.resolve(existing.event.replace('chat.', ''))
  return new Promise((resolveTerminal, reject) => {
    const timer = setTimeout(() => {
      terminalWaiters.delete(key)
      reject(new Error(`terminal timeout: ${key}`))
    }, timeoutMs)
    terminalWaiters.set(key, { resolve: value => { clearTimeout(timer); resolveTerminal(value) } })
  })
}

function call(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolveCall, reject) => {
    const id = `cap-${++requestId}`
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, timeoutMs)
    waiting.set(id, message => {
      clearTimeout(timer)
      if (message.error) reject(new Error(typeof message.error === 'string' ? message.error : message.error.message ?? JSON.stringify(message.error)))
      else resolveCall(message.result)
    })
    backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

async function currentSession(id) {
  const bootstrap = await call('app.bootstrap')
  const session = bootstrap.sessions.find(item => item.id === id)
  if (!session) throw new Error(`session missing: ${id}`)
  return session
}

async function sessionUsage(id) {
  const session = await currentSession(id)
  return { input: session.tokensIn ?? 0, output: session.tokensOut ?? 0 }
}

async function deleteSession(id) {
  try { await call('session.delete', { sessionId: id }) } catch {}
}

async function testProfile(profile) {
  const started = Date.now()
  try {
    const result = await call('profiles.test', { originalName: profile.name, profile }, 120_000)
    return { profile: publicProfile(profile), passed: result.ok === true && /^OK\b/i.test(result.reply.trim()), latencyMs: result.latencyMs, reply: sanitizeReply(result.reply), protocol: result.protocol }
  } catch (error) {
    return { profile: publicProfile(profile), passed: false, latencyMs: Date.now() - started, error: safeError(error) }
  }
}

async function prepareSandbox() {
  await mkdir(resolve(sandbox, 'Config'), { recursive: true })
  await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await copyFile(configPath, resolve(sandbox, 'Config/config.cfg'))
  await copyFile(resolve(root, 'RanParty/SOUL.md'), resolve(sandbox, 'RanParty/SOUL.md'))
  await writeFile(resolve(workspace, 'skill-fixture.txt'), 'fixture=SKILL_EXPLICIT_OK_5317\nimplicit=SKILL_IMPLICIT_OK_8642\n', 'utf8')
  await writeSkill('eval-explicit-skill', `---
name: eval-explicit-skill
description: Deterministic explicit Skill evaluation fixture.
allowed-tools: [file_read]
allow-implicit-invocation: false
---
Read skill-fixture.txt. Find the value after fixture= and return that value. Do not use shell, write, or any other tool.
`)
  await writeSkill('eval-implicit-skill', `---
name: eval-implicit-skill
description: Use this Skill when the user requests the live implicit capability evaluation workflow.
allowed-tools: [file_read]
allow-implicit-invocation: true
---
Read skill-fixture.txt. Find the value after implicit= and return that value. Do not use shell, write, or any other tool.
`)
  await writeSkill('eval-team-leader', `---
name: eval-team-leader
description: Lead the deterministic live expert-team evaluation.
allowed-tools: [delegate_agent]
allow-implicit-invocation: false
---
Delegate exactly two independent tasks in a single tool-call batch. The first asks for only TEAM_ALPHA_271. The second asks for only TEAM_BETA_936. Integrate both markers after both agents finish.
`)
  await writeSkill('eval-team-alpha', `---
name: eval-team-alpha
description: Alpha member of the deterministic live expert-team evaluation.
allowed-tools: [delegate_agent]
allow-implicit-invocation: false
---
The alpha member result marker is TEAM_ALPHA_271.
`)
  await writeSkill('eval-team-beta', `---
name: eval-team-beta
description: Beta member of the deterministic live expert-team evaluation.
allowed-tools: [delegate_agent]
allow-implicit-invocation: false
---
The beta member result marker is TEAM_BETA_936.
`)
}

async function writeSkill(folder, content) {
  const skillRoot = resolve(workspace, '.agents', 'skills', folder)
  await mkdir(skillRoot, { recursive: true })
  await writeFile(resolve(skillRoot, 'SKILL.md'), content, 'utf8')
}

function requiredSkill(catalog, name) {
  const skill = catalog.skills.find(candidate => candidate.name === name)
  if (!skill) throw new Error(`Skill fixture was not discovered: ${name}`)
  return skill
}

function completedTools(taskEvents) {
  return taskEvents.filter(event => event.event === 'tool.completed')
}

function agentRuns(taskEvents) {
  const starts = new Map(taskEvents.filter(event => event.event === 'agent.started').map(event => [event.agentRunId, event]))
  return taskEvents.filter(event => event.event === 'agent.completed' && starts.has(event.agentRunId)).map(event => ({
    agentRunId: event.agentRunId,
    agentName: event.agentName,
    startedAt: starts.get(event.agentRunId).at,
    completedAt: event.at,
    durationMs: event.at - starts.get(event.agentRunId).at,
    isError: event.isError
  }))
}

function hasOverlap(runs) {
  return runs.some((run, index) => runs.slice(index + 1).some(other => run.startedAt < other.completedAt && other.startedAt < run.completedAt))
}

function scoreParts(parts) {
  return parts.reduce((sum, [passed, weight]) => sum + (passed ? weight : 0), 0)
}

function deriveImprovementSignals(tasks) {
  const signals = []
  const explicit = tasks.find(task => task.id === 'skill-explicit-activation')
  const implicit = tasks.find(task => task.id === 'skill-implicit-discovery')
  const team = tasks.find(task => task.id === 'expert-team-delegation')
  const mcp = tasks.find(task => task.id === 'mcp-model-selection-and-approval')
  if (!explicit?.criteria.capabilityNarrowed) signals.push({ area: 'skill', priority: 'high', signal: 'Explicit Skill allowed-tools did not fully narrow executed tools.' })
  if (!implicit?.criteria.skillViewObserved || !implicit?.criteria.activationAudited) signals.push({ area: 'skill', priority: 'high', signal: 'The model did not reliably discover and audit implicit Skill activation.' })
  if (!team?.criteria.delegatedTwice) signals.push({ area: 'expert-team', priority: 'high', signal: 'The team prompt did not produce the required independent delegations.' })
  if (team?.criteria.delegatedTwice && !team?.criteria.actualOverlap) signals.push({ area: 'expert-team', priority: 'high', signal: 'Delegated agents ran serially even though the team requested a parallel batch.' })
  if (!mcp?.criteria.modelSelectedExpectedTool) signals.push({ area: 'mcp', priority: 'high', signal: 'The model did not select the enabled pinned MCP tool.' })
  if (!mcp?.criteria.approvalObserved) signals.push({ area: 'mcp', priority: 'high', signal: 'The MCP ask policy did not produce an approval event.' })
  if (!signals.length) signals.push({ area: 'regression', priority: 'medium', signal: 'All capability paths passed; add adversarial selection, denial, cancellation, and repeated-run variance tests next.' })
  return signals
}

function publicProfile(profile) {
  return { name: profile.name, model: profile.model, provider: profile.provider, wireProtocol: profile.wireProtocol, supportsTools: profile.supportsTools }
}

function sanitizeReply(value) { return String(value ?? '').trim().slice(0, 1000) }
function safeError(error) { return String(error instanceof Error ? error.message : error).replace(/(api[_ -]?key|authorization|bearer)\s*[:=]\s*\S+/ig, '$1=[REDACTED]').slice(0, 500) }
function hashFile(path) { return readFile(path).then(content => createHash('sha256').update(content).digest('hex')) }
function round(value) { return Math.round(value * 10) / 10 }
function relative(path) { return path.replace(root + '\\', '').replaceAll('\\', '/') }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }

async function artifactMetadata() {
  const info = await stat(backendArtifact)
  const assemblyPath = resolve(dirname(backendArtifact), 'RanParty.Backend.dll')
  const assembly = existsSync(assemblyPath)
    ? { fileName: basename(assemblyPath), bytes: (await stat(assemblyPath)).size, sha256: await hashFile(assemblyPath) }
    : null
  return { fileName: basename(backendArtifact), bytes: info.size, sha256: await hashFile(backendArtifact), assembly }
}

function runProcess(command, args, cwd) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolveRun({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` }))
    child.on('close', code => resolveRun({ exitCode: code ?? -1, stdout, stderr }))
  })
}

function gitCommit() {
  return runProcess('git', ['rev-parse', 'HEAD'], root).then(result => result.stdout.trim() || 'unknown')
}

function gitWorkingTreeDirty() {
  return runProcess('git', ['status', '--porcelain'], root).then(result => result.stdout.trim().length > 0)
}
