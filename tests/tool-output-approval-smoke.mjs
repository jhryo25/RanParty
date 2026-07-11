import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `tool-output-approval-${Date.now()}`)
const skillRoot = resolve(sandbox, 'RanParty', 'InstalledSkills', 'lookup-community')
const secretPath = resolve(sandbox, 'private-source.txt')
const secret = 'PRIVATE_LOOKUP_SEGMENT'
const skillDocument = `---
name: lookup-community
description: Exercise cached tool output access controls.
allowed-tools: [file_read, tool_output_lookup]
---
Read the requested local file and inspect a cached segment only when the user approves both data accesses.
`
const sha256 = value => createHash('sha256').update(value).digest('hex')
const skillContentHash = sha256(skillDocument)
const treeContentHash = sha256(Buffer.concat([Buffer.from('SKILL.md\n'), Buffer.from(skillDocument)]))

await mkdir(skillRoot, { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Tool artifact approval test\n', 'utf8')
await writeFile(resolve(skillRoot, 'SKILL.md'), skillDocument, 'utf8')
await writeFile(resolve(skillRoot, '.ranparty-market.json'), JSON.stringify({
  id: 'community:lookup-approval',
  trust: 'community',
  version: '1.0.0',
  skillContentHash,
  contentHash: treeContentHash,
}), 'utf8')
await writeFile(secretPath, `${'A'.repeat(12_000)}${secret.repeat(100)}${'Z'.repeat(12_000)}`, 'utf8')

let cacheId = ''
const requests = []
const lookupResults = []
const lastToolMessage = body => [...(body.messages ?? [])].reverse().find(message => message.role === 'tool')
const toolContent = message => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')
const toolCall = (id, name, args) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] })

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    const step = requests.length
    let delta
    if (step === 1) {
      delta = toolCall('read-source', 'file_read', { path: secretPath })
    } else if (step === 2) {
      const result = lastToolMessage(body)
      const content = toolContent(result)
      cacheId = result?.cache_id ?? /tool_output_lookup\(\"([^\"]+)\"/.exec(content)?.[1] ?? ''
      if (!cacheId) throw new Error(`file_read result did not expose a cache id: ${content.slice(0, 500)}`)
      if (content.includes(secret)) throw new Error('secret was present in the initially truncated tool result')
      delta = toolCall('lookup-current-turn', 'tool_output_lookup', { cache_id: cacheId, offset: 12_000, limit: 2_000 })
    } else if (step === 3) {
      lookupResults.push(toolContent(lastToolMessage(body)))
      delta = { content: 'Current-turn lookup handled.' }
    } else if (step === 4) {
      delta = toolCall('lookup-prior-turn', 'tool_output_lookup', { cache_id: cacheId, offset: 12_000, limit: 2_000 })
    } else if (step === 5) {
      lookupResults.push(toolContent(lastToolMessage(body)))
      delta = { content: 'Prior-turn lookup was scoped.' }
    } else if (step === 6) {
      delta = toolCall('lookup-other-session', 'tool_output_lookup', { cache_id: cacheId, offset: 12_000, limit: 2_000 })
    } else {
      lookupResults.push(toolContent(lastToolMessage(body)))
      delta = { content: 'Cross-session lookup was scoped.' }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
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
  const requestId = `tool-output-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20_000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitEvent = async predicate => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('event timeout')
}
const respond = approval => call('approval.respond', {
  approvalId: approval.data.approvalId,
  sessionId: approval.data.sessionId,
  turnId: approval.data.turnId,
  action: approval.action,
  feedback: approval.feedback ?? '',
})

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  await call('profiles.save', {
    originalName: base.name,
    profile: { ...base, name: 'tool-output', model: 'tool-output-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', supportsTools: true },
  })
  const catalog = await call('skills.list', { workspace: sandbox })
  const skill = catalog.skills.find(candidate => candidate.name === 'lookup-community')
  if (!skill || skill.trust !== 'community') throw new Error(`community lookup Skill missing: ${JSON.stringify(catalog)}`)

  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, approvalMode: 'auto' })
  const first = await call('chat.send', { clientMessageId: 'lookup-current', sessionId: session.id, text: 'Read and inspect the current result', imageDataUrls: [], skillIds: [skill.id], expertIds: [] })

  const sourceApproval = await waitEvent(event => event.event === 'approval.requested' && event.data.turnId === first.turnId)
  if (sourceApproval.data.tool !== 'file_read' || sourceApproval.data.risk !== 'data_access') throw new Error(`community source access was not a data approval: ${JSON.stringify(sourceApproval)}`)
  await respond({ ...sourceApproval, action: 'allow_once' })

  const lookupApproval = await waitEvent(event => event.event === 'approval.requested' && event.data.turnId === first.turnId && event.data.approvalId !== sourceApproval.data.approvalId)
  if (lookupApproval.data.tool !== 'file_read' || lookupApproval.data.risk !== 'data_access') throw new Error(`lookup did not inherit source-tool approval semantics: ${JSON.stringify(lookupApproval)}`)
  if (lookupApproval.data.arguments?.path !== secretPath) throw new Error(`lookup approval did not preserve source arguments: ${JSON.stringify(lookupApproval.data.arguments)}`)
  if (requests.length !== 2) throw new Error('cached data reached the model before lookup approval')
  await respond({ ...lookupApproval, action: 'reject', feedback: 'deny cached data' })
  await waitEvent(event => event.event === 'chat.completed' && event.data.turnId === first.turnId)

  const approvalsAfterCurrentTurn = events.filter(event => event.event === 'approval.requested').length
  const priorTurn = await call('chat.send', { clientMessageId: 'lookup-prior', sessionId: session.id, text: 'Try the prior turn cache', imageDataUrls: [], skillIds: [skill.id], expertIds: [] })
  await waitEvent(event => event.event === 'chat.completed' && event.data.turnId === priorTurn.turnId)
  if (events.filter(event => event.event === 'approval.requested').length !== approvalsAfterCurrentTurn) throw new Error('prior-turn artifact reached approval instead of being rejected by scope')

  const otherSession = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: otherSession.id, approvalMode: 'auto' })
  const crossSession = await call('chat.send', { clientMessageId: 'lookup-cross-session', sessionId: otherSession.id, text: 'Try another session cache', imageDataUrls: [], skillIds: [skill.id], expertIds: [] })
  await waitEvent(event => event.event === 'chat.completed' && event.data.turnId === crossSession.turnId)
  if (events.filter(event => event.event === 'approval.requested').length !== approvalsAfterCurrentTurn) throw new Error('cross-session artifact reached approval instead of being rejected by scope')

  if (lookupResults.length !== 3) throw new Error(`expected three lookup results, received ${lookupResults.length}`)
  if (lookupResults.some(content => content.includes(secret))) throw new Error('cached private data escaped approval or session/turn scope')
  console.log(JSON.stringify({ passed: true, sourceApproval: true, lookupApproval: true, turnScoped: true, sessionScoped: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
