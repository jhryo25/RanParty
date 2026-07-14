import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const executable = path.resolve(process.argv[2] || path.join('backend-publish-v4', process.platform === 'win32' ? 'RanParty.Backend.exe' : 'RanParty.Backend'))
const dataRoot = mkdtempSync(path.join(tmpdir(), 'ranparty-published-backend-'))
const timeoutMs = 15_000

let stderr = ''
let stdoutBuffer = ''
let ready = false
let bootstrapped = false

const child = spawn(executable, [], {
  cwd: dataRoot,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const finished = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Published backend did not become ready within ${timeoutMs}ms.`)), timeoutMs)
  const complete = () => {
    if (!ready || !bootstrapped) return
    clearTimeout(timer)
    resolve()
  }

  child.on('error', reject)
  child.on('exit', (code, signal) => {
    if (ready && bootstrapped) return
    clearTimeout(timer)
    reject(new Error(`Published backend exited before bootstrap (code=${code ?? 'none'}, signal=${signal ?? 'none'}).\n${stderr.trim()}`))
  })
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_000) })
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) }
      catch { continue }
      if (message.type === 'event' && message.event === 'backend.ready') ready = true
      if (message.type === 'response' && message.id === 'published-smoke') {
        if (message.error) reject(new Error(`Published backend bootstrap failed: ${message.error}`))
        else bootstrapped = Boolean(message.result?.settings && Array.isArray(message.result?.sessions))
      }
      complete()
    }
  })
})

try {
  child.stdin.write(`${JSON.stringify({ id: 'published-smoke', method: 'app.bootstrap', params: {} })}\n`)
  await finished
  console.log('Published backend smoke passed: ready event and app.bootstrap response received.')
} finally {
  child.kill()
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => child.once('exit', resolve))
  }
  rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
