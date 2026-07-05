import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `tooling-model-switch-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test assistant\n', 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests.length === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-web-fetch', function: { name: 'web_fetch', arguments: '{"url":"http://127.0.0.1/private"}' } }] } }] })}\n\n`)
      response.end('data: [DONE]\n\n')
      return
    }
    response.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))

const dotnet = resolve(root, '.dotnet-sdk', 'dotnet.exe')
const backendDll = resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')
const backend = spawn(dotnet, [backendDll], {
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
  const id = `tooling-${++requestId}`
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
  if (!bootstrap.tools.includes('web_search') || !bootstrap.tools.includes('web_fetch') || !bootstrap.tools.includes('delegate_agent')) throw new Error('agent/web tools are not registered')

  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'profile-a', model: 'model-a', baseUrl, apiKey: 'test-key', provider: 'openai', wireProtocol: 'chat_completions', supportsTools: true } })
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'profile-b', model: 'model-b', baseUrl, apiKey: 'test-key', provider: 'openai', wireProtocol: 'chat_completions', supportsTools: true } })

  const session = await call('session.create', { workspace: sandbox })
  const modelEventPromise = waitEvent('message.added', session.id)
  await call('session.update', { sessionId: session.id, profileName: 'profile-b' })
  const modelEvent = await modelEventPromise
  if (modelEvent.message?.role !== 'event' || !modelEvent.message?.content?.includes('model-a') || !modelEvent.message?.content?.includes('model-b')) throw new Error('model switch event was not emitted')

  const toolEventPromise = waitEvent('tool.completed', session.id)
  const completedPromise = waitEvent('chat.completed', session.id)
  await call('chat.send', { sessionId: session.id, text: 'Use the web tool.', imageDataUrls: [], skillIds: [] })
  const toolEvent = await toolEventPromise
  await completedPromise
  if (!toolEvent.isError || !String(toolEvent.content).includes('blocked')) throw new Error(`private network fetch was not blocked: ${JSON.stringify(toolEvent)}`)

  const saved = (await call('app.bootstrap')).sessions.find((item) => item.id === session.id)
  if (!saved.messages.some((message) => message.role === 'event')) throw new Error('model switch event was not persisted')
  const firstRequest = requests[0]
  if (JSON.stringify(firstRequest.messages).includes('已切换模型')) throw new Error('model switch event leaked into model context')
  const toolNames = firstRequest.tools.map((tool) => tool.function?.name)
  if (!toolNames.includes('web_search') || !toolNames.includes('web_fetch') || !toolNames.includes('delegate_agent')) throw new Error('agent/web tool schemas were not sent to the model')

  console.log(JSON.stringify({ passed: true, tools: ['web_search', 'web_fetch'], modelEvent: modelEvent.message.content, privateNetworkBlocked: true, contextExcluded: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise((done) => setTimeout(done, 3000))])
  await new Promise((done) => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
