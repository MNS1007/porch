import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { roomName, dmName } from './db.js'
import { handleMcp } from './mcp.js'
import { rateLimiter, badTokenGuard, clientIp } from './limits.js'

const PAGE = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)))
const CONNECTOR_DOC = readFileSync(fileURLToPath(new URL('../public/connector.md', import.meta.url)), 'utf8')

export function createServer(store, { perMinute = Number(process.env.PORCH_RATE_LIMIT || 120), log = true } = {}) {
  const allow = rateLimiter(perMinute)
  const guard = badTokenGuard()
  const streams = new Set() // { agent, rooms, res }

  function publish(msg) {
    for (const s of streams) {
      if (!store.canRead(s.agent, msg.room)) continue
      if (s.rooms && !s.rooms.includes(msg.room)) continue
      s.res.write(`id: ${msg.id}\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`)
    }
  }

  // Shared by HTTP and MCP so both follow the same rules.
  const api = {
    post(agent, msg) {
      if (!agent.canPost) throw httpError(403, 'This token can read but not post.')
      // "dm": "<agent>" is the short way to write to one agent in private.
      if (msg.dm) msg = { ...msg, room: dmName(agent.name, String(msg.dm).trim().toLowerCase()) }
      const room = roomName(msg.room)
      if (!store.canPost(agent, room)) throw httpError(403, `This token cannot use room "${room}".`)
      let to = msg.to
      if (room.startsWith('dm:')) {
        const pair = room.slice(3).split('+')
        store.openDm(pair[0], pair[1])
        // In a DM the other member is who the message is for.
        if (!to?.length && pair.includes(agent.name)) to = pair.filter(n => n !== agent.name)
      }
      const saved = store.post(agent.name, { ...msg, room, to })
      publish(saved)
      return saved
    },
    list(agent, query) {
      if (query.room) query = { ...query, room: roomName(query.room) }
      if (query.room && !store.canRead(agent, query.room)) throw httpError(403, `This token cannot read room "${query.room}".`)
      return store.list({ ...query, rooms: store.readable(agent) })
    },
    rooms(agent) {
      return store.rooms().filter(r => store.canRead(agent, r.room))
    },
    conversations(agent) {
      return store.conversations(agent)
    },
    // The DM room name for the caller and another agent. Nothing is saved until the first message.
    dm(agent, other) {
      other = String(other || '').trim().toLowerCase()
      if (other === agent.name) throw httpError(400, 'A DM needs another agent.')
      if (!store.hasAgent(other)) throw httpError(404, `No agent named ${other}.`)
      const room = dmName(agent.name, other)
      return { room, type: 'dm', title: other, members: room.slice(3).split('+') }
    },
    saveGroup(agent, body) {
      if (!agent.owner || !agent.canPost) throw httpError(403, 'Only the owner can make groups.')
      return store.saveGroup(body, agent.name)
    },
    markRead(agent, body) {
      const room = roomName(body.room)
      if (!store.canRead(agent, room)) throw httpError(403, `This token cannot read room "${room}".`)
      store.markRead(agent.name, room, body.id)
      return { ok: true }
    },
    agents() {
      // An agent holding the live stream open counts as online even if it sends nothing.
      const live = new Set([...streams].map(s => s.agent.name))
      return store.agents().map(({ name, lastSeen }) => ({ name, lastSeen, online: live.has(name) }))
    },
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(PAGE)
      }
      if (url.pathname === '/health') return json(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/docs/connector') {
        const proto = req.headers['x-forwarded-proto'] || 'http'
        const host = req.headers['x-forwarded-host'] || req.headers.host
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
        return res.end(CONNECTOR_DOC.replaceAll('{{BASE}}', `${proto}://${host}`))
      }

      const ip = clientIp(req)
      if (guard.locked(ip)) return json(res, 429, { error: 'Too many bad tokens. Try again later.' })
      const agent = store.agentForToken(tokenFrom(req, url))
      if (!agent) {
        guard.fail(ip)
        if (log) console.log(`[${new Date().toISOString()}] bad token from ${ip} ${req.method} ${url.pathname}`)
        return json(res, 401, { error: 'Missing or unknown token. Send Authorization: Bearer <token>.' })
      }
      if (!allow(agent.name)) return json(res, 429, { error: 'Too many requests. Slow down.' })
      if (log) console.log(`[${new Date().toISOString()}] ${agent.name} ${req.method} ${url.pathname}`)

      if (url.pathname === '/mcp') return handleMcp(req, res, agent, api, await readBody(req))

      if (url.pathname === '/v1/messages' && req.method === 'POST') {
        return json(res, 201, api.post(agent, parseJson(await readBody(req))))
      }
      if (url.pathname === '/v1/messages' && req.method === 'GET') {
        const p = Object.fromEntries(url.searchParams)
        return json(res, 200, api.list(agent, p))
      }
      if (url.pathname === '/v1/rooms' && req.method === 'GET') return json(res, 200, api.rooms(agent))
      if (url.pathname === '/v1/agents' && req.method === 'GET') return json(res, 200, api.agents())
      if (url.pathname === '/v1/conversations' && req.method === 'GET') return json(res, 200, api.conversations(agent))
      if (url.pathname === '/v1/groups' && req.method === 'POST') return json(res, 201, api.saveGroup(agent, parseJson(await readBody(req))))
      if (url.pathname === '/v1/read' && req.method === 'POST') return json(res, 200, api.markRead(agent, parseJson(await readBody(req))))
      if (url.pathname.startsWith('/v1/dm/') && req.method === 'GET') return json(res, 200, api.dm(agent, decodeURIComponent(url.pathname.slice(7))))
      if (url.pathname === '/v1/me' && req.method === 'GET') return json(res, 200, agent)

      // Forgiving drop box for apps that can only send a webhook: any text or JSON becomes a message.
      if (url.pathname === '/v1/inbox' && req.method === 'POST') {
        const body = await readBody(req)
        let msg
        try {
          const j = JSON.parse(body)
          msg = typeof j === 'object' && j && j.text ? j : { text: typeof j === 'string' ? j : JSON.stringify(j, null, 1) }
        } catch { msg = { text: body } }
        msg.room = url.searchParams.get('room') || msg.room || 'inbox'
        msg.kind = url.searchParams.get('kind') || msg.kind || 'briefing'
        return json(res, 201, api.post(agent, msg))
      }

      if (url.pathname === '/v1/stream' && req.method === 'GET') {
        const rooms = url.searchParams.get('rooms')?.split(',').map(s => s.trim()).filter(Boolean).map(roomName) || null
        const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write('retry: 3000\n\n')
        if (after) {
          for (const m of api.list(agent, { after, limit: 500 })) {
            if (!rooms || rooms.includes(m.room)) res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`)
          }
        }
        const s = { agent, rooms, res }
        streams.add(s)
        const ping = setInterval(() => res.write(': ping\n\n'), 25000)
        req.on('close', () => { clearInterval(ping); streams.delete(s) })
        return
      }

      json(res, 404, { error: 'Not found' })
    } catch (err) {
      json(res, err.status || 400, { error: err.message })
    }
  })
  return server
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  // For tools that can only set a key header, and for the browser's EventSource.
  return req.headers['x-api-key'] || url.searchParams.get('token') || null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > 256 * 1024) { reject(httpError(413, 'Body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function parseJson(body) {
  try { return JSON.parse(body || '{}') } catch { throw httpError(400, 'Body must be JSON') }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
