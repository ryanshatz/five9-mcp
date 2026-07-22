// Configuration resolution. Two sources, env wins:
//   1. Wrangler secrets / vars (FIVE9_USERNAME, FIVE9_PASSWORD, MCP_AUTH_TOKEN)
//   2. The KV-stored config written by the in-browser setup wizard (/setup)

const KV_KEY = 'five9-config';

export async function loadConfig(env) {
  let stored = null;
  if (env.CONFIG) {
    try { stored = await env.CONFIG.get(KV_KEY, 'json'); } catch { /* KV unavailable */ }
  }
  const envManaged = Boolean(env.FIVE9_USERNAME || env.FIVE9_PASSWORD);
  const cfg = {
    username: env.FIVE9_USERNAME || stored?.username || '',
    password: env.FIVE9_PASSWORD || stored?.password || '',
    host: env.FIVE9_API_HOST_OVERRIDE || stored?.host || env.FIVE9_API_HOST || 'api.five9.com',
    adminVersion: env.FIVE9_ADMIN_VERSION || 'v13',
    supervisorVersion: env.FIVE9_SUPERVISOR_VERSION || 'v13',
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',
    source: envManaged ? 'env' : (stored ? 'kv' : 'none'),
    hasKv: Boolean(env.CONFIG),
  };
  cfg.configured = Boolean(cfg.username && cfg.password);
  return cfg;
}

export async function saveConfig(env, { username, password, host, authToken }) {
  await env.CONFIG.put(KV_KEY, JSON.stringify({ username, password, host, authToken }));
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
