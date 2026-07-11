import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `subagent-${Date.now()}`)
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
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-agent', function: { name: 'delegate_agent', arguments: '{"profileName":"specialist","task":"审查实现风险"}' } }] } }] })}\n\n`)
    } else if (requests.length === 2) {
      response.write('data: {"choices":[{"delta":{"content":"专家结论：风险可控。"}}]}\n\n')
    } else {
      response.write('data: {"choices":[{"delta":{"content":"主 Agent 已整合专家结论。"}}]}\n\n')
    }
    response.end('data: [DONE]\n\n')
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const waiting = new Map()
const events = []
createInterface({ input: backend.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
  if (message.type === 'event') events.push(message)
})
let id = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const requestId = `agent-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000)
  waiting.set(requestId, (message) => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { const found = events.find(predicate); if (found) return found; await new Promise((done) => setTimeout(done, 20)) }
  throw new Error('event timeout')
}

try {
  const bootstrap = await call('app.bootstrap')
  if (!bootstrap.tools.includes('delegate_agent')) throw new Error('delegate_agent not registered')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'manager', model: 'manager-model', baseUrl, apiKey: 'test', supportsTools: true } })
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'specialist', model: 'specialist-model', baseUrl, apiKey: 'test', supportsTools: false } })
  const session = await call('session.create', { workspace: sandbox })
  await call('chat.send', { sessionId: session.id, text: '请委派审查', imageDataUrls: [], skillIds: [] })
  await waitFor((event) => event.event === 'chat.completed' && event.data.sessionId === session.id)

  const started = events.find((event) => event.event === 'agent.started')
  const completed = events.find((event) => event.event === 'agent.completed')
  const toolStarted = events.find((event) => event.event === 'tool.started' && event.data.name === 'delegate_agent')
  const toolCompleted = events.find((event) => event.event === 'tool.completed' && event.data.name === 'delegate_agent')
  if (started?.data.agentName !== 'specialist' || completed?.data.agentName !== 'specialist') throw new Error('agent lifecycle missing')
  if (!started.data.agentRunId || started.data.agentRunId !== completed.data.agentRunId || started.data.agentRunId !== toolStarted?.data.toolCallId) throw new Error('agent lifecycle was not correlated to its delegate tool call')
  if (started.data.turnId !== toolStarted.data.turnId) throw new Error('agent lifecycle was not bound to its parent turn')
  if (!toolCompleted?.data.content.includes('专家结论')) throw new Error('specialist output missing')
  if (!requests[0].tools.some((tool) => tool.function?.name === 'delegate_agent' && tool.function.parameters.properties.profileName.enum.includes('specialist'))) throw new Error('agent schema missing profiles')
  if (requests[1].model !== 'specialist-model' || requests[1].tools) throw new Error('specialist request was not isolated')
  if (!requests[2].messages.some((message) => message.role === 'tool' && String(message.content).includes('专家结论'))) throw new Error('manager did not receive specialist result')
  console.log(JSON.stringify({ passed: true, agent: started.data.agentName, model: started.data.model, managerIntegrated: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise((done) => setTimeout(done, 3000))])
  await new Promise((done) => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
