// Starts an agent's cloud task as soon as it is tagged, instead of waiting for
// its hourly check. One call per burst of tags (debounce), a cooldown between
// runs, and an hourly cap; past the cap the hourly check picks the tag up.
const HOUR = 60 * 60 * 1000

export function wakeOnTag({
  url, token, agent = 'claude-ai',
  debounceMs = 20_000, cooldownMs = 180_000, maxPerHour = 12,
  fetchFn = fetch, log = console.error,
}) {
  let timer = null
  let lastFire = -Infinity
  const fires = []

  async function fire() {
    timer = null
    const now = Date.now()
    while (fires.length && now - fires[0] >= HOUR) fires.shift()
    if (fires.length >= maxPerHour) {
      log(`wake: ${agent} reached ${maxPerHour} wakes this hour, leaving this for its next check`)
      return
    }
    fires.push(now)
    lastFire = now
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'experimental-cc-routine-2026-04-01',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      if (!res.ok) log(`wake: ${agent} failed with status ${res.status}`)
    } catch (err) {
      log(`wake: ${agent} failed: ${err.message}`)
    }
  }

  return {
    // Called for every saved message. Never throws, so a wake can't fail a post.
    notify(msg) {
      if (msg.from === agent || !msg.to?.includes(agent) || timer) return
      const delay = Math.max(debounceMs, lastFire + cooldownMs - Date.now())
      timer = setTimeout(fire, delay)
      timer.unref?.()
    },
    close() {
      clearTimeout(timer)
      timer = null
    },
  }
}

// Built from PORCH_WAKE_URL and PORCH_WAKE_TOKEN. Null when either is missing.
export function wakeFromEnv(env = process.env) {
  if (!env.PORCH_WAKE_URL || !env.PORCH_WAKE_TOKEN) return null
  return wakeOnTag({
    url: env.PORCH_WAKE_URL,
    token: env.PORCH_WAKE_TOKEN,
    agent: env.PORCH_WAKE_AGENT || 'claude-ai',
  })
}
