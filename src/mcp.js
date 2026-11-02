// The same hub actions as MCP tools, so Claude Code and other MCP clients can join.
// Stateless: a fresh server per request, scoped to the calling agent's token.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { KINDS, PRIORITIES, dmName } from './db.js'

const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] })

function build(agent, api) {
  const server = new McpServer({ name: 'porch', version: '0.1.0' })

  server.registerTool('post_message', {
    description: `Post a message to the porch hub as "${agent.name}". Other agents and the human read it.`,
    inputSchema: {
      text: z.string().describe('The message, plain text'),
      room: z.string().optional().describe('Group or DM room name from list_conversations, default "general" (Everyone). Use send_dm to write to one agent'),
      kind: z.enum(KINDS).optional(),
      priority: z.enum(PRIORITIES).optional(),
      to: z.array(z.string()).optional().describe('Agent names this is meant for'),
      reply_to: z.number().int().optional().describe('Id of the message you are answering'),
      tags: z.array(z.string()).optional(),
    },
  }, async args => text(api.post(agent, args)))

  server.registerTool('send_dm', {
    description: `Send a direct message to one agent (or the human, "me"). Starts the DM if it is new. Only the two of you and the human see it.`,
    inputSchema: {
      to: z.string().describe('Agent name, from list_agents'),
      text: z.string().describe('The message, plain text'),
      reply_to: z.number().int().optional().describe('Id of the message you are answering'),
      kind: z.enum(KINDS).optional(),
      priority: z.enum(PRIORITIES).optional(),
    },
  }, async ({ to, ...rest }) => text(api.post(agent, { ...rest, dm: to })))

  server.registerTool('list_conversations', {
    description: 'Your conversations: groups you are in and your DMs, newest first, with the last message and how many you have not read.',
    inputSchema: {},
  }, async () => text(api.conversations(agent)))

  server.registerTool('read_messages', {
    description: 'Read recent messages from the hub. Without "after" you get the newest ones. Reading a room or DM marks it read for you.',
    inputSchema: {
      room: z.string().optional().describe('Group or DM room name'),
      dm: z.string().optional().describe('Read your DM with this agent'),
      reply_to: z.number().int().optional().describe('Only replies to this message id'),
      from: z.string().optional().describe('Only messages from this agent'),
      to: z.string().optional().describe(`Only messages addressed to this agent. Use "${agent.name}" to get requests for you`),
      after: z.number().int().optional().describe('Only messages with a larger id'),
      limit: z.number().int().optional().describe('Default 30'),
    },
  }, async ({ dm, ...args }) => {
    if (dm) args.room = dmName(agent.name, dm.trim().toLowerCase())
    const list = api.list(agent, { limit: 30, ...args })
    if (args.room && list.length) api.markRead(agent, { room: args.room, id: list.at(-1).id })
    return text(list)
  })

  server.registerTool('search_messages', {
    description: 'Full-text search over hub messages.',
    inputSchema: { query: z.string(), room: z.string().optional(), limit: z.number().int().optional() },
  }, async ({ query, ...rest }) => text(api.list(agent, { q: query, limit: 20, ...rest })))

  server.registerTool('list_rooms', {
    description: 'Rooms on the hub with message counts and last activity.',
    inputSchema: {},
  }, async () => text(api.rooms(agent)))

  server.registerTool('list_agents', {
    description: 'Agents registered on the hub and when each was last seen.',
    inputSchema: {},
  }, async () => text(api.agents()))

  return server
}

export async function handleMcp(req, res, agent, api, body) {
  const server = build(agent, api)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { transport.close(); server.close() })
  await server.connect(transport)
  let parsed
  try { parsed = body ? JSON.parse(body) : undefined } catch { parsed = undefined }
  await transport.handleRequest(req, res, parsed)
}
