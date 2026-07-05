import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const sandbox = resolve('.tmp', `auto-context-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# 测试角色\n', 'utf8')
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const compacting = JSON.stringify(body).includes('请压缩以下会话')
    const text = compacting ? '目标：保留自动压缩测试。\n\n待办：继续会话。' : '测试回复'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage: { prompt_tokens: compacting ? 300 : 100, completion_tokens: compacting ? 30 : 20 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const backend = spawn('D:\\PARTY\\.dotnet-sdk\\dotnet.exe', [resolve('backend/bin/Debug/net8.0/RanParty.Backend.dll')], { cwd: sandbox, stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: backend.stdout })
const waiting = new Map(), eventWaiting = new Map()
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
  if (message.type === 'event') {
    const key = `${message.event}:${message.data?.sessionId ?? ''}`
    if (eventWaiting.has(key)) { eventWaiting.get(key)(message.data); eventWaiting.delete(key) }
  }
})
let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `auto-${++requestId}`, timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000)
  waiting.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})
const waitEvent = (event, sessionId) => new Promise((resolveEvent, reject) => {
  const key = `${event}:${sessionId}`, timer = setTimeout(() => reject(new Error(`timeout: ${key}`)), 10000)
  eventWaiting.set(key, data => { clearTimeout(timer); resolveEvent(data) })
})

try {
  const bootstrap = await call('app.bootstrap')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: bootstrap.settings.profiles[0].name, profile: { ...bootstrap.settings.profiles[0], name: 'auto-compact', baseUrl, apiKey: 'test', model: 'smoke', contextWindow: 32000 } })
  await call('settings.save', { compactThreshold: 1 })
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, profileName: 'auto-compact' })
  let completed = waitEvent('chat.completed', session.id)
  await call('chat.send', { sessionId: session.id, text: '第一条'.repeat(600), imageDataUrls: [], skillIds: [] })
  await completed
  const compacted = waitEvent('context.compacted', session.id)
  completed = waitEvent('chat.completed', session.id)
  await call('chat.send', { sessionId: session.id, text: '第二条', imageDataUrls: [], skillIds: [] })
  const event = await compacted
  await completed
  if (!event.automatic) throw new Error(`not automatic: ${JSON.stringify(event)}`)
  const current = (await call('app.bootstrap')).sessions.find(item => item.id === session.id)
  const notice = current.messages.find(message => message.event === 'context_compacted')
  if (!notice?.content?.includes('已自动总结') || !notice.content.includes('Token')) throw new Error(`visible notice missing: ${JSON.stringify(current.messages)}`)
  console.log(JSON.stringify({ passed: true, before: event.beforeTokens, after: event.contextTokens, notice: notice.content }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 2000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
