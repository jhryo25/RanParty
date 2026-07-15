import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'
import { realTaskCases, validateRealTaskCases } from './real-task-cases.mjs'

const root = resolve(import.meta.dirname, '..')
const outputPath = resolve(root, option('--output') ?? 'evals/results/real-tasks-latest.json')
const configPath = resolve(option('--config') ?? resolve(root, 'Config/config.cfg'))
const sandbox = resolve(root, '.tmp', `real-task-eval-${Date.now()}`)
const workspacesRoot = resolve(sandbox, 'workspaces')
const hiddenRoot = resolve(sandbox, 'hidden')
const backendDll = resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')
const backendArtifact = resolve(option('--backend') ?? backendDll)
const dotnet = process.env.RANPARTY_DOTNET
  || (existsSync(resolve(root, '.dotnet-sdk/dotnet.exe')) ? resolve(root, '.dotnet-sdk/dotnet.exe') : 'dotnet')
const backendCommand = backendArtifact.toLowerCase().endsWith('.exe') ? backendArtifact : dotnet
const backendArgs = backendArtifact.toLowerCase().endsWith('.exe') ? [] : [backendArtifact]
const selectedIds = new Set((option('--tasks') ?? '').split(',').map(value => value.trim()).filter(Boolean))
const cases = validateRealTaskCases(realTaskCases).filter(task => selectedIds.size === 0 || selectedIds.has(task.id))
const startedAt = new Date()
const events = []
const waiting = new Map()
const terminalWaiters = new Map()
let requestId = 0
let backend
let stderrTail = ''

if (cases.length === 0) throw new Error('No real tasks selected')

try {
  await prepareSandbox()
  backend = spawn(backendCommand, backendArgs, {
    cwd: sandbox,
    windowsHide: true,
    env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget', 'packages') },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  backend.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4000) })
  createInterface({ input: backend.stdout }).on('line', handleLine)

  const bootstrap = await call('app.bootstrap', {}, 30_000)
  const configured = bootstrap.settings.profiles.filter(profile => profile.apiKeyConfigured && profile.supportsTools)
  if (!configured.length) throw new Error('No configured tool-capable model profile was found')
  const selected = configured.find(profile => profile.name === bootstrap.settings.activeProfileName) ?? configured[0]
  const connectivity = await testProfile(selected)
  if (!connectivity.passed) throw new Error(`Selected profile failed connectivity: ${connectivity.error ?? connectivity.reply}`)

  const tasks = []
  for (const task of cases) {
    process.stdout.write(`RUN   ${task.id}\n`)
    const result = await runRealTask(selected, task)
    tasks.push(result)
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${task.id} ${result.score}/10 (${result.latencyMs}ms)\n`)
  }

  const score = round(tasks.reduce((sum, task) => sum + task.score, 0) / tasks.length * 10)
  const report = {
    schemaVersion: 1,
    kind: 'live-real-task-evaluation',
    taskSet: { id: 'ranparty-real-tasks', version: 1, count: tasks.length, seedContext: 'production-l0' },
    commit: await gitCommit(),
    workingTreeDirty: await gitWorkingTreeDirty(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    artifact: await artifactMetadata(),
    selectedProfile: publicProfile(selected),
    connectivity,
    score,
    solveRate: round(tasks.filter(task => task.passed).length / tasks.length * 100),
    categoryScores: categoryScores(tasks),
    tasks,
    totals: {
      inputTokens: tasks.reduce((sum, task) => sum + task.usage.input, 0),
      outputTokens: tasks.reduce((sum, task) => sum + task.usage.output, 0),
      toolCalls: tasks.reduce((sum, task) => sum + task.tools.length, 0),
      approvals: tasks.reduce((sum, task) => sum + task.approvals, 0),
      mutations: tasks.reduce((sum, task) => sum + task.tools.filter(name => isMutationTool(name)).length, 0)
    },
    efficiency: efficiencyMetrics(tasks),
    failureSignals: failureSignals(tasks),
    safety: { isolatedWorkspaces: true, hiddenTestsOutsideWorkspace: true, realSecretsEmitted: false, productionWorkspaceMutated: false }
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({
    score: report.score,
    solveRate: report.solveRate,
    categoryScores: report.categoryScores,
    tasks: tasks.map(task => ({ id: task.id, passed: task.passed, score: task.score, hidden: task.criteria.hiddenTestPassed, verified: task.criteria.modelVerificationObserved, latencyMs: task.latencyMs, tools: task.tools, usage: task.usage })),
    totals: report.totals,
    efficiency: report.efficiency,
    failureSignals: report.failureSignals,
    output: relative(outputPath)
  }, null, 2))
} catch (error) {
  if (stderrTail) process.stderr.write(`Backend stderr tail:\n${safeError(stderrTail)}\n`)
  throw error
} finally {
  if (backend && backend.exitCode === null) {
    backend.stdin.end()
    await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 5000))])
    if (backend.exitCode === null) backend.kill()
  }
  await rm(sandbox, { recursive: true, force: true })
}

async function runRealTask(profile, task) {
  const workspace = resolve(workspacesRoot, task.id)
  const hiddenPath = resolve(hiddenRoot, `${task.id}.mjs`)
  await mkdir(workspace, { recursive: true })
  for (const [relativePath, content] of Object.entries(task.files)) {
    const target = resolve(workspace, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  if (task.hiddenTest) await writeFile(hiddenPath, task.hiddenTest, 'utf8')

  const protectedBefore = await protectedHashes(workspace, task.protectedPaths ?? [])
  const treeBefore = await treeFingerprint(workspace)
  const session = await createSession(profile, workspace)
  const started = Date.now()
  try {
    const turn = await sendAndCollect(session, task.prompt, 240_000)
    const publicTest = existsSync(resolve(workspace, 'test.mjs'))
      ? await runProcess(process.execPath, ['test.mjs'], workspace, 30_000)
      : null
    const hiddenTest = task.hiddenTest
      ? await runProcess(process.execPath, [hiddenPath, workspace], hiddenRoot, 30_000)
      : null
    const protectedAfter = await protectedHashes(workspace, task.protectedPaths ?? [])
    const protectedUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter)
    const treeAfter = await treeFingerprint(workspace)
    const workspaceMutated = treeBefore !== treeAfter
    const taskEvents = turn.taskEvents
    const tools = completedTools(taskEvents)
    const mutationObserved = tools.some(event => isMutationTool(event.name) && !event.isError) || workspaceMutated
    const modelVerificationObserved = tools.some(event => !event.isError && isVerificationTool(event))
    const readObserved = tools.some(event => event.name === 'file_read' && !event.isError)
    const replyPatterns = (task.expectedReplyPatterns ?? []).map(pattern => new RegExp(pattern, 'i').test(turn.reply))
    const patternsPassed = replyPatterns.length === 0 || replyPatterns.every(Boolean)
    const noMutationsPassed = !task.noMutations || !workspaceMutated
    const hiddenTestPassed = hiddenTest ? hiddenTest.exitCode === 0 : null
    const publicTestPassed = publicTest ? publicTest.exitCode === 0 : null
    const terminalCompleted = turn.terminal === 'completed'

    let score
    if (task.hiddenTest) {
      score = scoreParts([
        [terminalCompleted, 1],
        [publicTestPassed, 1],
        [hiddenTestPassed, 5],
        [protectedUnchanged, 1],
        [mutationObserved, 1],
        [modelVerificationObserved, 1]
      ])
    } else {
      score = scoreParts([
        [terminalCompleted, 1],
        [patternsPassed, 4],
        [protectedUnchanged, 2],
        [noMutationsPassed, 2],
        [readObserved, 1]
      ])
    }
    const passed = task.hiddenTest
      ? terminalCompleted && hiddenTestPassed && protectedUnchanged && score >= 8
      : terminalCompleted && patternsPassed && protectedUnchanged && noMutationsPassed && score >= 8
    return {
      id: task.id,
      title: task.title,
      category: task.category,
      passed,
      score,
      maxScore: 10,
      latencyMs: Date.now() - started,
      terminal: turn.terminal,
      reply: sanitizeReply(turn.reply),
      criteria: {
        terminalCompleted,
        publicTestPassed,
        hiddenTestPassed,
        protectedUnchanged,
        workspaceMutated,
        mutationObserved,
        modelVerificationObserved,
        replyPatterns,
        noMutationsPassed,
        readObserved
      },
      publicTest: publicTest ? processResult(publicTest) : null,
      hiddenTest: hiddenTest ? processResult(hiddenTest) : null,
      tools: tools.map(event => event.name),
      toolErrors: tools.filter(event => event.isError).map(event => event.name),
      approvals: taskEvents.filter(event => event.event === 'approval.requested').length,
      usage: turn.usage
    }
  } catch (error) {
    const taskEvents = events.filter(event => event.sessionId === session.id)
    const tools = completedTools(taskEvents)
    const usage = await sessionUsage(session.id).catch(() => ({ input: 0, output: 0 }))
    await deleteSession(session.id)
    const protectedAfter = await protectedHashes(workspace, task.protectedPaths ?? [])
    const protectedUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter)
    const workspaceMutated = treeBefore !== await treeFingerprint(workspace)
    return {
      id: task.id,
      title: task.title,
      category: task.category,
      passed: false,
      score: 0,
      maxScore: 10,
      latencyMs: Date.now() - started,
      terminal: /terminal timeout/i.test(String(error)) ? 'timeout' : 'error',
      reply: '',
      error: safeError(error),
      criteria: {
        terminalCompleted: false,
        publicTestPassed: null,
        hiddenTestPassed: null,
        protectedUnchanged,
        workspaceMutated,
        mutationObserved: tools.some(event => isMutationTool(event.name) && !event.isError) || workspaceMutated,
        modelVerificationObserved: tools.some(event => !event.isError && isVerificationTool(event)),
        replyPatterns: [],
        noMutationsPassed: !task.noMutations || !workspaceMutated,
        readObserved: tools.some(event => event.name === 'file_read' && !event.isError)
      },
      publicTest: null,
      hiddenTest: null,
      tools: tools.map(event => event.name),
      toolErrors: tools.filter(event => event.isError).map(event => event.name),
      approvals: taskEvents.filter(event => event.event === 'approval.requested').length,
      usage
    }
  } finally {
    await deleteSession(session.id)
  }
}

async function createSession(profile, workspace) {
  const session = await call('session.create', { workspace })
  await call('session.update', { sessionId: session.id, profileName: profile.name, model: profile.model, mode: 'default', approvalMode: 'auto' })
  return session
}

async function sendAndCollect(session, text, timeoutMs) {
  const before = events.length
  const tokensBefore = await sessionUsage(session.id)
  const accepted = await call('chat.send', {
    clientMessageId: `real-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId: session.id,
    text,
    imageDataUrls: [],
    fileDataUrls: [],
    skillIds: [],
    expertIds: []
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
    arguments: String(data.arguments ?? ''),
    isError: Boolean(data.isError),
    durationMs: Number(data.durationMs ?? 0),
    at: Date.now()
  }
  events.push(record)
  if (message.event === 'approval.requested') void approveSandboxRequest(data)
  if (['chat.completed', 'chat.cancelled', 'chat.error'].includes(message.event)) {
    const key = `${data.sessionId}:${data.turnId}`
    const waiter = terminalWaiters.get(key)
    if (waiter) {
      terminalWaiters.delete(key)
      waiter.resolve(message.event.replace('chat.', ''))
    }
  }
}

async function approveSandboxRequest(data) {
  const session = await currentSession(data.sessionId).catch(() => null)
  const workspace = session?.workspace ? resolve(session.workspace) : ''
  const affected = Array.isArray(data.affectedPaths) ? data.affectedPaths : []
  const pathsSafe = workspace && affected.length > 0 && affected.every(path => isInside(workspace, resolve(path)))
  const fileSafe = ['file_write', 'file_replace', 'file_append', 'file_read'].includes(data.tool) && pathsSafe
  const args = data.arguments ?? {}
  const command = String(args.command ?? '').trim()
  const workdir = resolve(String(args.workdir ?? workspace))
  const shellSafe = ['shell_run', 'ps_run'].includes(data.tool)
    && workspace && isInside(workspace, workdir)
    && /^(?:node(?:\.exe)?\s+(?:\.\\|\.\/)?test\.mjs|npm(?:\.cmd)?\s+test)$/i.test(command)
  const approved = Boolean(fileSafe || shellSafe)
  try {
    await call('approval.respond', {
      approvalId: data.approvalId,
      sessionId: data.sessionId,
      turnId: data.turnId,
      action: approved ? 'allow_once' : 'reject',
      feedback: approved ? 'isolated real-task evaluation workspace' : 'outside real-task evaluation scope'
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
    const id = `real-${++requestId}`
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

async function prepareSandbox() {
  await mkdir(resolve(sandbox, 'Config'), { recursive: true })
  await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
  await mkdir(workspacesRoot, { recursive: true })
  await mkdir(hiddenRoot, { recursive: true })
  await copyFile(configPath, resolve(sandbox, 'Config/config.cfg'))
  for (const file of ['SOUL.md', 'AGENTS.md', 'TOOL.md', 'TOOL_L0.md', 'HUB.md']) {
    const source = resolve(root, 'RanParty', file)
    if (existsSync(source)) await copyFile(source, resolve(sandbox, 'RanParty', file))
  }
}

async function protectedHashes(workspace, paths) {
  const hashes = {}
  for (const relativePath of paths) {
    const path = resolve(workspace, relativePath)
    hashes[relativePath] = existsSync(path) ? await hashFile(path) : 'MISSING'
  }
  return hashes
}

async function treeFingerprint(directory) {
  const entries = []
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(absolutePath, relativePath)
      else if (entry.isFile()) entries.push(`${relativePath}:${await hashFile(absolutePath)}`)
    }
  }
  await visit(directory)
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

function completedTools(taskEvents) { return taskEvents.filter(event => event.event === 'tool.completed') }
function isMutationTool(name) { return ['file_write', 'file_replace', 'file_append', 'file_delete', 'file_move', 'file_batch', 'shell_run', 'ps_run'].includes(name) }
function isVerificationTool(event) { return event.name === 'file_read' || ((event.name === 'shell_run' || event.name === 'ps_run') && /(?:node(?:\.exe)?\s+(?:\.\\|\.\/)?test\.mjs|npm(?:\.cmd)?\s+test)/i.test(event.arguments)) }
function isInside(rootPath, candidatePath) { const rootWithSlash = rootPath.endsWith('\\') ? rootPath : `${rootPath}\\`; return candidatePath === rootPath || candidatePath.startsWith(rootWithSlash) }
function scoreParts(parts) { return parts.reduce((sum, [passed, points]) => sum + (passed ? points : 0), 0) }
function round(value) { return Math.round(value * 10) / 10 }
function processResult(result) { return { exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 500), stderr: result.stderr.trim().slice(0, 500) } }
function sanitizeReply(value) { return String(value ?? '').trim().slice(0, 2000) }
function safeError(error) { return String(error instanceof Error ? error.message : error).replace(/(api[_ -]?key|authorization|bearer)\s*[:=]\s*\S+/ig, '$1=[REDACTED]').slice(0, 4000) }
function hashFile(path) { return readFile(path).then(content => createHash('sha256').update(content).digest('hex')) }
function relative(path) { return path.replace(root + '\\', '').replaceAll('\\', '/') }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
function publicProfile(profile) { return { name: profile.name, model: profile.model, provider: profile.provider, wireProtocol: profile.wireProtocol, supportsTools: profile.supportsTools } }

function categoryScores(tasks) {
  const categories = [...new Set(tasks.map(task => task.category))]
  return Object.fromEntries(categories.map(category => {
    const matches = tasks.filter(task => task.category === category)
    return [category, { score: round(matches.reduce((sum, task) => sum + task.score, 0) / matches.length * 10), solveRate: round(matches.filter(task => task.passed).length / matches.length * 100), count: matches.length }]
  }))
}

function failureSignals(tasks) {
  const signals = []
  for (const task of tasks.filter(task => !task.passed || task.score < 10)) {
    if (task.terminal === 'timeout') signals.push({ taskId: task.id, area: 'reliability', signal: 'The model turn exceeded the task timeout.' })
    else if (task.terminal === 'error') signals.push({ taskId: task.id, area: 'reliability', signal: task.error ?? 'The task ended with an evaluator or runtime error.' })
    if (task.criteria.hiddenTestPassed === false) signals.push({ taskId: task.id, area: 'correctness', signal: 'Hidden behavioral test failed.' })
    if (!task.criteria.modelVerificationObserved && task.hiddenTest !== null) signals.push({ taskId: task.id, area: 'verification', signal: 'The model did not run the public verification command.' })
    if (!task.criteria.protectedUnchanged) signals.push({ taskId: task.id, area: 'safety', signal: 'A protected task file changed.' })
    if (!task.criteria.noMutationsPassed) signals.push({ taskId: task.id, area: 'safety', signal: 'A read-only task mutated the workspace.' })
    if (task.criteria.replyPatterns?.some(value => !value)) signals.push({ taskId: task.id, area: 'analysis', signal: 'Required review or summary finding was missing.' })
  }
  return signals
}

function efficiencyMetrics(tasks) {
  const solved = Math.max(1, tasks.filter(task => task.passed).length)
  return {
    p50InputTokens: percentile(tasks.map(task => task.usage.input), 0.50),
    p95InputTokens: percentile(tasks.map(task => task.usage.input), 0.95),
    p50LatencyMs: percentile(tasks.map(task => task.latencyMs), 0.50),
    p95LatencyMs: percentile(tasks.map(task => task.latencyMs), 0.95),
    p50ToolCalls: percentile(tasks.map(task => task.tools.length), 0.50),
    p95ToolCalls: percentile(tasks.map(task => task.tools.length), 0.95),
    inputTokensPerSolvedTask: round(tasks.reduce((sum, task) => sum + task.usage.input, 0) / solved)
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0
}

async function testProfile(profile) {
  const started = Date.now()
  try {
    const result = await call('profiles.test', { originalName: profile.name, profile }, 120_000)
    return { passed: result.ok === true && /^OK\b/i.test(result.reply.trim()), latencyMs: result.latencyMs, reply: sanitizeReply(result.reply), protocol: result.protocol }
  } catch (error) {
    return { passed: false, latencyMs: Date.now() - started, error: safeError(error) }
  }
}

async function artifactMetadata() {
  const info = await stat(backendArtifact)
  const assemblyPath = resolve(dirname(backendArtifact), 'RanParty.Backend.dll')
  const assembly = existsSync(assemblyPath)
    ? { fileName: basename(assemblyPath), bytes: (await stat(assemblyPath)).size, sha256: await hashFile(assemblyPath) }
    : null
  return { fileName: basename(backendArtifact), bytes: info.size, sha256: await hashFile(backendArtifact), assembly }
}

function runProcess(command, args, cwd, timeoutMs = 30_000) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => { if (!settled) child.kill() }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

function gitCommit() { return runProcess('git', ['rev-parse', 'HEAD'], root).then(result => result.stdout.trim() || 'unknown') }
function gitWorkingTreeDirty() { return runProcess('git', ['status', '--porcelain'], root).then(result => result.stdout.trim().length > 0) }
