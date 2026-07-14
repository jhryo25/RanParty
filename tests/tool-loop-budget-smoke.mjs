import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `tool-budget-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test\n', 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (!body.tools) {
      response.write('data: {"choices":[{"delta":{"content":"Budget-limited final answer."}}]}\n\n')
    } else {
      const n = requests.length
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `vary-${n}`, function: { name: 'random_int', arguments: JSON.stringify({ min: 0, max: n + 1 }) } }] } }] })}\n\n`)
    }
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
  const requestId = `budget-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitComplete = async sessionId => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (events.some(event => event.event === 'chat.completed' && event.data.sessionId === sessionId)) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('chat completion timeout')
}

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'budget-model', model: 'budget-model', baseUrl, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox })
  await call('chat.send', { sessionId: session.id, text: 'Exercise the varied tool loop.', imageDataUrls: [], skillIds: [] })
  await waitComplete(session.id)
  if (events.some(event => event.event === 'chat.error')) throw new Error('budget guard surfaced chat.error')
  if (requests.length !== 49) throw new Error(`expected 48 tool rounds plus final synthesis, got ${requests.length}`)
  if (requests.at(-1).tools) throw new Error('budget final synthesis still exposed tools')
  const warnings = requests.flatMap(request => request.messages).filter(message => String(message.content).includes('TOOL LOOP BUDGET'))
  if (warnings.length !== 2) throw new Error(`expected caution and critical budget warnings, got ${warnings.length}`)
  console.log(JSON.stringify({ passed: true, toolRounds: 48, budgetWarnings: warnings.length, finalWithoutTools: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
