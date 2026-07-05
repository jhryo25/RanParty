import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { resolve } from 'node:path'

const backend = spawn('D:\\PARTY\\.dotnet-sdk\\dotnet.exe', [resolve('backend/bin/Debug/net8.0/RanParty.Backend.dll')], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
const lines = createInterface({ input: backend.stdout })
let requestId = 0
const waiting = new Map()
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
})
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = `market-${++requestId}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000)
  waiting.set(id, message => {
    clearTimeout(timer)
    if (message.error) reject(new Error(String(message.error)))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

try {
  const result = await call('skills.marketplace.list')
  const item = result.items.find(candidate => candidate.name === 'project-brief')
  if (!item) throw new Error(`project-brief missing: ${JSON.stringify(result)}`)
  if (item.marketplace !== 'RanParty 官方市场' || item.publisher !== 'RanParty') throw new Error(`metadata mismatch: ${JSON.stringify(item)}`)
  if (item.installed) throw new Error('project-brief unexpectedly installed before smoke test')
  await call('skills.marketplace.install', { id: item.id })
  const installed = (await call('skills.list')).skills.find(candidate => candidate.name === 'project-brief')
  if (installed?.source !== 'Skill 市场') throw new Error(`installed skill missing: ${JSON.stringify(installed)}`)
  await call('skills.marketplace.uninstall', { id: item.id })
  const after = await call('skills.marketplace.list')
  if (after.items.find(candidate => candidate.id === item.id)?.installed) throw new Error('skill remained installed')
  console.log(JSON.stringify({ passed: true, item, installedSource: installed.source, uninstalled: true }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 2000))])
}
