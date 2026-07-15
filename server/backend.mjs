/**
 * am-i-cited hosted backend — implements the cortex-gateway backend contract
 * (one POST endpoint, plain HTTP JSON-RPC; see
 * github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md).
 *
 * Federated behind a cortex-gateway, this turns the probe into a BYOK
 * multi-user service: each user stores their OWN engine API keys (encrypted
 * per user, see vault.mjs and docs/byok.md), owns their project configs and
 * their results history. The gateway carries the user's real identity
 * (X-Cortex-User-Id from the verified OAuth JWT) — this backend never sees
 * a password and never shares keys between users.
 *
 * Run:  AMICITED_VAULT_KEY=<64 hex> node server/backend.mjs   (port 4930)
 *
 * Trust model: this server binds to loopback and trusts the X-Cortex-*
 * headers, which is correct ONLY behind a cortex-gateway on the same host
 * (the gateway verified the JWT; the technical token gates the catalog).
 * Deploying it any other way requires verifying the propagated JWT here —
 * see docs/byok.md § Deployment.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Vault, ENGINES } from './vault.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA = process.env.AMICITED_DATA_DIR || join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 4930);
const MAX_PROMPTS = 15;
const MAX_RUNS = 3;

const vault = new Vault(DATA); // throws without AMICITED_VAULT_KEY — no fallback

const userDir = (userId) => {
  const d = join(DATA, 'users', createHash('sha256').update(String(userId)).digest('hex'));
  mkdirSync(join(d, 'projects'), { recursive: true });
  mkdirSync(join(d, 'results'), { recursive: true });
  return d;
};

const TOOLS = [
  {
    name: 'get_help', scope: 'mcp:amicited:read', version: '0.2.0',
    description: 'Returns the structured documentation of the am-i-cited backend (BYOK flow, tools, conventions).',
    params: { topic: 'string?' },
  },
  {
    name: 'set_engine_key', scope: 'mcp:amicited:write', version: '0.2.0',
    description: 'Stores YOUR API key for one answer engine (perplexity | openai | anthropic), encrypted at rest, isolated per user. Keys are write-only: no tool ever returns them. Ask the user to paste the key themselves; never invent or reuse a key from elsewhere in the conversation.',
    params: { engine: 'string', api_key: 'string' },
  },
  {
    name: 'get_key_status', scope: 'mcp:amicited:read', version: '0.2.0',
    description: "Shows which engines have a key configured for the calling user (masked: last 4 characters only).",
    params: {},
  },
  {
    name: 'delete_engine_key', scope: 'mcp:amicited:write', version: '0.2.0',
    description: 'Deletes the calling user\'s stored key for one engine.',
    params: { engine: 'string' },
  },
  {
    name: 'set_project', scope: 'mcp:amicited:write', version: '0.2.0',
    description: 'Creates or replaces one of YOUR probe projects. config = { project, domains[], brandAliases[], competitors[{name,domains[]}], prompts[{id,text,intent?,control?}] } — max 15 prompts; include at least one negative control.',
    params: { config: 'object' },
  },
  {
    name: 'list_projects', scope: 'mcp:amicited:read', version: '0.2.0',
    description: 'Lists the calling user\'s probe projects (name, domains, prompt count).',
    params: {},
  },
  {
    name: 'run_probe', scope: 'mcp:amicited:write', version: '0.2.0',
    description: 'Runs the citation probe for one of YOUR projects using YOUR stored engine keys (this spends the user\'s API credits — confirm before running). Returns the score matrix; history accumulates in your results. runs: 1-3 (default 1).',
    params: { project: 'string', runs: 'number?' },
  },
  {
    name: 'get_history', scope: 'mcp:amicited:read', version: '0.2.0',
    description: 'Returns the calling user\'s probe history for a project (most recent rows of the CSV: score, cited_url, intent_match, queries_issued...).',
    params: { project: 'string', limit: 'number?' },
  },
];

function requireScope(ctx, scope) {
  if (!ctx.scopes.includes(scope)) { const e = new Error(`Scope ${scope} required`); e.status = 403; throw e; }
}
function requireUser(ctx) {
  if (!ctx.userId) { const e = new Error('User identity required (X-Cortex-User-Id missing)'); e.status = 401; throw e; }
}
function validProjectName(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name))) throw new Error('project must match [a-z0-9-], max 64 chars');
  return String(name);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('config object required');
  const project = validProjectName(config.project);
  if (!Array.isArray(config.domains) || !config.domains.length) throw new Error('domains[] required');
  if (!Array.isArray(config.prompts) || !config.prompts.length) throw new Error('prompts[] required');
  if (config.prompts.length > MAX_PROMPTS) throw new Error(`max ${MAX_PROMPTS} prompts`);
  for (const p of config.prompts) {
    if (!p.id || !p.text) throw new Error('each prompt needs id and text');
    if (String(p.text).length > 500) throw new Error(`prompt ${p.id}: max 500 chars`);
  }
  return { project, config };
}

function runProbe(userId, project, runs, keys) {
  const dir = userDir(userId);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'am-i-cited.mjs'), project, '--runs', String(runs)], {
      env: {
        ...process.env,
        PERPLEXITY_API_KEY: keys.perplexity ?? '',
        OPENAI_API_KEY: keys.openai ?? '',
        ANTHROPIC_API_KEY: keys.anthropic ?? '',
        AMICITED_PROJECTS_DIR: join(dir, 'projects'),
        AMICITED_RESULTS_DIR: join(dir, 'results'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => { child.kill(); reject(new Error('probe timed out (15 min)')); }, 15 * 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`probe exited ${code}: ${out.slice(-300)}`));
      resolve(out);
    });
  });
}

const handlers = {
  list_tools: () => ({ tools: TOOLS }),
  list_prompts: () => ({ prompts: [] }),
  list_resource_templates: () => ({ resourceTemplates: [] }),
  get_snapshot: () => ({
    backend: 'amicited',
    generatedAt: new Date().toISOString(),
    title: 'am-i-cited — AI citation probe (BYOK)',
    headline: [{ key: 'engines', label: 'Engines', value: ENGINES.length, status: 'green' }],
  }),
  whoami: (_p, ctx) => ({
    email: ctx.email || null,
    role: ctx.role || null,
    capabilities: ctx.scopes.includes('mcp:amicited:write')
      ? TOOLS.map((t) => t.name)
      : TOOLS.filter((t) => t.scope === 'mcp:amicited:read').map((t) => t.name),
  }),
  get_help: (params) => ({
    topic: params.topic ?? 'overview',
    help: 'am-i-cited backend — BYOK AI citation probe. Flow: 1) set_engine_key(engine, api_key) for each engine the user has (keys are write-only, encrypted per user); 2) set_project(config) with 8-15 user-phrased prompts + a negative control; 3) run_probe(project) — spends the USER\'s API credits, always confirm first; 4) get_history(project) for the trend. Methodology (retrieved is not cited, 3 runs, day-0 baseline): https://github.com/wellknownmcp/am-i-cited',
  }),
  set_engine_key: (params, ctx) => {
    requireScope(ctx, 'mcp:amicited:write'); requireUser(ctx);
    return vault.setKey(ctx.userId, String(params.engine ?? ''), params.api_key);
  },
  get_key_status: (_p, ctx) => { requireUser(ctx); return vault.status(ctx.userId); },
  delete_engine_key: (params, ctx) => {
    requireScope(ctx, 'mcp:amicited:write'); requireUser(ctx);
    return vault.deleteKey(ctx.userId, String(params.engine ?? ''));
  },
  set_project: (params, ctx) => {
    requireScope(ctx, 'mcp:amicited:write'); requireUser(ctx);
    const { project, config } = validateConfig(params.config);
    writeFileSync(join(userDir(ctx.userId), 'projects', `${project}.json`), JSON.stringify(config, null, 2));
    return { saved: project, prompts: config.prompts.length };
  },
  list_projects: (_p, ctx) => {
    requireUser(ctx);
    const dir = join(userDir(ctx.userId), 'projects');
    const projects = [];
    for (const f of (existsSync(dir) ? readdirSyncSafe(dir) : [])) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        projects.push({ project: j.project, domains: j.domains, prompts: j.prompts?.length ?? 0 });
      } catch { /* skip unreadable */ }
    }
    return { projects };
  },
  run_probe: async (params, ctx) => {
    requireScope(ctx, 'mcp:amicited:write'); requireUser(ctx);
    const project = validProjectName(params.project);
    const runs = Math.min(Math.max(Number(params.runs ?? 1) || 1, 1), MAX_RUNS);
    if (!existsSync(join(userDir(ctx.userId), 'projects', `${project}.json`))) {
      throw new Error(`Unknown project: ${project} — call set_project first`);
    }
    const keys = vault.keysFor(ctx.userId);
    if (!Object.keys(keys).length) throw new Error('No engine key configured — call set_engine_key first');
    const summary = await runProbe(ctx.userId, project, runs, keys);
    return { project, runs, engines: Object.keys(keys), summary: summary.slice(-2000) };
  },
  get_history: (params, ctx) => {
    requireUser(ctx);
    const project = validProjectName(params.project);
    const limit = Math.min(Number(params.limit ?? 50) || 50, 500);
    const csvPath = join(userDir(ctx.userId), 'results', `${project}.csv`);
    if (!existsSync(csvPath)) return { project, rows: [] };
    const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
    return { project, header: lines[0], rows: lines.slice(1).slice(-limit) };
  },
};

function readdirSyncSafe(dir) { try { return readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; } }

createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/api/cortex/backend') return json(404, { error: 'Not found' });
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'Bearer token required' });

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let rpc;
    try { rpc = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
    const handler = handlers[rpc.method];
    if (!handler) return json(400, { error: `Unknown method: ${rpc.method}` });
    const ctx = {
      userId: req.headers['x-cortex-user-id'] ?? '',
      email: req.headers['x-cortex-user-email'] ?? '',
      role: req.headers['x-cortex-user-role'] ?? '',
      scopes: (req.headers['x-cortex-scopes'] ?? '').split(' ').filter(Boolean),
    };
    try { return json(200, await handler(rpc.params ?? {}, ctx)); }
    catch (err) { return json(err?.status ?? 500, { error: String(err?.message ?? err) }); }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`am-i-cited backend listening on http://127.0.0.1:${PORT}/api/cortex/backend`);
});
