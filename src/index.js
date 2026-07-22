// five9-mcp — an MCP server (streamable HTTP, stateless) for the Five9 cloud
// contact center, running on Cloudflare Workers with zero dependencies.

import { Five9Error } from './five9.js';
import { toolDefs, callTool } from './tools.js';
import { handleOAuth, checkAuth, unauthorized } from './oauth.js';
import { INSTRUCTIONS } from './about.js';

const SERVER_INFO = { name: 'five9-mcp', version: '0.2.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const res = await route(request, env);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  },
};

async function route(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

    const oauthRes = await handleOAuth(request, env, url);
    if (oauthRes) return oauthRes;

    if (request.method === 'GET' && path === '/') return infoPage();
    if (request.method === 'GET' && path === '/health') return json({ ok: true, server: SERVER_INFO });

    if (path === '/' || path === '/mcp') {
      if (request.method !== 'POST') {
        return json({ error: 'MCP requests must be POSTed to /mcp' }, 405);
      }
      if (!(await checkAuth(request, env))) return unauthorized(url.origin);
      let body;
      try { body = await request.json(); } catch {
        return json(rpcError(null, -32700, 'Parse error: body must be JSON'), 400);
      }
      if (Array.isArray(body)) {
        const results = (await Promise.all(body.map((m) => handleMessage(m, env)))).filter(Boolean);
        return results.length ? json(results) : new Response(null, { status: 202 });
      }
      const result = await handleMessage(body, env);
      return result ? json(result) : new Response(null, { status: 202 });
    }

    return json({ error: 'Not found' }, 404);
}

async function handleMessage(msg, env) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
  }
  const { id, method, params } = msg;

  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolDefs() });
      case 'tools/call': {
        const name = params?.name;
        try {
          const result = await callTool(env, name, params?.arguments);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          if (e instanceof Five9Error || e.message?.startsWith('Unknown tool')) {
            return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
          throw e;
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function infoPage() {
  const tools = toolDefs().map((t) => {
    const short = t.description.replace(/e\.g\./g, '§').split('. ')[0].replace(/§/g, 'e.g.').replace(/\.$/, '');
    return `<li><code>${t.name}</code> — ${short}.</li>`;
  }).join('\n');
  return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>five9-mcp</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1.25rem;line-height:1.6;color:#1a2332}
  code{background:#eef1f5;padding:.1em .35em;border-radius:4px;font-size:.9em}
  h1{letter-spacing:-.02em} li{margin:.35em 0}
  @media (prefers-color-scheme:dark){body{background:#0f141b;color:#dbe2ea}code{background:#1e2733}}
</style></head><body>
<h1>five9-mcp</h1>
<p>An MCP server for the <strong>Five9</strong> cloud contact center. Connect an AI model to this
Worker and it can manage campaigns, dialing lists, contacts, and reports, and read real-time
agent &amp; queue stats.</p>
<p><strong>Endpoint:</strong> <code>POST /mcp</code> (MCP streamable HTTP). If the operator set
<code>MCP_AUTH_TOKEN</code>, send <code>Authorization: Bearer &lt;token&gt;</code>.</p>
<h2>Tools</h2>
<ul>${tools}</ul>
<p>Source &amp; setup: <a href="https://github.com/ryanshatz/five9-mcp">github.com/ryanshatz/five9-mcp</a></p>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
