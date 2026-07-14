import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `mcp-connector-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const waiting = new Map()
const descendantPidFile = resolve(sandbox, 'descendant.pid')
let descendantPid = 0
createInterface({ input: backend.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
})
let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `mcp-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000)
  waiting.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

try {
  await call('app.bootstrap')
  const saved = await call('connectors.save', { connector: {
    name: 'Fixture', type: 'stdio', command: process.execPath, args: [resolve(root, 'tests/mcp-stdio-server.mjs')],
    enabled: false, approvalMode: 'ask', env: { FIXTURE_SECRET: 'not-written-in-cleartext', MCP_DESCENDANT_PID_FILE: descendantPidFile },
  } })
  const id = saved.connector.id
  const tested = await call('connectors.test', { id, workspace: sandbox })
  if (!tested.ok || tested.tools?.[0]?.name !== 'echo') throw new Error(`MCP discovery failed: ${JSON.stringify(tested)}`)
  if (tested.resources?.[0]?.name !== 'status' || tested.prompts?.[0]?.name !== 'hello') throw new Error(`MCP resources/prompts discovery failed: ${JSON.stringify({ resources: tested.resources, prompts: tested.prompts })}`)

  await call('connectors.save', { connector: { ...saved.connector, enabled: true, enabledTools: ['echo'], pinnedTools: [], approvalMode: 'auto' } })
  const tools = await call('connectors.tools', { id, workspace: sandbox, refresh: true })
  if (tools.tools?.find(tool => tool.name === 'echo')?.exposedName !== 'mcp__fixture__echo') throw new Error('stable exposed MCP name was not generated')
  const collisionNames = tools.tools.filter(tool => tool.name === 'echo-value' || tool.name === 'echo_value').map(tool => tool.exposedName)
  if (new Set(collisionNames).size !== 2 || collisionNames.some(name => !/_[0-9a-f]{8}$/.test(name))) throw new Error(`MCP tool name collision was not hashed: ${collisionNames.join(', ')}`)

  const document = JSON.parse(await readFile(resolve(sandbox, 'Config/connectors.json'), 'utf8'))
  if (document.schemaVersion !== 2 || document.connectors[0].enabledTools[0] !== 'echo') throw new Error('connector schema v2 persistence failed')
  if (!document.connectors[0].envSecretRefs.FIXTURE_SECRET.startsWith(`${id}:env:`)) throw new Error('masked secret reference replaced the persistent DPAPI reference')
  const secrets = await readFile(resolve(sandbox, 'Config/connector-secrets.json'), 'utf8')
  if (secrets.includes('not-written-in-cleartext')) throw new Error('connector secret was stored in plaintext')
  descendantPid = Number(await readFile(descendantPidFile, 'utf8'))
} finally {
  backend.stdin.end()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 5000))])
  if (!backend.killed) backend.kill()
  const deadline = Date.now() + 3000
  while (descendantPid && Date.now() < deadline) {
    try { process.kill(descendantPid, 0); await new Promise(done => setTimeout(done, 50)) } catch { descendantPid = 0 }
  }
  if (descendantPid) {
    try { process.kill(descendantPid, 'SIGKILL') } catch {}
    throw new Error('Windows Job Object left an MCP descendant process running')
  }
  await rm(sandbox, { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: true, transport: 'stdio', tools: 3, resources: 1, prompts: 1, schemaVersion: 2, secretRedacted: true, collisionsHashed: true, processTreeCleaned: true }, null, 2))
