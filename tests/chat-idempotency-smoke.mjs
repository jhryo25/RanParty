import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `chat-idempotency-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Idempotency test\n', 'utf8')

let modelRequests = 0
const server = http.createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    modelRequests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `reply-${modelRequests}` } }] })}\n\n`)
    setTimeout(() => response.end('data: [DONE]\n\n'), 100)
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')], {
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
let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `idempotency-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  waiting.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})
const waitComplete = async (sessionId, after = 0) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (events.filter(event => event.event === 'chat.completed' && event.data.sessionId === sessionId).length > after) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('chat completion timeout')
}

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  await call('profiles.save', {
    originalName: base.name,
    profile: { ...base, name: 'idempotency', model: 'idempotency-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', supportsTools: false },
  })

  const session = await call('session.create', { workspace: sandbox })
  const envelope = { clientMessageId: 'client-message-1', sessionId: session.id, text: 'once', imageDataUrls: [], skillIds: [], expertIds: [], referencedSessionIds: [] }
  const first = await call('chat.send', envelope)
  const duplicateWhileBusy = await call('chat.send', envelope)
  if (!duplicateWhileBusy.duplicate || duplicateWhileBusy.turnId !== first.turnId) throw new Error('busy duplicate was not deduplicated')
  await waitComplete(session.id)
  const duplicateAfterComplete = await call('chat.send', envelope)
  if (!duplicateAfterComplete.duplicate || duplicateAfterComplete.turnId !== first.turnId) throw new Error('completed duplicate was not deduplicated')

  const taskEnvelope = { clientMessageId: 'create-task-1', workspace: sandbox, profileName: 'idempotency', text: 'create once', imageDataUrls: [], skillIds: [], expertIds: [], referencedSessionIds: [] }
  const task = await call('session.create_and_send', taskEnvelope)
  await waitComplete(task.session.id)
  const duplicateTask = await call('session.create_and_send', taskEnvelope)
  if (duplicateTask.session.id !== task.session.id || !duplicateTask.chat.duplicate) throw new Error('create-and-send was not deduplicated')

  const restored = await call('app.bootstrap')
  const restoredSession = restored.sessions.find(candidate => candidate.id === session.id)
  const userMessages = restoredSession.messages.filter(message => message.role === 'user')
  if (userMessages.length !== 1) throw new Error(`duplicate user messages persisted: ${userMessages.length}`)
  if (modelRequests !== 2) throw new Error(`expected two model requests, received ${modelRequests}`)
  console.log(JSON.stringify({ passed: true, chatDeduplicated: true, createAndSendDeduplicated: true, modelRequests }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
