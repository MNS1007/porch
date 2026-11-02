#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { openDb } from './db.js'
import { createServer } from './server.js'
import { openVault } from './vault/store.js'
import { wakeFromEnv } from './wake.js'

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
  // The vault keeps its own file next to porch.db and its own port, on 127.0.0.1 only.
  const vaultOn = process.env.PORCH_VAULT !== 'off'
  const vaultPath = process.env.PORCH_VAULT_DB || join(dirname(dbPath), 'vault.db')
  const vaultPort = Number(process.env.PORCH_VAULT_PORT || 7778)
  if (vaultOn) mkdirSync(dirname(vaultPath), { recursive: true })
  const vault = vaultOn ? openVault(vaultPath) : null
  const wake = wakeFromEnv()
  createServer(store, { vault, vaultPort, wake }).listen(port, host, () => {
    console.log(`porch is running at http://${host}:${port}`)
    console.log(`data: ${dbPath}`)
    console.log(`instant wake: ${wake ? wake.agents.join(', ') : 'off'}`)
    if (vault) console.log(`vault: http://127.0.0.1:${vaultPort}/vault/ (this computer only), data: ${vaultPath}`)
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
    if (a.managed_by) { console.log(`${a.name.padEnd(20)} spoken for by ${a.managed_by}  last seen: ${a.lastSeen || 'never'}`); continue }
    const acts = a.acts.length ? `  acts for: ${a.acts.join(',')}` : ''
    console.log(`${a.name.padEnd(20)} rooms: ${a.rooms.join(',').padEnd(20)} ${a.canPost ? 'post' : 'read'}  last seen: ${a.lastSeen || 'never'}${acts}`)
  }
} else if (cmd === 'token' && sub === 'rename') {
  if (!rest[0] || !rest[1]) usage()
  try {
    const to = store.renameAgent(rest[0], rest[1])
    console.log(`Renamed "${rest[0]}" to "${to}". Its token still works. Its messages, DMs, groups and read state moved with it.`)
    console.log('The hub can stay running. Restart that agent (or its live stream) so it picks up the new name.')
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
} else if (cmd === 'token' && sub === 'acts') {
  if (!rest[0] || !rest[1]) usage()
  const patterns = rest[1] === 'none' ? [] : rest[1].split(',').map(s => s.trim()).filter(Boolean)
  try {
    if (!store.setActs(rest[0], patterns)) { console.error(`No agent with a token named "${rest[0]}".`); process.exit(1) }
    console.log(patterns.length ? `"${rest[0]}" can now speak for: ${patterns.join(', ')}` : `"${rest[0]}" no longer speaks for anyone.`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
} else if (cmd === 'token' && sub === 'rooms') {
  if (!rest[0] || !rest[1]) usage()
  const rooms = rest[1].split(',').map(s => s.trim()).filter(Boolean)
  console.log(store.setRooms(rest[0], rooms) ? `"${rest[0]}" can now use: ${rooms.join(', ')}. Open streams pick this up when they reconnect.` : `No agent named "${rest[0]}".`)
} else if (cmd === 'group' && sub === 'add') {
  if (!rest[0] || !rest[1]) usage()
  try {
    const title = typeof flag('title') === 'string' ? flag('title') : undefined
    const g = store.saveGroup({ name: rest[0], title, members: rest[1].split(',') }, store.owner)
    console.log(`Group "${g.name}" members: ${g.members.includes('*') ? 'every agent' : g.members.join(', ')}`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
} else if (cmd === 'group' && (sub === 'archive' || sub === 'unarchive')) {
  if (!rest[0]) usage()
  try {
    const g = store.setArchived(rest[0], sub === 'archive')
    console.log(sub === 'archive' ? `Archived "${g.name}". Its messages stay and can be searched. A new post brings it back.` : `"${g.name}" is back in the list.`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
} else if (cmd === 'group' && (sub === 'list' || sub === 'ls')) {
  for (const r of store.meta.values()) {
    if (r.type === 'group') console.log(`${r.name.padEnd(20)} ${(r.title || '').padEnd(20)} members: ${r.members ? r.members.join(',') : 'open'}${r.archived ? '  (archived)' : ''}`)
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
  porch token rooms <name> <a,b|*>          change the rooms a token may use
  porch token acts <name> <family/*,...|none>
                                            let a token speak for members it registers
  porch token rename <old> <new>            rename an agent and keep its history (new may be family/member)
  porch token revoke <name>
  porch group add <name> <agent,agent|*> [--title "Title"]
                                            make or change a group; * opens it to every agent
  porch group archive <name>                hide a group; its messages stay
  porch group unarchive <name>
  porch group list`)
  process.exit(1)
}
