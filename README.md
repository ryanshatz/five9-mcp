# five9-mcp

An [MCP](https://modelcontextprotocol.io) server for the **Five9** cloud contact center, running on **Cloudflare Workers** with **zero dependencies**.

Connect Claude (or any MCP-capable AI) to your Five9 domain and it becomes a contact-center operations copilot:

- 📊 read **real-time stats** — agent states, queue depth and wait times, campaign status
- 📞 manage **campaigns** — list, inspect, start, stop, reset, attach/detach dialing lists
- 📋 manage **dialing lists** — create, delete, push leads in, pull records out, track async imports
- 👤 work the **CRM** — search contacts, update them, discover the domain's field schema
- 🚫 handle **DNC compliance** — check, add, and remove numbers on the domain Do-Not-Call list
- 📈 run **any Five9 report** and pull the result as CSV
- 🏢 explore the **domain** — users, skills, dispositions, agent groups, IVR scripts, DNIS inventory

Under the hood it speaks Five9's Configuration (admin) and Statistics (supervisor) **SOAP Web Services** — the APIs that still run Five9's admin surface — and exposes them as clean JSON tools over MCP streamable HTTP. Hand-rolled envelopes, a ~60-line XML parser, no npm packages.

Every tool below has been exercised against a live Five9 domain.

## Tools (25)

### Connection & context

| Tool | What it does |
|------|--------------|
| `about` | Operator context for the AI — who runs this server and the ground rules ([customize it](#customizing-the-operator-context)) |
| `check_connection` | Verify Five9 credentials work; returns visible skill count |

### Campaigns

| Tool | What it does |
|------|--------------|
| `list_campaigns` | List campaigns (name, type, state, mode), optional name regex |
| `inspect_campaign` | One call: campaign state + attached lists (outbound) + DNIS (inbound) |
| `control_campaign` | Start / stop / reset a campaign ✏️ |
| `manage_campaign_lists` | Attach or detach a dialing list, with dialing priority ✏️ |

### Dialing lists & leads

| Tool | What it does |
|------|--------------|
| `list_dialing_lists` | List outbound dialing lists + record counts |
| `create_list` | Create a new empty dialing list ✏️ |
| `delete_list` | Delete a dialing list (CRM contacts untouched) ✏️ |
| `add_record_to_list` | Push a lead into a dialing list (async Five9 import) ✏️ |
| `delete_record_from_list` | Remove matching records from a list (CRM contacts untouched) ✏️ |
| `get_import_result` | Check the outcome of an async list/CRM import by identifier |

### CRM contacts

| Tool | What it does |
|------|--------------|
| `search_contacts` | Look up contact records by exact field values |
| `update_contact` | Update an existing contact; defaults to sole-match safety ✏️ |
| `list_contact_fields` | Discover the domain's contact field schema (names, types) |

### Compliance

| Tool | What it does |
|------|--------------|
| `manage_dnc` | Check / add / remove numbers on the domain Do-Not-Call list ✏️ |

### Domain configuration

| Tool | What it does |
|------|--------------|
| `list_users` | List agents / supervisors / admins, optional username regex |
| `list_skills` | List skills (routing queues) |
| `list_dispositions` | List call dispositions and their settings |
| `list_agent_groups` | List agent groups and their members |
| `list_ivr_scripts` | List IVR scripts (metadata only — XML bodies omitted) |
| `list_dnis` | List provisioned inbound numbers; optionally only unassigned |

### Reporting & real-time

| Tool | What it does |
|------|--------------|
| `run_report` | Kick off any report by folder + name, optional time range |
| `get_report_result` | Poll for the report's CSV output |
| `get_realtime_stats` | `AgentState`, `ACDStatus`, `CampaignState`, `InboundCampaignStatistics`, `OutboundCampaignStatistics`, `AgentStatistics` |

✏️ = write operation. The server tells connected AIs (via MCP `instructions` and the `about` tool) to confirm with the user before writes that affect live dialing.

## Deploy

Requires a Cloudflare account and a Five9 user with API access (Config API access for admin tools, Statistics API access for `get_realtime_stats`). **Create a dedicated Five9 API user** with only the permissions you want the AI to have — don't reuse a personal admin login.

```sh
git clone https://github.com/ryanshatz/five9-mcp
cd five9-mcp
npx wrangler deploy

# Five9 credentials
npx wrangler secret put FIVE9_USERNAME
npx wrangler secret put FIVE9_PASSWORD

# Required for auth (bearer token AND the OAuth access key)
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

**claude.ai / Claude Desktop (OAuth):** add a custom connector pointing at the URL above. The client discovers the built-in OAuth server automatically; when the consent screen appears, paste your `MCP_AUTH_TOKEN` as the access key. No client secrets, no extra infrastructure.

**Claude Code (bearer token):**

```sh
claude mcp add --transport http five9 https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer <your MCP_AUTH_TOKEN>"
```

Both paths work simultaneously: the raw token is always accepted as a bearer credential, and OAuth-minted tokens are validated against the same secret.

### How the OAuth flow works

`src/oauth.js` implements a minimal OAuth 2.1 authorization server (metadata discovery, dynamic client registration, PKCE S256, refresh tokens) designed for a **single-operator** deployment:

- The "login" on the consent screen is the server's access key (`MCP_AUTH_TOKEN`).
- Everything is stateless — client IDs, auth codes, and tokens are HMAC-SHA256-signed blobs keyed by `MCP_AUTH_TOKEN`. No KV, no Durable Objects.
- Revoke everything at once by rotating `MCP_AUTH_TOKEN` (`npx wrangler secret put MCP_AUTH_TOKEN`).

## Customizing the operator context

`src/about.js` holds the text served to connected AI models via the MCP `instructions` field and the `about` tool: who operates the server, why it exists, and how the AI should behave (e.g. "confirm before write actions"). **Edit it to describe your own deployment** — it ships with the original operator's context as an example.

## Architecture

No build step, no dependencies — plain JS modules in `src/`:

```
src/
├── index.js   # router, CORS, MCP JSON-RPC handler (initialize / tools/list / tools/call)
├── five9.js   # SOAP client: envelope builder, ~60-line XML parser, one method per Five9 op
├── tools.js   # MCP tool definitions (JSON Schema) + dispatch
├── oauth.js   # stateless OAuth 2.1 server (single-operator model)
└── about.js   # operator context — edit this for your deployment
```

Requests are stateless: every MCP call opens a fresh Five9 SOAP exchange with HTTP Basic auth. The Statistics API additionally requires a `setSessionParameters` call, which `get_realtime_stats` performs on every invocation.

### Notes on Five9's SOAP API (learned the hard way)

- Five9's endpoints are generated by JAXB and **validate child-element order** against the WSDL sequence. If you extend this server, pull the WSDL (`https://api.five9.com/wsadmin/v13/AdminWebService?wsdl`, HTTP Basic auth) and match the `<xs:sequence>` order exactly — including base types like `basicImportSettings`, whose elements come *before* the extension's.
- `addToListCsv` requires `cleanListBeforeUpdate`, `crmAddMode`, `crmUpdateMode`, and `listAddMode` even though the WSDL marks most of them `minOccurs="0"`.
- List/CRM imports are **asynchronous**: the call returns an import identifier immediately; poll `get_import_result` for the actual outcome.
- Contact record values come back wrapped (`<values><data>…</data></values>`); several response shapes return a single object where you'd expect a one-element array. `toArray()` in `five9.js` normalizes this.
- Report time criteria order is `<end>` **before** `<start>` (JAXB alphabetical ordering).

## Security

- Five9 credentials live only as Cloudflare Worker secrets; no tool ever returns them.
- Always set `MCP_AUTH_TOKEN`. Without it the server runs **open** — anyone who finds the URL can drive your contact center.
- Half the tools are writes (marked ✏️ above). Scope the Five9 API user's role to what you actually want an AI to be able to do; Five9 permissions are the real security boundary.
- `manage_dnc remove` and `delete_list` deserve extra caution — the `about` instructions tell AIs to confirm before using them.

## Development

```sh
npm run dev      # wrangler dev on http://localhost:8787
npm run deploy   # wrangler deploy
```

Put local secrets in `.dev.vars` (gitignored):

```ini
FIVE9_USERNAME=apiuser@yourdomain
FIVE9_PASSWORD=...
MCP_AUTH_TOKEN=dev-local-token
```

`GET /` serves a human-readable info page listing every tool; `GET /health` is a JSON healthcheck.

Smoke-test a tool from the CLI:

```sh
curl -s -X POST http://localhost:8787/mcp \
  -H "Authorization: Bearer dev-local-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_connection","arguments":{}}}'
```

## Contributing

PRs welcome. The Five9 Config API has ~180 operations and this server wraps 25 of the most useful — if you need another one, the pattern in `five9.js` + `tools.js` is easy to extend (see the SOAP notes above before you fight the WSDL yourself). Please keep the zero-dependency constraint.

## License

MIT
