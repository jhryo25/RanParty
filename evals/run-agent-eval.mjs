import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const manifestPath = resolve(root, option('--manifest') ?? 'evals/agent-eval.manifest.json')
const outputPath = resolve(root, option('--output') ?? 'evals/results/latest.json')
const gate = process.argv.includes('--gate')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
validateManifest(manifest)
const startedAt = new Date()
const dotnet = process.env.RANPARTY_DOTNET
  || (existsSync(resolve(root, '.dotnet-sdk/dotnet.exe')) ? resolve(root, '.dotnet-sdk/dotnet.exe') : 'dotnet')
const gitCommit = await readGitCommit()

const preflight = []
for (const check of manifest.preflight ?? []) {
  const result = await runCheck(check)
  preflight.push(result)
  printResult(result)
  if (result.status !== 'passed') {
    const report = buildReport([], preflight)
    await saveReport(report)
    process.exitCode = 2
    process.exit()
  }
}

const results = []
for (const check of manifest.checks) {
  const result = await runCheck(check)
  results.push(result)
  printResult(result)
}

const report = buildReport(results, preflight)
await saveReport(report)
console.log(`\nAgent eval: ${report.score.toFixed(1)}/100; automated contracts: ${report.automatedPassRate.toFixed(1)}%; evidence coverage: ${report.evidenceCoverage.toFixed(1)}%`)
console.log(`Result: ${relative(outputPath)}`)
if (gate && report.score < manifest.releaseGate) process.exitCode = 1

async function runCheck(check) {
  const started = Date.now()
  if (check.type === 'manual') {
    return baseResult(check, 'gap', started, { evidence: check.gap })
  }
  if (check.type === 'source') {
    const sourcePath = resolve(root, check.path)
    const content = await readFile(sourcePath, 'utf8')
    const missing = check.requires.filter(pattern => !new RegExp(pattern, 'is').test(content))
    return baseResult(check, missing.length ? 'failed' : 'passed', started, {
      evidence: missing.length ? check.gap : `源码契约满足：${check.requires.join(', ')}`,
      missingPatterns: missing
    })
  }
  if (check.type !== 'command') throw new Error(`Unsupported check type: ${check.type}`)
  const command = check.command === 'dotnet' ? dotnet : check.command
  const execution = await run(command, check.args ?? [])
  return baseResult(check, execution.exitCode === 0 ? 'passed' : 'failed', started, {
    command: [command, ...(check.args ?? [])],
    exitCode: execution.exitCode,
    evidence: execution.exitCode === 0 ? lastMeaningfulLine(execution.stdout) : tail(execution.stderr || execution.stdout, 2000)
  })
}

function baseResult(check, status, started, extra) {
  return {
    id: check.id,
    title: check.title,
    dimension: check.dimension ?? 'preflight',
    type: check.type,
    points: check.points ?? 0,
    status,
    durationMs: Date.now() - started,
    ...extra
  }
}

function buildReport(results, preflight) {
  const dimensions = manifest.dimensions.map(dimension => {
    const checks = results.filter(check => check.dimension === dimension.id)
    const available = checks.reduce((sum, check) => sum + check.points, 0)
    const earned = checks.filter(check => check.status === 'passed').reduce((sum, check) => sum + check.points, 0)
    const score = available > 0 ? earned / available * 100 : 0
    return { ...dimension, score, earnedPoints: earned, availablePoints: available }
  })
  const score = dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight / 100, 0)
  const automated = results.filter(check => check.type === 'command')
  const automatedPassRate = automated.length ? automated.filter(check => check.status === 'passed').length / automated.length * 100 : 0
  const allPoints = results.reduce((sum, check) => sum + check.points, 0)
  const evidencePoints = results.filter(check => check.type !== 'manual').reduce((sum, check) => sum + check.points, 0)
  return {
    schemaVersion: 1,
    manifest: basename(manifestPath),
    commit: gitCommit,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    releaseGate: manifest.releaseGate,
    score,
    automatedPassRate,
    evidenceCoverage: allPoints ? evidencePoints / allPoints * 100 : 0,
    gatePassed: score >= manifest.releaseGate,
    dimensions,
    preflight,
    results,
    gaps: results.filter(check => check.status !== 'passed').map(check => ({ id: check.id, title: check.title, dimension: check.dimension, reason: check.evidence }))
  }
}

async function saveReport(report) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
}

function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout = bounded(stdout + chunk) })
    child.stderr.on('data', chunk => { stderr = bounded(stderr + chunk) })
    child.on('error', error => resolveRun({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` }))
    child.on('close', code => resolveRun({ exitCode: code ?? -1, stdout, stderr }))
  })
}

function bounded(value) { return value.length > 200_000 ? value.slice(-200_000) : value }
function tail(value, max) { return value.trim().slice(-max) }
function lastMeaningfulLine(value) { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) ?? 'exit 0' }
function relative(path) { return path.replace(root + '\\', '').replaceAll('\\', '/') }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
function printResult(result) { console.log(`${result.status === 'passed' ? 'PASS' : result.status === 'gap' ? 'GAP ' : 'FAIL'}  ${result.id} (${result.durationMs}ms)`) }

function validateManifest(value) {
  const dimensions = new Set(value.dimensions?.map(item => item.id))
  const weight = value.dimensions?.reduce((sum, item) => sum + item.weight, 0)
  if (!dimensions.size || weight !== 100) throw new Error(`Dimension weights must total 100; received ${weight}`)
  const ids = new Set()
  for (const check of [...(value.preflight ?? []), ...(value.checks ?? [])]) {
    if (!check.id || ids.has(check.id)) throw new Error(`Missing or duplicate check id: ${check.id}`)
    ids.add(check.id)
    if (check.dimension && !dimensions.has(check.dimension)) throw new Error(`Unknown dimension on ${check.id}: ${check.dimension}`)
    if (!['command', 'source', 'manual'].includes(check.type)) throw new Error(`Unknown check type on ${check.id}: ${check.type}`)
  }
}

function readGitCommit() {
  return new Promise(resolveCommit => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })
    let value = ''
    child.stdout.on('data', chunk => { value += chunk })
    child.on('close', () => resolveCommit(value.trim() || 'unknown'))
    child.on('error', () => resolveCommit('unknown'))
  })
}
