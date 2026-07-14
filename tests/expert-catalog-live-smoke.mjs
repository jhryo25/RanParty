import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const verifyInstall = process.argv.includes('--install')
const sandbox = resolve('.tmp', `expert-catalog-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test\n', 'utf8')

const remoteResponse = await fetch('https://api.skillhub.cn/api/v1/skillsets?page=1&pageSize=1', {
  headers: { accept: 'application/json', 'user-agent': 'RanParty-live-smoke/1.0' },
})
if (!remoteResponse.ok) throw new Error(`SkillHub API returned HTTP ${remoteResponse.status}`)
const remote = await remoteResponse.json()
const expectedTotal = Number(remote.total)
if (!Number.isInteger(expectedTotal) || expectedTotal < 1) throw new Error(`invalid SkillHub total: ${remote.total}`)

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
  stdio: ['pipe', 'pipe', 'inherit'],
})
const waiting = new Map()
createInterface({ input: backend.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) }
})
let id = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const requestId = `expert-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 120000)
  waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})

try {
  const result = await call('experts.skillhub.list', {})
  if (result.total !== expectedTotal) throw new Error(`total mismatch: SkillHub=${expectedTotal}, RanParty=${result.total}`)
  if (!Array.isArray(result.items) || result.items.length !== expectedTotal) throw new Error(`item mismatch: expected=${expectedTotal}, returned=${result.items?.length}`)
  if (expectedTotal <= 60) throw new Error(`catalog no longer exercises pagination: total=${expectedTotal}`)
  const first = result.items[0]
  const detail = await call('experts.skillhub.detail', { slug: first.slug })
  if (detail.slug !== first.slug || !detail.displayName) throw new Error(`detail mapping failed for ${first.slug}`)
  let installResult = null
  if (verifyInstall) {
    installResult = await call('experts.skillhub.install', { slug: first.slug, name: first.name, description: first.description })
    if (!installResult.installed || installResult.teamId !== first.slug || installResult.skillCount < 1) throw new Error(`expert pack install failed: ${JSON.stringify(installResult)}`)
    const afterInstall = await call('experts.skillhub.list', {})
    const installedItem = afterInstall.items.find(item => item.slug === first.slug)
    if (!installedItem?.installed || !installedItem.leaderSkillId) throw new Error(`installed expert pack was not discoverable: ${JSON.stringify(installedItem)}`)
  }
  console.log(JSON.stringify({ passed: true, skillHubTotal: expectedTotal, ranPartyItems: result.items.length, paginated: true, detailSlug: detail.slug, installVerified: Boolean(installResult), installedSkills: installResult?.skillCount ?? 0 }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await rm(sandbox, { recursive: true, force: true })
}
