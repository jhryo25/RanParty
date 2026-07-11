import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `subagent-approval-${Date.now()}`)
const marker = resolve(sandbox, 'should-not-exist.txt')
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Approval test\n', 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const isSpecialist = body.model === 'specialist-model'
    const hasToolResult = body.messages?.some(message => message.role === 'tool')
    let delta
    if (!isSpecialist && !hasToolResult) {
      delta = { tool_calls: [{ index: 0, id: 'delegate-1', function: { name: 'delegate_agent', arguments: JSON.stringify({ profileName: 'specialist', task: '尝试写入标记文件', toolsMode: 'full', forkMode: 'fresh' }) } }] }
    } else if (isSpecialist && !hasToolResult) {
      const command = `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'approval bypass'`
      delta = { tool_calls: [{ index: 0, id: 'shell-1', function: { name: 'ps_run', arguments: JSON.stringify({ command, workdir: sandbox }) } }] }
    } else if (isSpecialist) {
      delta = { content: '审批被拒绝，未执行写入。' }
    } else {
      delta = { content: '主 Agent 已收到子 Agent 的拒绝结果。' }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const waiting = new Map()
const events = []
createInterface({ input: backend.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
  if (message.type === 'event') events.push(message)
})
let id = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const requestId = `approval-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitEvent = async predicate => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('event timeout')
}
const exists = async path => { try { await access(path, constants.F_OK); return true } catch { return false } }

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'manager', model: 'manager-model', baseUrl, apiKey: 'test', supportsTools: true } })
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'specialist', model: 'specialist-model', baseUrl, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, approvalMode: 'ask' })
  await call('chat.send', { sessionId: session.id, text: '委派子 Agent', imageDataUrls: [], skillIds: [], expertIds: [] })

  const approval = await waitEvent(event => event.event === 'approval.requested' && event.data.sessionId === session.id && event.data.tool === 'ps_run')
  if (await exists(marker)) throw new Error('subagent executed before approval')
  const waitingBootstrap = await call('app.bootstrap')
  if (!waitingBootstrap.pendingApprovals?.some(item => item.approvalId === approval.data.approvalId && item.turnId === approval.data.turnId)) {
    throw new Error('pending approval was not recoverable from bootstrap')
  }
  await call('approval.respond', {
    approvalId: approval.data.approvalId,
    sessionId: approval.data.sessionId,
    turnId: approval.data.turnId,
    action: 'reject',
    feedback: 'test rejection'
  })
  await waitEvent(event => event.event === 'chat.completed' && event.data.sessionId === session.id)
  if (await exists(marker)) throw new Error('rejected subagent command produced a side effect')
  if (!requests.some(body => body.model === 'specialist-model' && JSON.stringify(body.messages).includes('用户拒绝'))) throw new Error('specialist did not receive rejection result')
  console.log(JSON.stringify({ passed: true, approvalObserved: true, sideEffectBlocked: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
