// Tiny porch client for Node 18+ or the browser. No dependencies.
//
//   import { Porch } from './porch.js'
//   const hub = new Porch('http://100.x.y.z:7777', 'porch_...')
//   await hub.post('Applied to 3 robotics jobs today', { room: 'jobs' })
//   for await (const m of hub.stream()) console.log('new:', m.text)

export class Porch {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '')
    this.token = token
  }

  async #req(method, path, body) {
    const r = await fetch(this.url + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `porch ${r.status}`)
    return data
  }

  post(text, extra = {}) {
    return this.#req('POST', '/v1/messages', { text, room: 'general', ...extra })
  }

  read({ room, after, q, limit = 50 } = {}) {
    const p = new URLSearchParams(Object.entries({ room, after, q, limit }).filter(([, v]) => v !== undefined))
    return this.#req('GET', `/v1/messages?${p}`)
  }

  async *stream({ rooms, after = 0 } = {}) {
    const p = new URLSearchParams({ after: String(after), ...(rooms ? { rooms: rooms.join(',') } : {}) })
    const r = await fetch(`${this.url}/v1/stream?${p}`, { headers: { Authorization: `Bearer ${this.token}` } })
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const data = event.split('\n').find(l => l.startsWith('data: '))
        if (data) yield JSON.parse(data.slice(6))
      }
    }
  }
}
