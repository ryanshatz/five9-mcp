// five9-mcp — an MCP server (streamable HTTP, stateless) for the Five9 cloud
// contact center, running on Cloudflare Workers with zero dependencies.

import { Five9Error } from './five9.js';
import { toolDefs, callTool } from './tools.js';
import { handleOAuth, checkAuth, unauthorized } from './oauth.js';
import { INSTRUCTIONS } from './about.js';
import { landingPage, consolePage } from './ui.js';

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

    if (request.method === 'GET' && path === '/') return html(landingPage(toolDefs()));
    if (request.method === 'GET' && path === '/console') return html(consolePage(toolDefs()));
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

function html(markup) {
  return new Response(markup, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
