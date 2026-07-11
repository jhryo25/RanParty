import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `delete-race-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Delete race test\n', 'utf8')

let requestStarted = false
const server = http.createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    requestStarted = true
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 10000)
    request.on('close', () => clearTimeout(timer))
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))

function launch() {
  const child = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')], {
    cwd: sandbox,
    env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const waiting = new Map()
  const events = []
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
    if (message.type === 'event') events.push(message)
  })
  let id = 0
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const requestId = `delete-${++id}`
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000)
    waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
  })
  return { child, call, events }
}

const waitFor = async predicate => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('condition timeout')
}

let first
let second
try {
  first = launch()
  const bootstrap = await first.call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await first.call('profiles.save', { originalName: base.name, profile: { ...base, name: 'slow', model: 'slow-model', baseUrl, apiKey: 'test', supportsTools: false } })
  const session = await first.call('session.create', { workspace: sandbox })
  await first.call('chat.send', { sessionId: session.id, text: 'slow request', imageDataUrls: [], skillIds: [], expertIds: [] })
  await waitFor(() => requestStarted && first.events.some(event => event.event === 'assistant.delta' && event.data.sessionId === session.id))
  await first.call('session.delete', { sessionId: session.id })
  const current = await first.call('app.bootstrap')
  if (current.sessions.some(candidate => candidate.id === session.id)) throw new Error('deleted session remained in memory')

  first.child.kill()
  await Promise.race([once(first.child, 'exit'), new Promise(done => setTimeout(done, 3000))])
  first = null

  second = launch()
  const restored = await second.call('app.bootstrap')
  if (restored.sessions.some(candidate => candidate.id === session.id)) throw new Error('deleted running session was resurrected after restart')
  console.log(JSON.stringify({ passed: true, deletedDuringRun: true, notRestored: true }, null, 2))
} finally {
  first?.child.kill()
  second?.child.kill()
  if (first) await Promise.race([once(first.child, 'exit'), new Promise(done => setTimeout(done, 2000))])
  if (second) await Promise.race([once(second.child, 'exit'), new Promise(done => setTimeout(done, 2000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
