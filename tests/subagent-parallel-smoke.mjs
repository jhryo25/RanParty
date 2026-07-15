import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `subagent-parallel-${Date.now()}`)
const skillRoot = resolve(sandbox, '.agents', 'skills', 'parallel-team')
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await mkdir(resolve(sandbox, 'Config', 'Experts'), { recursive: true })
await mkdir(skillRoot, { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Parallel delegation test\n', 'utf8')
await writeFile(resolve(skillRoot, 'SKILL.md'), `---
name: parallel-team-fixture
description: Deterministic delegation concurrency fixture.
allowed-tools: [delegate_agent]
allow-implicit-invocation: false
---
Delegate the independent tasks in one tool-call batch.
`, 'utf8')

let activeAgents = 0
let currentPeak = 0
const completedPeaks = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const firstSystem = String(body.messages?.[0]?.content ?? '')
    const isSubAgent = firstSystem.includes('子 Agent')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (isSubAgent) {
      activeAgents++
      currentPeak = Math.max(currentPeak, activeAgents)
      const lastUser = String([...body.messages].reverse().find(message => message.role === 'user')?.content ?? '')
      const marker = lastUser.includes('ALPHA') ? 'ALPHA_OK' : 'BETA_OK'
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\n`)
        response.end('data: [DONE]\n\n')
        activeAgents--
      }, 250)
      return
    }
    const hasToolResults = body.messages.some(message => message.role === 'tool')
    if (!hasToolResults) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: `delegate-alpha-${completedPeaks.length}`, function: { name: 'delegate_agent', arguments: '{"profileName":"manager","task":"Return ALPHA_OK only"}' } },
        { index: 1, id: `delegate-beta-${completedPeaks.length}`, function: { name: 'delegate_agent', arguments: '{"profileName":"manager","task":"Return BETA_OK only"}' } }
      ] } }] })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    completedPeaks.push(currentPeak)
    currentPeak = 0
    response.write('data: {"choices":[{"delta":{"content":"ALPHA_OK BETA_OK"}}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget', 'packages') },
  stdio: ['pipe', 'pipe', 'inherit']
})
const waiting = new Map()
const events = []
createInterface({ input: backend.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
  if (message.type === 'event') events.push(message)
})
let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `parallel-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20_000)
  waiting.set(id, message => {
    clearTimeout(timer)
    message.error ? reject(new Error(String(message.error))) : resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

const waitComplete = async sessionId => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (events.some(event => event.event === 'chat.completed' && event.data.sessionId === sessionId)) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error(`chat completion timeout: ${sessionId}`)
}

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'manager', model: 'parallel-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', supportsTools: true } })
  const catalog = await call('skills.list', { workspace: sandbox })
  const skill = catalog.skills.find(candidate => candidate.name === 'parallel-team-fixture')
  if (!skill) throw new Error('parallel team Skill was not discovered')
  for (const maxParallel of [2, 1]) {
    const teamId = `parallel-team-${maxParallel}`
    await writeFile(resolve(sandbox, 'Config', 'Experts', `${teamId}.json`), JSON.stringify({
      schemaVersion: 1,
      kind: 'team',
      id: teamId,
      name: teamId,
      leaderSkillId: skill.id,
      memberSkillIds: [skill.id],
      collaboration: 'Delegate both independent tasks in one batch.',
      summaryRule: 'Return both results.',
      maxParallel
    }), 'utf8')
    const session = await call('session.create', { workspace: sandbox })
    await call('session.update', { sessionId: session.id, profileName: 'manager', model: 'parallel-model', approvalMode: 'auto' })
    await call('chat.send', { sessionId: session.id, text: 'Run both independent checks.', imageDataUrls: [], skillIds: [], expertIds: [], expertTeamId: teamId })
    await waitComplete(session.id)
  }
  if (completedPeaks[0] !== 2) throw new Error(`expected parallel peak 2, got ${completedPeaks[0]}`)
  if (completedPeaks[1] !== 1) throw new Error(`expected bounded peak 1, got ${completedPeaks[1]}`)
  const starts = events.filter(event => event.event === 'agent.started')
  const completions = events.filter(event => event.event === 'agent.completed')
  if (starts.length !== 4 || completions.length !== 4) throw new Error('agent lifecycle count mismatch')
  console.log(JSON.stringify({ passed: true, peaks: completedPeaks, agentRuns: starts.length, maxParallelEnforced: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
