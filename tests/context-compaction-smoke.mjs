import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `context-smoke-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# 测试角色\n\n你是测试角色。\n', 'utf8')

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const compacting = JSON.stringify(body).includes('请压缩以下会话')
    const text = compacting ? '目标：保留测试上下文。\n\n待办：继续测试。' : '测试回复'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage: { prompt_tokens: compacting ? 300 : 100, completion_tokens: compacting ? 30 : 20 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))

const dotnet = 'D:\\PARTY\\.dotnet-sdk\\dotnet.exe'
const backendDll = resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')
const backend = spawn(dotnet, [backendDll], { cwd: sandbox, stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: backend.stdout })
const waiting = new Map()
const eventWaiting = new Map()
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
  if (message.type === 'event') {
    if (message.event === 'chat.error') console.error('backend chat.error:', message.data?.message)
    const key = `${message.event}:${message.data?.sessionId ?? ''}`
    const resolveEvent = eventWaiting.get(key)
    if (resolveEvent) { eventWaiting.delete(key); resolveEvent(message.data) }
  }
})

let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `context-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000)
  waiting.set(id, (message) => {
    clearTimeout(timer)
    if (message.error) reject(new Error(String(message.error)))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})
const waitEvent = (event, sessionId) => new Promise((resolveEvent, reject) => {
  const key = `${event}:${sessionId}`
  const timer = setTimeout(() => { eventWaiting.delete(key); reject(new Error(`timeout: ${key}`)) }, 10000)
  eventWaiting.set(key, (data) => { clearTimeout(timer); resolveEvent(data) })
})

try {
  const bootstrap = await call('app.bootstrap')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: bootstrap.settings.profiles[0].name, profile: { ...bootstrap.settings.profiles[0], name: 'compact-smoke', baseUrl, apiKey: 'test-key', model: 'smoke-model', provider: 'openai', wireProtocol: 'chat_completions', contextWindow: 32000 } })
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, profileName: 'compact-smoke' })
  for (const text of ['第一条测试消息'.repeat(300), '第二条测试消息'.repeat(300)]) {
    const completed = waitEvent('chat.completed', session.id)
    await call('chat.send', { sessionId: session.id, text, imageDataUrls: [], skillIds: [] })
    await completed
  }
  const before = (await call('app.bootstrap')).sessions.find((item) => item.id === session.id)
  const compacted = await call('session.compact', { sessionId: session.id, profileName: 'compact-smoke' })
  if (before.displayName !== '测试角色') throw new Error(`unexpected role name: ${before.displayName}`)
  if (!(before.contextTokens > compacted.contextTokens)) throw new Error(`context did not shrink: ${before.contextTokens} -> ${compacted.contextTokens}`)
  if (compacted.messages.length !== 5) throw new Error(`visible transcript was not preserved: ${compacted.messages.length}`)
  console.log(JSON.stringify({ passed: true, displayName: before.displayName, before: before.contextTokens, after: compacted.contextTokens, visibleMessages: compacted.messages.length }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise((done) => setTimeout(done, 3000))])
  await new Promise((done) => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
