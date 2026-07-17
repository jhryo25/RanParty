import http from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const sandbox = resolve('.tmp', `vision-routing-${Date.now()}`)
await mkdir(resolve(sandbox, 'RanParty'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'SOUL.md'), '# Test assistant\n', 'utf8')
await mkdir(resolve(sandbox, 'RanParty', 'skills', 'hatch-pet'), { recursive: true })
await writeFile(resolve(sandbox, 'RanParty', 'skills', 'hatch-pet', 'SKILL.md'), `---
name: hatch-pet
description: Build a desktop pet from reference images.
---
# Hatch Pet
Use the configured reference-image model.
`, 'utf8')

const requests = []
const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (body.model === 'bad-vision-model') {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`)
    } else if (body.model === 'vision-model') {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '视觉摘要：两张图片都已识别，第一张是红色标记，第二张是蓝色标记。' } }] })}\n\n`)
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '主模型已基于视觉摘要回答。' } }] })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))

const dotnet = process.env.RANPARTY_DOTNET || 'D:\\PARTY\\.dotnet-sdk\\dotnet.exe'
const backend = spawn(dotnet, [resolve(root, 'backend', 'bin', 'Debug', 'net8.0', 'RanParty.Backend.dll')], {
  cwd: sandbox,
  env: { ...process.env, DOTNET_CLI_HOME: resolve(root, '.dotnet-home'), NUGET_PACKAGES: resolve(root, '.nuget') },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const waiting = new Map()
const events = []
createInterface({ input: backend.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'response' && waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
  if (message.type === 'event') events.push(message)
})

let id = 0
const call = (method, params = {}) => new Promise((resolveCall, reject) => {
  const requestId = `vision-${++id}`
  const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000)
  waiting.set(requestId, message => {
    clearTimeout(timer)
    message.error ? reject(new Error(String(message.error))) : resolveCall(message.result)
  })
  backend.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
})

const waitFor = async (predicate) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await new Promise(done => setTimeout(done, 25))
  }
  throw new Error('event timeout')
}

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
const largePng = `data:image/png;base64,${'A'.repeat(900_000)}`

try {
  const bootstrap = await call('app.bootstrap')
  const base = bootstrap.settings.profiles[0]
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  for (const profile of bootstrap.settings.profiles) {
    await call('profiles.save', { originalName: profile.name, profile: { ...profile, baseUrl, apiKey: 'test', supportsImages: false, supportsTools: false } })
  }
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'text-main', model: 'text-model', baseUrl, apiKey: 'test', supportsImages: false, supportsTools: false } })
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'vision-helper', model: 'vision-model', baseUrl, apiKey: 'test', supportsImages: true, supportsTools: false } })
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'bad-vision-helper', model: 'bad-vision-model', baseUrl, apiKey: 'test', supportsImages: true, supportsTools: false } })
  await call('pets.configure', { visionProfileName: 'bad-vision-helper' })
  await call('pets.configure', { visionProfileName: 'missing-vision-helper' }).then(
    () => { throw new Error('missing vision profile was accepted') },
    error => { if (!String(error).includes('识图模型配置不存在')) throw error },
  )
  await call('pets.configure', { visionProfileName: 'text-main' }).then(
    () => { throw new Error('non-vision profile was accepted') },
    error => { if (!String(error).includes('不支持图片输入')) throw error },
  )
  const session = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: session.id, profileName: 'text-main' })
  await call('chat.send', { sessionId: session.id, text: '请分析这两张图', imageDataUrls: [tinyPng, largePng], skillIds: [] })
  await waitFor(event => event.event === 'chat.completed' && event.data.sessionId === session.id)

  const visionRequest = requests.find(request => request.model === 'vision-model')
  const badVisionRequest = requests.find(request => request.model === 'bad-vision-model')
  const mainRequest = requests.find(request => request.model === 'text-model')
  const visionContent = visionRequest?.messages?.[0]?.content ?? []
  const mainPayload = JSON.stringify(mainRequest?.messages ?? [])
  const imageCount = Array.isArray(visionContent) ? visionContent.filter(item => item?.type === 'image_url').length : 0
  if (imageCount !== 2) throw new Error(`vision helper did not receive both images: ${imageCount}`)
  if (!badVisionRequest) throw new Error('first failing vision profile was not attempted')
  if (requests.indexOf(badVisionRequest) >= requests.indexOf(visionRequest)) throw new Error('selected vision profile was not attempted first')
  if (!mainPayload.includes('视觉摘要')) throw new Error('main model did not receive vision summary')
  if (mainPayload.includes('image_url')) throw new Error('non-vision main model received raw image_url')
  if (events.some(event => event.event === 'message.added' && JSON.stringify(event.data?.message ?? {}).includes('视觉识别失败'))) throw new Error('vision failure leaked as a chat bubble')
  if (!events.some(event => event.event === 'agent.started' && event.data.agentName === 'vision-helper')) throw new Error('vision agent lifecycle missing')

  await call('pets.configure', { visionProfileName: 'vision-helper' })
  await call('profiles.save', { originalName: '', profile: { ...base, name: 'vision-main', model: 'vision-main-model', baseUrl, apiKey: 'test', supportsImages: true, supportsTools: false } })
  const skillCatalog = await call('skills.list', { workspace: sandbox })
  const hatchPetSkill = skillCatalog.skills.find(skill => skill.name === 'hatch-pet')
  if (!hatchPetSkill) throw new Error('hatch-pet fixture was not discovered')
  const petSession = await call('session.create', { workspace: sandbox })
  await call('session.update', { sessionId: petSession.id, profileName: 'vision-main' })
  const petRequestStart = requests.length
  await call('chat.send', { sessionId: petSession.id, text: '请按参考图制作桌面宠物', imageDataUrls: [tinyPng], skillIds: [hatchPetSkill.id] })
  await waitFor(event => event.event === 'chat.completed' && event.data.sessionId === petSession.id)
  const petRequests = requests.slice(petRequestStart)
  const petVisionRequest = petRequests.find(request => request.model === 'vision-model')
  const petMainRequest = petRequests.find(request => request.model === 'vision-main-model')
  if (!petVisionRequest) throw new Error('selected pet vision profile was not used')
  const petMainPayload = JSON.stringify(petMainRequest?.messages ?? [])
  if (!petMainPayload.includes('视觉摘要')) throw new Error('pet main model did not receive the selected vision summary')
  if (petMainPayload.includes('image_url')) throw new Error('pet main model bypassed the selected vision profile')

  const after = await call('app.bootstrap')
  const updated = after.sessions.find(item => item.id === session.id)
  if (!updated || updated.contextTokens > 20_000) throw new Error(`image bytes inflated context estimate: ${updated?.contextTokens}`)
  console.log(JSON.stringify({ passed: true, imageCount, preferredFirst: 'bad-vision-helper', attemptedFallback: true, routedVia: 'vision-helper', hatchPetOverride: true, mainModel: 'text-main', contextTokens: updated.contextTokens }, null, 2))
} finally {
  backend.kill()
  await Promise.race([once(backend, 'exit'), new Promise(done => setTimeout(done, 3000))])
  await new Promise(done => server.close(done))
  await rm(sandbox, { recursive: true, force: true })
}
