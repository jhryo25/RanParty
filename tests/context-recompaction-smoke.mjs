import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `context-recompact-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Recompaction test\n', 'utf8')

const compactBodies = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const serialized = JSON.stringify(body)
    const compacting = serialized.includes('请压缩以下会话')
    let content = '普通回复'
    if (compacting) {
      compactBodies.push(body)
      content = compactBodies.length === 1
        ? '目标：FIRST_SUMMARY_SENTINEL 必须跨多次压缩保留。'
        : '目标：SECOND_SUMMARY_PRESERVED；此前目标仍为 FIRST_SUMMARY_SENTINEL。'
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }], usage: { prompt_tokens: 200, completion_tokens: 30 } })}\n\n`)
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
  const requestId = `recompact-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})
const waitCompleted = async sessionId => {
  const previous = events.filter(event => event.event === 'chat.completed' && event.data.sessionId === sessionId).length
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (events.filter(event => event.event === 'chat.completed' && event.data.sessionId === sessionId).length > previous) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error('chat completion timeout')
}

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await call('profiles.save', { originalName: base.name, profile: { ...base, name: 'recompact', model: 'recompact-model', baseUrl, apiKey: 'test', supportsTools: false, contextWindow: 32000 } })
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, profileName: 'recompact' })

  let completed = waitCompleted(session.id)
  await call('chat.send', { sessionId: session.id, text: '最早目标 FIRST_USER_SENTINEL\n' + '需要在第一次总结中保留的历史上下文。'.repeat(500), imageDataUrls: [], skillIds: [], expertIds: [] })
  await completed
  await call('session.compact', { sessionId: session.id, profileName: 'recompact' })

  completed = waitCompleted(session.id)
  await call('chat.send', { sessionId: session.id, text: '压缩后新增上下文\n' + '这是需要保留的新增事实和细节。'.repeat(500), imageDataUrls: [], skillIds: [], expertIds: [] })
  await completed
  await call('session.compact', { sessionId: session.id, profileName: 'recompact' })

  if (compactBodies.length !== 2) throw new Error(`expected two compactions, got ${compactBodies.length}`)
  if (!JSON.stringify(compactBodies[1]).includes('FIRST_SUMMARY_SENTINEL')) throw new Error('second compaction omitted previous summary')
  let noBenefitRejected = false
  try { await call('session.compact', { sessionId: session.id, profileName: 'recompact' }) }
  catch (error) { noBenefitRejected = /内容太少|新增上下文/.test(String(error)) }
  if (!noBenefitRejected) throw new Error('no-benefit recompaction was not rejected before another model call')
  if (compactBodies.length !== 2) throw new Error('no-benefit recompaction still called the model')
  console.log(JSON.stringify({ passed: true, compactions: compactBodies.length, previousSummaryPreserved: true, noBenefitRejected }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
