import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd(); const sandbox = resolve('.tmp', `tool-loop-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true }); await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test\n', 'utf8')
const requests = []
const server = http.createServer((request, response) => { const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body); response.writeHead(200, { 'content-type': 'text/event-stream' }); if (!body.tools) response.write('data: {"choices":[{"delta":{"content":"已根据现有工具结果完成总结。"}}]}\n\n'); else response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `repeat-${requests.length}`, function: { name: 'web_fetch', arguments: '{"url":"http://127.0.0.1/repeat"}' } }] } }] })}\n\n`); response.end('data: [DONE]\n\n') }) })
await new Promise(done => server.listen(0, '127.0.0.1', done))
const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], { cwd: sandbox, env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') }, stdio: ['pipe', 'pipe', 'inherit'] })
const waiting = new Map(); const events = []; createInterface({ input: backend.stdout }).on('line', line => { const message = JSON.parse(line); if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) } if (message.type === 'event') events.push(message) })
let id = 0; const call = (method, params = {}) => new Promise((resolveCall, reject) => { const requestId = `loop-${++id}`; const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 15000); waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) }); backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`) })
const waitComplete = async sessionId => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (events.some(event => event.event === 'chat.completed' && event.data.sessionId === sessionId)) return; await new Promise(done => setTimeout(done, 20)) } throw new Error('chat completion timeout') }
try {
  const bootstrap = await call('app.bootstrap'); const base = bootstrap.settings.profiles[0]; const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'loop-model', model: 'loop-model', baseUrl, apiKey: 'test', supportsTools: true } })
  const session = await call('session.create', { workspace: sandbox }); await call('chat.send', { sessionId: session.id, text: '重复调用测试', imageDataUrls: [], skillIds: [] }); await waitComplete(session.id)
  const duplicate = events.filter(event => event.event === 'tool.completed').some(event => String(event.data.content).includes('重复工具调用已被拦截'))
  const errors = events.filter(event => event.event === 'chat.error')
  if (!duplicate) throw new Error('duplicate call was not blocked')
  if (errors.length) throw new Error(`tool loop surfaced chat.error: ${errors[0].data.message}`)
  if (requests.at(-1).tools) throw new Error('final synthesis still exposed tools')
  if (requests.length > 6) throw new Error(`loop used too many requests: ${requests.length}`)
  console.log(JSON.stringify({ passed: true, requests: requests.length, duplicateBlocked: true, finalWithoutTools: true }, null, 2))
} finally { backend.kill(); await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))]); await new Promise(done => server.close(done)); await rm(sandbox, { recursive: true, force: true }) }
