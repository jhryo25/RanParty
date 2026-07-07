import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

const received = []
const server = http.createServer((request, response) => {
  received.push({ url: request.url, headers: request.headers })
  if (request.url === '/custom/v1/models') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":{"message":"not exposed on custom prefix"}}')
    return
  }
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"models":["model-z",{"id":"model-a"},{"name":"model-b"}]}')
    return
  }
  response.writeHead(404)
  response.end()
})

await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
const port = server.address().port
const packagedBackend = process.env.RANPARTY_BACKEND
const backend = packagedBackend
  ? spawn(resolve(packagedBackend), [], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(process.env.RANPARTY_DOTNET || 'D:\\PARTY\\.dotnet-sdk\\dotnet.exe', [resolve('backend/bin/Debug/net8.0/RanParty.Backend.dll')], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: backend.stdout })
const waiting = new Map()
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.id && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
})

let id = 0
const call = (method, params) => new Promise((resolveCall, reject) => {
  const requestId = `models-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000)
  waiting.set(requestId, message => {
    clearTimeout(timer)
    if (message.error) reject(new Error(typeof message.error === 'string' ? message.error : message.error.message ?? JSON.stringify(message.error)))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})

try {
  const result = await call('profiles.models', {
    originalName: '',
    profile: { provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}/custom/v1`, apiKey: 'test-key' },
  })
  if (result.endpoint !== `http://127.0.0.1:${port}/v1/models`) throw new Error(`unexpected fallback endpoint: ${result.endpoint}`)
  if (result.models.join(',') !== 'model-a,model-b,model-z') throw new Error(`unexpected models: ${result.models.join(',')}`)
  const fallbackRequest = received.find(item => item.url === '/v1/models')
  if (fallbackRequest.headers['x-api-key'] !== 'test-key' || fallbackRequest.headers['anthropic-version'] !== '2023-06-01') throw new Error('Anthropic model-list headers missing')
  console.log(JSON.stringify({ passed: true, endpoint: result.endpoint, models: result.models, attempted: received.map(item => item.url) }, null, 2))
} finally {
  backend.kill()
  await new Promise(resolveClose => server.close(resolveClose))
}
