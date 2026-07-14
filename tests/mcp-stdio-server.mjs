import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

if (process.env.MCP_DESCENDANT_PID_FILE) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  writeFileSync(process.env.MCP_DESCENDANT_PID_FILE, String(descendant.pid), 'utf8')
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (!message.id) return
  const result = (() => {
    switch (message.method) {
      case 'initialize': return { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } }, serverInfo: { name: 'ranparty-mcp-smoke', version: '1.0.0' } }
      case 'ping': return {}
      case 'tools/list': return { tools: [
        { name: 'echo', title: 'Echo', description: 'Echo a value for MCP smoke tests', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: 'echo-value', description: 'Collision fixture A', inputSchema: { type: 'object' } },
        { name: 'echo_value', description: 'Collision fixture B', inputSchema: { type: 'object' } },
      ] }
      case 'tools/call': return { content: [{ type: 'text', text: String(message.params?.arguments?.value ?? '') }], isError: false }
      case 'resources/list': return { resources: [{ uri: 'test://status', name: 'status', title: 'Status', description: 'Fixture status', mimeType: 'text/plain' }] }
      case 'resources/read': return { contents: [{ uri: 'test://status', mimeType: 'text/plain', text: 'ready' }] }
      case 'prompts/list': return { prompts: [{ name: 'hello', title: 'Hello', description: 'Fixture greeting', arguments: [{ name: 'name', required: false }] }] }
      case 'prompts/get': return { description: 'Fixture greeting', messages: [{ role: 'user', content: { type: 'text', text: `Hello ${message.params?.arguments?.name ?? 'world'}` } }] }
      default: return null
    }
  })()
  if (result === null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  else send({ jsonrpc: '2.0', id: message.id, result })
})
