# five9-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Five9** cloud contact center, running on **Cloudflare Workers** with zero dependencies.

Connect Claude (or any MCP-capable AI) to your Five9 domain and it can:

- 📊 read **real-time stats** — agent states, queue depth/wait times, campaign status
- 📞 manage **campaigns** — list, start, stop, reset
- 📋 manage **dialing lists** — list them, push new leads in
- 👤 search **CRM contacts**, list users, skills, and dispositions
- 📈 run **any Five9 report** and pull the result as CSV

Under the hood it speaks Five9's Configuration (admin) and Statistics (supervisor) SOAP Web Services — the APIs that still run Five9's admin surface — and exposes them as clean JSON tools over MCP streamable HTTP.

## Tools

| Tool | What it does |
|------|--------------|
| `check_connection` | Verify Five9 credentials work |
| `list_campaigns` | List campaigns (name, type, state) |
| `control_campaign` | Start / stop / reset a campaign |
| `list_dialing_lists` | List outbound dialing lists + sizes |
| `add_record_to_list` | Push a lead into a dialing list |
| `search_contacts` | Look up CRM contact records by field value |
| `list_users` | List agents/supervisors/admins |
| `list_skills` | List skills (routing queues) |
| `list_dispositions` | List call dispositions |
| `run_report` | Kick off any report by folder + name |
| `get_report_result` | Poll for the report's CSV output |
| `get_realtime_stats` | AgentState, ACDStatus, CampaignState, Inbound/OutboundCampaignStatistics, AgentStatistics |

## Deploy

Requires a Cloudflare account and a Five9 user with API access (Config API access for admin tools, Statistics API access for `get_realtime_stats`).

```sh
git clone https://github.com/ryanshatz/five9-mcp
cd five9-mcp
npx wrangler deploy

# Five9 credentials
npx wrangler secret put FIVE9_USERNAME
npx wrangler secret put FIVE9_PASSWORD

# Strongly recommended: bearer token so only you can reach the server
npx wrangler secret put MCP_AUTH_TOKEN
```

### Region / API version

Defaults are set in `wrangler.toml` and work for US domains:

| Var | Default | Notes |
|-----|---------|-------|
| `FIVE9_API_HOST` | `api.five9.com` | EU: `api.eu.five9.com` · Canada: `api.ca.five9.com` |
| `FIVE9_ADMIN_VERSION` | `v13` | Config Web Services WSDL version |
| `FIVE9_SUPERVISOR_VERSION` | `v13` | Statistics Web Services WSDL version |

## Connect

The MCP endpoint is `https://<your-worker>.workers.dev/mcp` (streamable HTTP, stateless).

**Claude Code:**

```sh
claude mcp add --transport http five9 https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <your MCP_AUTH_TOKEN>"
```

**claude.ai / Claude Desktop:** add a custom connector with that URL. If you set `MCP_AUTH_TOKEN`, use a client that supports custom headers (or leave the token unset and rely on the unguessable Worker URL — not recommended).

## Security notes

- Your Five9 credentials live only as Cloudflare Worker secrets; they are never returned by any tool.
- Set `MCP_AUTH_TOKEN`. Without it, anyone who finds the URL can drive your contact center.
- `control_campaign` and `add_record_to_list` are **write** operations — point the server at a Five9 user whose role matches what you want the AI to be able to do.
- Local dev: put secrets in a `.dev.vars` file (gitignored) and run `npx wrangler dev`.

## Development

```sh
npm run dev      # wrangler dev on http://localhost:8787
npm run deploy   # wrangler deploy
```

No build step, no dependencies — plain JS modules in `src/`:

- `src/index.js` — router + MCP JSON-RPC handler
- `src/five9.js` — SOAP client (envelope builder + minimal XML parser) and Five9 API methods
- `src/tools.js` — MCP tool definitions + dispatch

## License

MIT
