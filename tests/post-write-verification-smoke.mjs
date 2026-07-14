import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `verify-write-${Date.now()}`)
const target = resolve(sandbox, 'result.txt')
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
    if (requests.length === 1) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-1', function: { name: 'file_write', arguments: JSON.stringify({ path: target, content: 'verified content' }) } }] } }] })}\n\n`)
    } else if (requests.length === 2) {
      response.write('data: {"choices":[{"delta":{"content":"I changed the file."}}]}\n\n')
    } else if (requests.length === 3) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-1', function: { name: 'file_read', arguments: JSON.stringify({ path: target }) } }] } }] })}\n\n`)
    } else {
      response.write('data: {"choices":[{"delta":{"content":"The file was read back successfully."}}]}\n\n')
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
  const requestId = `verify-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitComplete = async sessionId => {
  const deadline = Date.now() + 20000
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
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'verify-model', model: 'verify-model', baseUrl, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, approvalMode: 'auto' })
  await call('chat.send', { sessionId: session.id, text: 'Write the requested file.', imageDataUrls: [], skillIds: [] })
  await waitComplete(session.id)
  if ((await readFile(target, 'utf8')) !== 'verified content') throw new Error('write tool did not produce expected file')
  if (requests.length !== 4) throw new Error(`expected write, premature final, verification read, final; got ${requests.length}`)
  if (!requests[2].messages.some(message => message.verification_gate === true)) throw new Error('verification gate prompt was not injected')
  if (!events.some(event => event.event === 'internal.notice' && String(event.data.content).includes('验证'))) throw new Error('verification continuation notice missing')
  if (events.some(event => event.event === 'chat.error')) throw new Error('verification gate surfaced chat.error')
  console.log(JSON.stringify({ passed: true, requests: requests.length, postWriteRead: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
