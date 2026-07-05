import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `web-search-live-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test assistant\n', 'utf8')

const requests = []
const modelServer = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests.length === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-web-search', function: { name: 'web_search', arguments: '{"query":"OpenAI Codex tools","count":3}' } }] } }] })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.write('data: {"choices":[{"delta":{"content":"Search completed"}}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((done) => modelServer.listen(0, '127.0.0.1', done))

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget', 'packages') },
  stdio: ['pipe', 'pipe', 'inherit'],
})
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
    const key = `${message.event}:${message.data?.sessionId ?? ''}`
    const resolver = eventWaiting.get(key)
    if (resolver) { eventWaiting.delete(key); resolver(message.data) }
  }
})

let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `web-live-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 30000)
  waiting.set(id, (message) => {
    clearTimeout(timer)
    if (message.error) reject(new Error(String(message.error)))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})
const waitEvent = (event, sessionId) => new Promise((resolveEvent, reject) => {
  const key = `${event}:${sessionId}`
  const timer = setTimeout(() => { eventWaiting.delete(key); reject(new Error(`timeout: ${key}`)) }, 30000)
  eventWaiting.set(key, (data) => { clearTimeout(timer); resolveEvent(data) })
})

try {
  const bootstrap = await call('app.bootstrap')
  const profile = bootstrap.settings.profiles[0]
  await call('profiles.save', {
    originalName: profile.name,
    profile: { ...profile, name: 'web-live', model: 'mock-model', baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, apiKey: 'test-key', provider: 'openai', wireProtocol: 'chat_completions', supportsTools: true },
  })
  const session = await call('session.create', { workspace: sandbox })
  const toolPromise = waitEvent('tool.completed', session.id)
  const completedPromise = waitEvent('chat.completed', session.id)
  await call('chat.send', { sessionId: session.id, text: 'Search the web.', imageDataUrls: [], skillIds: [] })
  const tool = await toolPromise
  await completedPromise
  if (tool.isError) throw new Error(`web_search failed: ${tool.content}`)
  const payload = JSON.parse(tool.content)
  if (!Array.isArray(payload.results) || payload.results.length === 0) throw new Error('web_search returned no results')
  if (!requests[1].messages.some((message) => message.role === 'tool' && message.content.includes('"results"') && message.content.includes('"provider"'))) throw new Error('tool result was not returned to the model')
  console.log(JSON.stringify({ passed: true, provider: payload.provider, resultCount: payload.results.length, firstResult: payload.results[0] }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise((done) => setTimeout(done, 3000))])
  await new Promise((done) => modelServer.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
