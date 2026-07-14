import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `plan-mode-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Plan test\n', 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requests.length === 1) {
      const call = {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-1', function: { name: 'update_plan', arguments: JSON.stringify({ explanation: '最短验收计划', plan: [{ step: '写入文件', status: 'pending' }, { step: '读取验证', status: 'pending' }] }) } }] }, finish_reason: 'tool_calls' }],
      }
      response.write(`data: ${JSON.stringify(call)}\n\n`)
    } else {
      response.write('data: {"choices":[{"delta":{"content":"请在计划卡片中确认。"},"finish_reason":"stop"}]}\n\n')
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
  const requestId = `plan-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'plan-model', model: 'plan-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, mode: 'plan' })
  await call('chat.send', { sessionId: session.id, text: 'Create a short plan.', imageDataUrls: [], skillIds: [] })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && !events.some(event => event.event === 'chat.completed' && event.data.sessionId === session.id)) await new Promise(done => setTimeout(done, 20))
  const planEvent = events.find(event => event.event === 'plan.updated' && event.data.sessionId === session.id)
  if (!planEvent) throw new Error('Plan mode did not emit plan.updated')
  const toolNames = requests[0].tools.map(tool => tool.function.name).sort()
  if (toolNames.join(',') !== 'ask_user,update_plan') throw new Error(`unexpected Plan tools: ${toolNames.join(',')}`)
  const systemText = requests[0].messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
  if (!systemText.includes('必须调用 update_plan')) throw new Error('Plan prompt does not require update_plan')
  if (planEvent.data.plan.length !== 2) throw new Error('Plan event lost steps')
  console.log(JSON.stringify({ passed: true, tools: toolNames, steps: planEvent.data.plan.length, requests: requests.length }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
