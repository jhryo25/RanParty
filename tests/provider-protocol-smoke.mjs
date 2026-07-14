import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `provider-protocol-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await copyFile(resolve(root, 'RanParty', 'SOUL.md'), resolve(sandbox, 'RanParty', 'SOUL.md'))

const received = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    received.push({ url: request.url, headers: request.headers, body })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (request.url === '/v1/chat/completions') {
      if (body.model === 'empty-model') {
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        response.end('data: [DONE]\n\n')
        return
      }
      response.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
      response.end('data: [DONE]\n\n')
    } else if (request.url === '/v1/responses') {
      response.write('data: {"type":"response.output_text.delta","delta":"OK"}\n\n')
      response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n')
    } else if (request.url === '/v1/messages') {
      response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n')
      response.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n')
      response.end('data: {"type":"message_stop"}\n\n')
    } else {
      response.writeHead(404)
      response.end()
    }
  })
})

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const port = server.address().port
const dotnet = process.env.RANPARTY_DOTNET || 'D:\\PARTY\\.dotnet-sdk\\dotnet.exe'
const backendDll = resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')
const backend = spawn(dotnet, [backendDll], { cwd: sandbox, stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: backend.stdout })
const waiting = new Map()
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
})

let id = 0
const call = (method, params) => new Promise((resolveCall, reject) => {
  const requestId = `smoke-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000)
  waiting.set(requestId, (message) => {
    clearTimeout(timer)
    if (message.error) reject(new Error(typeof message.error === 'string' ? message.error : message.error.message))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})

const base = `http://127.0.0.1:${port}/v1`
const common = { name: 'smoke', baseUrl: base, apiKey: 'test-key', model: 'smoke-model', characterCard: '', supportsTools: true, supportsImages: true, supportsReasoning: false, contextWindow: 32000, maxOutputTokens: 1024 }
try {
  const bootstrap = await call('app.bootstrap', {})
  if (!bootstrap.settings.profiles.every((profile) => profile.characterDisplayName === '小然')) throw new Error('character title was not resolved from SOUL.md')
  const chat = await call('profiles.test', { profile: { ...common, provider: 'openai', wireProtocol: 'chat_completions' } })
  const responses = await call('profiles.test', { profile: { ...common, provider: 'openai', wireProtocol: 'responses' } })
  const anthropic = await call('profiles.test', { profile: { ...common, provider: 'anthropic', wireProtocol: 'anthropic_messages' } })
  const savedAnthropic = await call('profiles.save', { originalName: '', profile: { ...common, name: 'saved-anthropic', baseUrl: 'https://api.kimi.com/coding/v1', provider: 'anthropic', wireProtocol: 'anthropic_messages' } })
  const persistedAnthropic = savedAnthropic.profiles.find((profile) => profile.name === 'saved-anthropic')
  let emptyRejected = false
  try { await call('profiles.test', { profile: { ...common, model: 'empty-model', provider: 'openai', wireProtocol: 'chat_completions' } }) }
  catch (error) { emptyRejected = error.message.includes('没有返回正文') || error.message.includes('没有返回正文或工具调用') }

  if (![chat.reply, responses.reply, anthropic.reply].every((reply) => reply === 'OK')) throw new Error('unexpected model reply')
  if (!emptyRejected) throw new Error('empty provider response was not rejected')
  if (persistedAnthropic?.provider !== 'anthropic' || persistedAnthropic?.wireProtocol !== 'anthropic_messages') throw new Error('explicit Anthropic profile was overwritten during save')
  const [chatRequest, responsesRequest, anthropicRequest] = received
  if (chatRequest.url !== '/v1/chat/completions' || !Array.isArray(chatRequest.body.messages)) throw new Error('invalid Chat Completions request')
  if (responsesRequest.url !== '/v1/responses' || !Array.isArray(responsesRequest.body.input)) throw new Error('invalid Responses request')
  if (anthropicRequest.url !== '/v1/messages' || !Array.isArray(anthropicRequest.body.messages)) throw new Error('invalid Anthropic request')
  if (chatRequest.headers.authorization !== 'Bearer test-key' || responsesRequest.headers.authorization !== 'Bearer test-key') throw new Error('invalid OpenAI auth')
  if (anthropicRequest.headers['x-api-key'] !== 'test-key' || anthropicRequest.headers['anthropic-version'] !== '2023-06-01') throw new Error('invalid Anthropic auth')
  console.log(JSON.stringify({ passed: true, emptyRejected, characterDisplayName: bootstrap.settings.profiles[0].characterDisplayName, protocols: [chat.protocol, responses.protocol, anthropic.protocol], endpoints: received.map((item) => item.url) }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise((done) => setTimeout(done, 3000))])
  await new Promise((resolveClose) => server.close(resolveClose))
  await rm(sandbox, { recursive: true, force: true })
}
