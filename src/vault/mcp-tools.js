// The vault as MCP tools on porch's /mcp: vault_list, vault_request, vault_status.
// The wiring step calls registerVaultTools(server, agent, api) inside mcp.js's build().
import { z } from 'zod'

const envPort = () => Number(process.env.PORCH_VAULT_PORT || 7778)
const proxyNote = (port = envPort) => `API keys are never returned by any vault tool. To call a provider, use the proxy at http://127.0.0.1:${port()}/vault/proxy/<provider> (openai or gemini) on the hub's computer, with your handle as the API key: for OpenAI set the base URL to http://127.0.0.1:${port()}/vault/proxy/openai/v1, for Gemini to http://127.0.0.1:${port()}/vault/proxy/gemini. Only the owner can approve, on the local vault page.`

const text = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] })

// A refusal is an answer the agent can act on, not a tool crash.
const answer = fn => {
  try { return text(fn()) } catch (err) {
    return { ...text({ error: err.status ? err.message : 'The vault could not do that.' }), isError: true }
  }
}

export function vaultTools(agent, api) {
  // The api knows the port the vault really listens on; the env is the fallback.
  const port = typeof api.port === 'function' ? api.port : envPort
  return [
    {
      name: 'vault_list',
      description: `List the vault's keys by name and provider, and your own grants (status, caps, spent, expiry) and requests. ${proxyNote(port)}`,
      inputSchema: {
        as: z.string().optional().describe('A member you speak for, for example claude-code/main. Leave out for yourself'),
      },
      handler: async ({ as }) => answer(() => api.list(agent, { as })),
    },
    {
      name: 'vault_request',
      description: `Ask the owner for access to one vault key, limited to some models and endpoints and capped in dollars. The owner gets a porch note and decides on the local vault page; this tool cannot approve. Then call vault_status with the request id. ${proxyNote(port)}`,
      inputSchema: {
        secret: z.string().describe('Key name from vault_list, for example "gemini"'),
        purpose: z.string().describe('What you need it for, one or two plain sentences'),
        scope: z.object({
          models: z.array(z.string()).describe('Models you will call, for example ["gpt-5.4-mini"]'),
          endpoints: z.array(z.string()).describe('Endpoints you will call, for example ["chat/completions"] or ["generateContent"]'),
        }),
        budget: z.object({
          per_request_usd: z.number().describe('Most one call may cost'),
          daily_usd: z.number().describe('Most per UTC day'),
          total_usd: z.number().describe('Most in all'),
          rate_per_min: z.number().int().describe('Most calls a minute'),
          days: z.number().int().describe('How many days the grant lasts'),
        }),
        replaces_grant: z.number().int().optional().describe('Id of your grant to change, if this asks for new scope or caps'),
        as: z.string().optional().describe('A member you speak for, for example claude-code/main. Leave out for yourself'),
      },
      handler: async args => answer(() => api.request(agent, args)),
    },
    {
      name: 'vault_status',
      description: `Check one of your vault requests: pending, approved, denied or withdrawn. When it is approved, the first call returns your capability handle (pvh_...), once and only to you; keep it in memory, never in files, logs or messages. The handle is not the key and works only through the proxy. ${proxyNote(port)}`,
      inputSchema: {
        request_id: z.number().int().describe('The id vault_request gave you'),
      },
      handler: async ({ request_id }) => answer(() => api.status(agent, request_id)),
    },
  ]
}

export function registerVaultTools(server, agent, api) {
  for (const t of vaultTools(agent, api)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, t.handler)
  }
}
