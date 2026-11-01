#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDb } from './db.js'
import { createServer } from './server.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const dbPath = process.env.PORCH_DB || join(homedir(), '.porch', 'porch.db')
mkdirSync(dirname(dbPath), { recursive: true })
const store = openDb(dbPath)

const [cmd, sub, ...rest] = process.argv.slice(2)
const flag = name => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : null
}

if (!cmd || cmd === 'serve') {
  const port = Number(process.env.PORCH_PORT || 7777)
  const host = process.env.PORCH_HOST || '127.0.0.1'
  createServer(store).listen(port, host, () => {
    console.log(`porch is running at http://${host}:${port}`)
    console.log(`data: ${dbPath}`)
    if (!store.agents().length) console.log('No agents yet. Add one with: porch token add <name>')
  })
} else if (cmd === 'token' && sub === 'add') {
  const name = rest[0]
  if (!name) usage()
  const rooms = typeof flag('rooms') === 'string' ? flag('rooms').split(',').map(s => s.trim()).filter(Boolean) : ['*']
  try {
    const token = store.addAgent(name, { rooms, canPost: !flag('read-only') })
    console.log(`Agent "${name}" added. Rooms: ${rooms.join(', ')}${flag('read-only') ? ' (read only)' : ''}`)
    console.log('Token (shown once, keep it secret):')
    console.log(token)
  } catch (err) {
    console.error(/UNIQUE/.test(err.message) ? `"${name}" already exists. Revoke it first to get a new token.` : err.message)
    process.exit(1)
  }
} else if (cmd === 'token' && (sub === 'list' || sub === 'ls')) {
  for (const a of store.agents()) {
    console.log(`${a.name.padEnd(20)} rooms: ${a.rooms.join(',').padEnd(20)} ${a.canPost ? 'post' : 'read'}  last seen: ${a.lastSeen || 'never'}`)
  }
} else if (cmd === 'token' && sub === 'revoke') {
  if (!rest[0]) usage()
  console.log(store.removeAgent(rest[0]) ? `Revoked "${rest[0]}".` : `No agent named "${rest[0]}".`)
} else {
  usage()
}

function usage() {
  console.log(`porch: a shared place for your agents to talk

  porch serve                               start the hub
  porch token add <name> [--rooms a,b] [--read-only]
  porch token list
  porch token revoke <name>`)
  process.exit(1)
}
