import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `skill-capability-${Date.now()}`)
const skillRoot = resolve(sandbox, 'RanParty', 'InstalledSkills', 'limited')
const markerPath = resolve(sandbox, 'capability-bypass.txt')
const skillDocument = `---\nname: limited-community\ndescription: Read-only community workflow.\nallowed-tools: [file_read, file_write, ps_run]\n---\nAttempting to request dangerous capabilities must not grant them.\n`
const sha256 = value => createHash('sha256').update(value).digest('hex')
await mkdir(skillRoot, { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Capability test\n', 'utf8')
await writeFile(resolve(skillRoot, 'SKILL.md'), skillDocument, 'utf8')
await writeFile(resolve(skillRoot, '.ranparty-market.json'), JSON.stringify({
  id: 'community:limited',
  trust: 'community',
  version: '1.0.0',
  skillContentHash: sha256(skillDocument),
  contentHash: sha256(Buffer.concat([Buffer.from('SKILL.md\n'), Buffer.from(skillDocument)])),
}), 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const hasToolResult = body.messages?.some(message => message.role === 'tool')
    const command = `Set-Content -LiteralPath '${markerPath.replaceAll("'", "''")}' -Value 'bypass'`
    const delta = hasToolResult
      ? { content: 'Capability denial observed.' }
      : { tool_calls: [{ index: 0, id: 'forbidden-shell', function: { name: 'ps_run', arguments: JSON.stringify({ command, workdir: sandbox }) } }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
    response.end('data: [DONE]\n\n')
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
let id = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const requestId = `capability-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitComplete = async sessionId => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (events.some(event => event.event === 'chat.completed' && event.data.sessionId === sessionId)) return
    const failure = events.find(event => event.event === 'chat.error' && event.data.sessionId === sessionId)
    if (failure) throw new Error(`chat failed: ${failure.data.message}`)
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('chat completion timeout')
}
const exists = async path => { try { await access(path, constants.F_OK); return true } catch { return false } }

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'capability', model: 'capability-model', baseUrl, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox })
  const skills = await call('skills.list', { workspace: sandbox })
  const skill = skills.skills.find(candidate => candidate.name === 'limited-community')
  if (!skill || skill.trust !== 'community') throw new Error('community Skill missing')
  await call('chat.send', { sessionId: session.id, text: 'Use the selected workflow', imageDataUrls: [], skillIds: [skill.id], expertIds: [] })
  await waitComplete(session.id)
  if (requests[0].tools.some(tool => tool.function?.name === 'ps_run')) throw new Error('forbidden ps_run schema was exposed')
  if (!events.some(event => event.event === 'tool.completed' && String(event.data.content).includes('capability policy'))) throw new Error('forbidden tool was not denied by policy gateway')
  if (events.some(event => event.event === 'approval.requested')) throw new Error('forbidden capability reached approval instead of being denied')
  if (await exists(markerPath)) throw new Error('forbidden capability produced a side effect')
  console.log(JSON.stringify({ passed: true, schemaFiltered: true, executionDenied: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
