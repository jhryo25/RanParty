import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `skill-implicit-${Date.now()}`)
const skillRoot = resolve(sandbox, '.agents', 'skills', 'restricted')
const markerPath = resolve(sandbox, 'implicit-bypass.txt')
await mkdir(skillRoot, { recursive: true })
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Implicit capability test\n', 'utf8')
await writeFile(resolve(skillRoot, 'SKILL.md'), `---\nname: restricted-workspace\ndescription: Use this workflow when the user says implicit restriction test.\nallowed-tools: [file_read]\n---\nRead the requested file and do not use write or shell tools.\n`, 'utf8')

let skillId = ''
const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const step = requests.length
    const command = `Set-Content -LiteralPath '${markerPath.replaceAll("'", "''")}' -Value 'bypass'`
    const delta = step === 1
      ? { tool_calls: [{ index: 0, id: 'load-skill', function: { name: 'skill_view', arguments: JSON.stringify({ id: skillId }) } }] }
      : step === 2
        ? { tool_calls: [{ index: 0, id: 'forbidden-shell', function: { name: 'ps_run', arguments: JSON.stringify({ command, workdir: sandbox }) } }] }
        : { content: 'Implicit capability denial observed.' }
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
  const requestId = `implicit-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitComplete = async sessionId => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (events.some(event => event.event === 'chat.completed' && event.data.sessionId === sessionId)) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('chat completion timeout')
}
const exists = async path => { try { await access(path, constants.F_OK); return true } catch { return false } }

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'implicit', model: 'implicit-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox })
  const catalog = await call('skills.list', { workspace: sandbox })
  const skill = catalog.skills.find(candidate => candidate.name === 'restricted-workspace')
  if (!skill || skill.invocationPolicy !== 'implicit') throw new Error('implicit workspace Skill missing')
  skillId = skill.id
  await call('chat.send', { clientMessageId: 'implicit-turn', sessionId: session.id, text: 'implicit restriction test', imageDataUrls: [], skillIds: [], expertIds: [] })
  await waitComplete(session.id)

  if (!requests[0].tools.some(tool => tool.function?.name === 'skill_view')) throw new Error('skill_view was not exposed initially')
  if (requests[1].tools.some(tool => tool.function?.name === 'ps_run')) throw new Error('implicit Skill did not narrow the next schema')
  if (!events.some(event => event.event === 'skill.activated' && event.data.id === skillId)) throw new Error('implicit activation was not audited')
  if (!events.some(event => event.event === 'tool.completed' && String(event.data.content).includes('capability policy'))) throw new Error('forbidden shell was not denied at dispatch')
  if (events.some(event => event.event === 'approval.requested')) throw new Error('forbidden shell reached approval')
  if (await exists(markerPath)) throw new Error('forbidden shell produced a side effect')
  console.log(JSON.stringify({ passed: true, activationAudited: true, schemaNarrowed: true, dispatchDenied: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
