import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `knowledge-growth-smoke-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty', 'Characters'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# 小然\n\n默认角色。\n', 'utf8')
await writeFile(resolve(sandbox, 'RanParty', 'Characters', 'tester.md'), '# 测试角色\n\n用于成长记录测试。\n', 'utf8')
await writeFile(resolve(sandbox, 'RanParty', 'Characters', 'legacy_growth.md'), '> ver:1\n\n## 你的偏好\n', 'utf8')

const dotnet = 'D:\\PARTY\\.dotnet-sdk\\dotnet.exe'
const backendDll = resolve(root, 'backend/bin/Debug/net8.0/RanParty.Backend.dll')
const backend = spawn(dotnet, [backendDll], { cwd: sandbox, stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: backend.stdout })
const waiting = new Map()

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
})

let requestId = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `knowledge-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000)
  waiting.set(id, (message) => {
    clearTimeout(timer)
    if (message.error) reject(new Error(String(message.error)))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

try {
  await call('app.bootstrap')
  const listed = await call('knowledge.list')
  const files = listed.items.map((item) => item.file)
  for (const expected of ['Characters/SOUL_growth.md', 'Characters/tester_growth.md', 'Characters/legacy_growth.md']) {
    if (!files.includes(expected)) throw new Error(`missing growth file: ${expected}`)
  }

  const empty = await call('knowledge.list', { file: 'Characters/tester_growth.md' })
  if (empty.kind !== 'growth' || empty.content !== '') throw new Error('missing empty growth content support')

  await call('knowledge.update', { file: 'Characters/tester_growth.md', content: '> ver:1\n\n## 关系里程碑\n- 已建立测试成长记录\n' })
  const saved = await call('knowledge.list', { file: 'Characters/tester_growth.md' })
  if (!saved.content.includes('已建立测试成长记录')) throw new Error('growth save did not persist')

  const characters = await call('characters.list')
  if (characters.characters.some((character) => String(character.name).endsWith('_growth'))) throw new Error('growth file leaked into character list')

  console.log(JSON.stringify({ passed: true, growthFiles: files.filter((file) => file.endsWith('_growth.md')).length, characters: characters.characters.length }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise((done) => setTimeout(done, 3000))])
  await rm(sandbox, { recursive: true, force: true })
}
