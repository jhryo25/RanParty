import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `l0-budget-${Date.now()}`)
const ranparty = resolve(sandbox, 'RanParty')
const workspace = resolve(sandbox, 'workspace')
await mkdir(ranparty, { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(resolve(ranparty, 'SOUL.md'), `SOUL_SENTINEL\n${'S'.repeat(20_000)}`, 'utf8')
await writeFile(resolve(ranparty, 'AGENTS.md'), `AGENTS_SAFETY_SENTINEL\n${'A'.repeat(20_000)}`, 'utf8')
await writeFile(resolve(ranparty, 'TOOL_L0.md'), 'COMPACT_TOOL_GUIDE_SENTINEL\nUse one narrow verification after the final mutation.\n', 'utf8')
await writeFile(resolve(ranparty, 'TOOL.md'), 'FULL_TOOL_GUIDE_MUST_NOT_BE_IN_L0\n', 'utf8')
await writeFile(resolve(ranparty, 'HUB.md'), `HUB_SENTINEL\n${'H'.repeat(10_000)}`, 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
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
  const id = `l0-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15_000)
  waiting.set(id, message => {
    clearTimeout(timer)
    message.error ? reject(new Error(String(message.error))) : resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'l0-budget', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', supportsTools: false } })
  const session = await call('session.create', { workspace })
  await call('session.update', { sessionId: session.id, profileName: 'l0-budget', model: 'fixture', mode: 'ask' })
  await call('chat.send', { sessionId: session.id, text: 'reply', imageDataUrls: [], skillIds: [], expertIds: [] })
  const deadline = Date.now() + 15_000
  while (!events.some(event => event.event === 'chat.completed' && event.data.sessionId === session.id)) {
    if (Date.now() > deadline) throw new Error('chat completion timeout')
    await new Promise(done => setTimeout(done, 20))
  }
  const systemContents = requests[0].messages.filter(message => message.role === 'system').map(message => String(message.content))
  const stable = systemContents.find(content => content.includes('SOUL_SENTINEL')) ?? ''
  const bytes = Buffer.byteLength(stable, 'utf8')
  if (!stable.includes('AGENTS_SAFETY_SENTINEL') || !stable.includes('COMPACT_TOOL_GUIDE_SENTINEL') || !stable.includes('HUB_SENTINEL')) throw new Error('required L0 section missing')
  if (stable.includes('FULL_TOOL_GUIDE_MUST_NOT_BE_IN_L0')) throw new Error('full TOOL.md leaked into L0')
  if (bytes > 32 * 1024) throw new Error(`stable L0 exceeded 32 KiB: ${bytes}`)
  if ((stable.match(/Instruction section truncated/g) ?? []).length < 3) throw new Error('oversized instruction sections were not bounded')
  console.log(JSON.stringify({ passed: true, stableBytes: bytes, compactToolGuide: true, fullToolGuideDeferred: true, oversizedSectionsBounded: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
