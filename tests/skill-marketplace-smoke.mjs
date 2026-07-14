import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `marketplace-${Date.now()}`)
const installedRoot = resolve(sandbox, 'RanParty', 'InstalledSkills')
const transactionRoot = resolve(sandbox, 'RanParty', '.skill-transactions')
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await cp(resolve(root, 'RanParty', 'SkillMarket'), resolve(sandbox, 'RanParty', 'SkillMarket'), { recursive: true })
await cp(resolve(root, 'plugins'), resolve(sandbox, 'plugins'), { recursive: true })

const sha256 = value => createHash('sha256').update(value).digest('hex')
const treeHash = files => {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) => left.path.toLowerCase().localeCompare(right.path.toLowerCase()))) {
    hash.update(`${file.path.replaceAll('\\', '/')}\n`)
    hash.update(file.content)
  }
  return hash.digest('hex')
}

const createCollisionPlugin = async (directory, payload) => {
  const pluginRoot = resolve(sandbox, directory)
  const skillRoot = resolve(pluginRoot, 'skills', 'same-skill')
  await mkdir(resolve(pluginRoot, '.codex-plugin'), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  await writeFile(resolve(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'same-plugin',
    version: '1.0.0',
    skills: './skills/',
    interface: { displayName: 'Same Plugin', developerName: 'Smoke Publisher' },
  }), 'utf8')
  await writeFile(resolve(skillRoot, 'SKILL.md'), `---\nname: same-skill\ndescription: Same displayed identity from source ${payload}.\n---\nSource ${payload}.\n`, 'utf8')
  await writeFile(resolve(skillRoot, 'origin.txt'), payload, 'utf8')
}

await createCollisionPlugin('collision-plugin-a', 'origin-a')
await createCollisionPlugin('collision-plugin-b', 'origin-b')
await mkdir(resolve(sandbox, '.agents', 'plugins'), { recursive: true })
await writeFile(resolve(sandbox, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
  name: 'collision-market',
  interface: { displayName: 'Collision Market' },
  plugins: [
    { name: 'source-a', source: { source: 'local', path: './collision-plugin-a' }, category: 'Testing' },
    { name: 'source-b', source: { source: 'local', path: './collision-plugin-b' }, category: 'Testing' },
  ],
}), 'utf8')

const createRecoveryCandidate = async ({ name, expectedId, markerId = expectedId, markerHash, nestedSkill = false, phase = 'prepared' }) => {
  const transaction = resolve(transactionRoot, name)
  const staging = resolve(transaction, 'staging')
  const target = resolve(installedRoot, `recovered-${name}`)
  const skillDocument = `---\nname: recovery-${name}\ndescription: Recovery validation fixture.\n---\nRecovery fixture.\n`
  const files = [{ path: 'SKILL.md', content: skillDocument }]
  if (nestedSkill) files.push({ path: 'nested/SKILL.md', content: '---\nname: nested\ndescription: must be rejected\n---\n' })
  const actualTreeHash = treeHash(files)
  const declaredTreeHash = markerHash ?? actualTreeHash
  await mkdir(staging, { recursive: true })
  await writeFile(resolve(staging, 'SKILL.md'), skillDocument, 'utf8')
  if (nestedSkill) {
    await mkdir(resolve(staging, 'nested'), { recursive: true })
    await writeFile(resolve(staging, 'nested', 'SKILL.md'), files[1].content, 'utf8')
  }
  await writeFile(resolve(staging, '.ranparty-market.json'), JSON.stringify({
    id: markerId,
    version: '1.0.0',
    trust: 'community',
    skillContentHash: sha256(skillDocument),
    contentHash: declaredTreeHash,
  }), 'utf8')
  await writeFile(resolve(transaction, 'journal.json'), JSON.stringify({
    version: 2,
    target,
    hadTarget: false,
    phase,
    expectedId,
    expectedContentHash: declaredTreeHash,
  }), 'utf8')
  return target
}

const invalidRecoveryTargets = []
invalidRecoveryTargets.push(await createRecoveryCandidate({ name: 'unknown-phase', expectedId: 'recovery:unknown-phase', phase: 'unknown' }))
invalidRecoveryTargets.push(await createRecoveryCandidate({ name: 'marker-mismatch', expectedId: 'recovery:expected', markerId: 'recovery:other' }))
invalidRecoveryTargets.push(await createRecoveryCandidate({ name: 'tree-hash-mismatch', expectedId: 'recovery:tree-hash', markerHash: '0'.repeat(64) }))
invalidRecoveryTargets.push(await createRecoveryCandidate({ name: 'invalid-package', expectedId: 'recovery:invalid-package', nestedSkill: true }))
const malformedTransaction = resolve(transactionRoot, 'malformed-journal')
await mkdir(malformedTransaction, { recursive: true })
await writeFile(resolve(malformedTransaction, 'journal.json'), JSON.stringify({
  version: 2,
  target: 42,
  hadTarget: false,
  phase: 'prepared',
  expectedId: 'recovery:malformed',
  expectedContentHash: '0'.repeat(64),
}), 'utf8')

const backend = spawn(resolve(root, '.dotnet-sdk', 'dotnet.exe'), [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
  stdio: ['pipe', 'pipe', 'inherit'],
})
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
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10_000)
  waiting.set(id, message => {
    clearTimeout(timer)
    if (message.error) reject(new Error(String(message.error)))
    else resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
})

try {
  await call('app.bootstrap')
  for (const target of invalidRecoveryTargets) {
    try {
      await stat(target)
      throw new Error(`invalid recovery candidate was promoted: ${target}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const result = await call('skills.marketplace.list')
  const item = result.items.find(candidate => candidate.name === 'project-brief')
  if (!item) throw new Error(`project-brief missing: ${JSON.stringify(result)}`)
  if (item.marketplace !== 'RanParty 官方市场' || item.publisher !== 'RanParty') throw new Error(`metadata mismatch: ${JSON.stringify(item)}`)
  if (item.installed) throw new Error('project-brief unexpectedly installed before smoke test')
  await call('skills.marketplace.install', { id: item.id })
  const installedList = await call('skills.list')
  const installed = installedList.skills.find(candidate => candidate.name === 'project-brief')
  if (installed?.source !== 'Skill 市场') throw new Error(`installed skill missing: ${JSON.stringify(installedList)}`)
  await call('skills.marketplace.uninstall', { id: installed.id })
  const after = await call('skills.marketplace.list')
  if (after.items.find(candidate => candidate.id === item.id)?.installed) throw new Error('skill remained installed')

  const collisionCatalog = await call('skills.marketplace.list')
  const collisions = collisionCatalog.items.filter(candidate => candidate.name === 'same-skill')
  if (collisions.length !== 2 || new Set(collisions.map(candidate => candidate.id)).size !== 2) throw new Error(`same-name sources were collapsed: ${JSON.stringify(collisions)}`)
  const firstInstall = await call('skills.marketplace.install', { id: collisions[0].id })
  const afterFirstCollisionInstall = await call('skills.marketplace.list')
  const firstStatuses = collisions.map(collision => afterFirstCollisionInstall.items.find(candidate => candidate.id === collision.id)?.installed)
  if (firstStatuses[0] !== true || firstStatuses[1] !== false) throw new Error(`same-name marketplace installed state leaked across sources: ${JSON.stringify(firstStatuses)}`)
  const secondInstall = await call('skills.marketplace.install', { id: collisions[1].id })
  const afterSecondCollisionInstall = await call('skills.marketplace.list')
  if (collisions.some(collision => afterSecondCollisionInstall.items.find(candidate => candidate.id === collision.id)?.installed !== true)) throw new Error('installed state did not track both canonical marketplace sources')
  if (firstInstall.id === secondInstall.id || firstInstall.path === secondInstall.path) throw new Error(`canonical marketplace identities collided: ${JSON.stringify({ firstInstall, secondInstall })}`)
  const origins = await Promise.all([firstInstall.path, secondInstall.path].map(path => readFile(resolve(path, 'origin.txt'), 'utf8')))
  if (new Set(origins).size !== 2 || !origins.includes('origin-a') || !origins.includes('origin-b')) throw new Error(`one marketplace source overwrote another: ${JSON.stringify(origins)}`)
  const markers = await Promise.all([firstInstall.path, secondInstall.path].map(path => readFile(resolve(path, '.ranparty-market.json'), 'utf8').then(JSON.parse)))
  if (new Set(markers.map(marker => marker.id)).size !== 2 || new Set(markers.map(marker => marker.sourcePath)).size !== 2) throw new Error(`installed markers lost canonical source identity: ${JSON.stringify(markers)}`)
  await call('skills.marketplace.uninstall', { id: firstInstall.id })
  const afterFirstCollisionUninstall = await call('skills.marketplace.list')
  const uninstallStatuses = collisions.map(collision => afterFirstCollisionUninstall.items.find(candidate => candidate.id === collision.id)?.installed)
  if (uninstallStatuses[0] !== false || uninstallStatuses[1] !== true) throw new Error(`uninstall state leaked across same-name sources: ${JSON.stringify(uninstallStatuses)}`)
  await call('skills.marketplace.uninstall', { id: secondInstall.id })

  const backendSource = await readFile(resolve(root, 'backend', 'BackendHost.cs'), 'utf8')
  const previewSource = backendSource.slice(backendSource.indexOf('private async Task<JsonObject> PreviewSkillHubAsync'), backendSource.indexOf('private async Task<JsonObject> InstallSkillHubAsync'))
  const zipNormalizerSource = backendSource.slice(backendSource.indexOf('private static string NormalizeZipEntryPath'), backendSource.indexOf('private static string ValidateSkillHubSlug'))
  if (!previewSource.includes('NormalizeZipEntryPath(entry.FullName)') || !zipNormalizerSource.includes("Replace('\\\\', '/')")) throw new Error('SkillHub preview does not normalize backslash archive paths')
  if (!previewSource.includes('["scriptFileCount"]') || !previewSource.includes('["scriptFilesTruncated"]')) throw new Error('SkillHub preview does not disclose the complete script count and truncation state')
  if (!/scriptFiles\s*=\s*allScriptFiles\.Take\(20\)/.test(previewSource)
    || !/\["scriptFileCount"\]\s*=\s*allScriptFiles\.Length/.test(previewSource)
    || !/\["scriptFilesTruncated"\]\s*=\s*allScriptFiles\.Length\s*>\s*scriptFiles\.Length/.test(previewSource)) throw new Error('SkillHub preview count/truncation fields are not derived from the complete normalized script list')

  const skillHubInstallSource = backendSource.slice(backendSource.indexOf('private async Task<JsonObject> InstallSkillHubAsync'), backendSource.indexOf('private JsonObject ListSkillMarketplace'))
  const marketplaceInstallSource = backendSource.slice(backendSource.indexOf('private async Task<JsonObject> InstallMarketplaceSkillAsync'), backendSource.indexOf('private async Task<JsonObject> UninstallMarketplaceSkillAsync'))
  if (![skillHubInstallSource, marketplaceInstallSource].every(source => /finally\s*\{\s*CleanupSkillTransactionIfSettled\(transaction\);\s*installLock\.Release\(\);\s*\}/.test(source))) throw new Error('Skill installers must preserve unsettled transaction journals for startup recovery')
  const generatedExpertSource = backendSource.slice(backendSource.indexOf('private string InstallGeneratedExpertSkill'), backendSource.indexOf('private static JsonObject? LastJsonObject'))
  if (!/SkillFiles\.ComputeFileHash\(skillPath/.test(generatedExpertSource) || !/\["skillContentHash"\]\s*=\s*skillContentHash/.test(generatedExpertSource)) throw new Error('generated expert Skills must bind their marker to the installed SKILL.md hash')

  const atomicInstallSource = backendSource.slice(backendSource.indexOf('private static void AtomicInstallSkillDirectory'), backendSource.indexOf('private static string SkillTransactionsRoot'))
  const rollbackSource = atomicInstallSource.slice(atomicInstallSource.indexOf('catch'), atomicInstallSource.indexOf('// The installed journal is the commit point'))
  if (!/if\s*\(Directory\.Exists\(backup\)\)\s*\{[\s\S]*?if\s*\(Directory\.Exists\(target\)\)\s*Directory\.Delete\(target,\s*true\);[\s\S]*?Directory\.Move\(backup,\s*target\);[\s\S]*?\}\s*else if\s*\(!hadTarget\s*&&\s*Directory\.Exists\(target\)\)/.test(rollbackSource)) throw new Error('atomic rollback may delete an existing target without a restorable backup')
  const installedJournal = atomicInstallSource.indexOf('WriteSkillTransactionJournal(journal, target, hadTarget, "installed"')
  const rollbackCatch = atomicInstallSource.indexOf('catch', installedJournal)
  const committedCleanup = atomicInstallSource.lastIndexOf('if (Directory.Exists(backup)) Directory.Delete(backup, true);')
  const committedJournalDelete = atomicInstallSource.lastIndexOf('File.Delete(journal);')
  if (!(installedJournal >= 0 && installedJournal < rollbackCatch && rollbackCatch < committedCleanup && committedCleanup < committedJournalDelete)) throw new Error('installed journal cleanup must remain outside the rollback try/catch commit boundary')

  const recoverySource = backendSource.slice(backendSource.indexOf('private void RecoverSkillTransactions'), backendSource.indexOf('private void ValidateRecoverySkillDirectory'))
  const rolledBackUpgradeSource = recoverySource.slice(recoverySource.indexOf('case "backup_created"'), recoverySource.indexOf('case "installed"'))
  if (!/if\s*\(!Directory\.Exists\(backup\)\)\s*\{\s*if\s*\(Directory\.Exists\(target\)\)\s*\{[\s\S]*?ValidateRecoverySkillDirectory\(target,\s*expectedId,\s*expectedContentHash:\s*null\);[\s\S]*?break;/.test(rolledBackUpgradeSource)) throw new Error('recovery does not accept an already-restored valid target when a backup_created journal remains')

  console.log(JSON.stringify({
    passed: true,
    installedSource: installed.source,
    uninstalled: true,
    canonicalSourcesDistinct: true,
    invalidTransactionsQuarantined: invalidRecoveryTargets.length + 1,
    scriptPreviewContract: true,
    transactionRollbackContract: true,
  }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await rm(sandbox, { recursive: true, force: true })
}
