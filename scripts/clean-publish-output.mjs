import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.resolve(process.argv[2] || '')
const expected = path.join(repositoryRoot, 'backend-publish-v4')

if (target !== expected) {
  throw new Error(`Refusing to clean unexpected publish directory: ${target}`)
}

rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
