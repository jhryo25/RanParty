import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd(); const sandbox = resolve('.tmp', `profile-preview-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true }); await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test\n', 'utf8'); const htmlPath = resolve(sandbox, 'report.html'); await writeFile(htmlPath, '<h1>RanParty preview</h1>', 'utf8')
const start = () => {
  const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], { cwd: sandbox, env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map(); createInterface({ input: backend.stdout }).on('line', line => { const message = JSON.parse(line); if (message.type === 'response' && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id) } })
  let id = 0; const call = (method, params = {}) => new Promise((resolveCall, reject) => { const requestId = `persist-${++id}`; const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 10000); waiting.set(requestId, message => { clearTimeout(timer); message.error ? reject(new Error(String(message.error))) : resolveCall(message.result) }); backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`) })
  return { backend, call }
}
let first; let second
try {
  first = start(); const bootstrap = await first.call('app.bootstrap'); const base = bootstrap.settings.profiles[0]
  await first.call('profiles.save', { originalName: base.name, profile: { ...base, name: 'custom', contextWindow: 256000, maxOutputTokens: 32000, supportsTools: true, supportsImages: false, supportsReasoning: false } })
  await first.call('profiles.save', { originalName: '', profile: { ...base, name: 'provider-default', model: 'default-model', contextWindow: 0, maxOutputTokens: 0, supportsTools: false } })
  const session = await first.call('session.create', { workspace: sandbox }); const preview = await first.call('path.preview', { path: htmlPath })
  if (preview.kind !== 'html' || !preview.content.includes('RanParty preview')) throw new Error('HTML preview failed')
  first.backend.kill(); await once(first.backend, 'exit'); first = null
  second = start(); const restored = await second.call('app.bootstrap'); const custom = restored.settings.profiles.find(profile => profile.name === 'custom'); const defaults = restored.settings.profiles.find(profile => profile.name === 'provider-default')
  if (custom.contextWindow !== 256000 || custom.maxOutputTokens !== 32000 || custom.supportsImages || custom.supportsReasoning) throw new Error(`custom profile did not persist: ${JSON.stringify(custom)}`)
  if (defaults.contextWindow !== 0 || defaults.maxOutputTokens !== 0 || defaults.supportsTools) throw new Error(`provider defaults did not persist: ${JSON.stringify(defaults)}`)
  console.log(JSON.stringify({ passed: true, custom: [custom.contextWindow, custom.maxOutputTokens], providerDefault: [defaults.contextWindow, defaults.maxOutputTokens], htmlPreview: true }, null, 2))
} finally { for (const item of [first, second]) if (item?.backend) { item.backend.kill(); await Promise.race([once(item.backend, 'exit'), new Promise(done => setTimeout(done, 2000))]) } await rm(sandbox, { recursive: true, force: true }) }
