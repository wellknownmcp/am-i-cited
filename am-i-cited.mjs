#!/usr/bin/env node
/**
 * am-i-cited — AI citation probe.
 *
 * Measures whether AI answer engines (Perplexity, ChatGPT via the OpenAI API,
 * Claude via the Anthropic API) CITE your domains when a user asks about the
 * problem your product solves. Multi-project, bring-your-own-keys,
 * zero-dependency (Node 18+, global fetch).
 *
 * Usage:
 *   node am-i-cited.mjs <project> [--runs N] [--engines perplexity,openai,anthropic]
 *
 * Project config: projects/<project>.json
 *   { project, domains[], brandAliases[], competitors[{name,domains[]}],
 *     prompts[{id,text,control?}] }
 *
 * Keys: .env next to this script (PERPLEXITY_API_KEY, OPENAI_API_KEY,
 * ANTHROPIC_API_KEY; optional model overrides PERPLEXITY_PROBE_MODEL,
 * OPENAI_PROBE_MODEL, ANTHROPIC_PROBE_MODEL). An engine without a key is
 * skipped, not fatal.
 *
 * Output: appends to results/<project>.csv
 *   date,prompt_id,engine,run,score,cited_url,cited_text,intent_match,
 *   competitor_url,queries_issued,note
 * Scoring: 2 cited (your domain appears in the answer's citations) |
 *          1 mentioned without a link | 0 absent |
 *          -1 a competitor is cited and you are not.
 *
 * Beyond the score, the probe captures HOW the engine handled the intent:
 * - queries_issued: the web-search queries the engine actually ran for the
 *   user prompt (its translation of the intent — the fan-out). Exposed by
 *   OpenAI (web_search_call.action.query) and Anthropic (server_tool_use
 *   input.query); not exposed by Perplexity.
 * - cited_text: the passage associated with your citation (Anthropic: the
 *   source excerpt that was cited; OpenAI: the answer span the citation
 *   supports; Perplexity: not exposed).
 * - intent_match: LLM-judged verdict (yes/partial/no) — does the cited
 *   material genuinely address the user's intent, or is it a drive-by
 *   mention? Runs only when you are cited (score 2) and ANTHROPIC_API_KEY
 *   is set; one extra small call per cited result.
 *
 * Methodology notes (read README.md):
 * - The API surface is a TREND instrument, not a consumer-surface snapshot
 *   (no personalization, different ranking than chatgpt.com/claude.ai).
 *   Compare day-0 vs day-30 over 3 runs; never conclude from a single run.
 * - Retrieved is not cited: only citations attached to the answer text score
 *   a 2. Search results the model fetched but did not attribute do not count.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error(...a);

// ─── env ───────────────────────────────────────────────────────────────────
try {
  for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env: rely on the process environment */ }

// ─── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith('--'));
if (!project) { log('Usage: node am-i-cited.mjs <project> [--runs N] [--engines a,b,c]'); process.exit(1); }
const runs = Number.parseInt(args[args.indexOf('--runs') + 1] ?? '1', 10) || 1;
const enginesArg = args.includes('--engines') ? args[args.indexOf('--engines') + 1].split(',') : null;

// Directory overrides — used by the hosted backend (server/backend.mjs) to
// isolate each user's projects and results; default to the repo layout.
const PROJECTS_DIR = process.env.AMICITED_PROJECTS_DIR || join(HERE, 'projects');
const RESULTS_DIR = process.env.AMICITED_RESULTS_DIR || join(HERE, 'results');

const cfg = JSON.parse(readFileSync(join(PROJECTS_DIR, `${project}.json`), 'utf8'));

// ─── helpers ───────────────────────────────────────────────────────────────
function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
function matchDomain(url, domains) {
  const h = hostnameOf(url);
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  return domains.some((d) => {
    const dl = d.toLowerCase();
    if (dl.includes('/')) { // e.g. github.com/your-org — match host + path prefix
      const [dh, ...rest] = dl.split('/');
      return (h === dh || h.endsWith('.' + dh)) && path.startsWith('/' + rest.join('/'));
    }
    return h === dl || h.endsWith('.' + dl);
  });
}
function score({ text, citedUrls, citedSpans = [] }, cfg) {
  const ours = citedUrls.find((u) => matchDomain(u, cfg.domains));
  if (ours) {
    const span = citedSpans.find((s) => matchDomain(s.url, cfg.domains));
    return { score: 2, cited_url: ours, cited_text: (span?.text ?? '').slice(0, 300), competitor_url: '' };
  }
  const lower = text.toLowerCase();
  const mentioned = (cfg.brandAliases ?? []).some((a) => lower.includes(a.toLowerCase()));
  let competitor = '';
  for (const c of cfg.competitors ?? []) {
    const hit = citedUrls.find((u) => matchDomain(u, c.domains));
    if (hit) { competitor = hit; break; }
  }
  if (mentioned) return { score: 1, cited_url: '', cited_text: '', competitor_url: competitor };
  if (competitor) return { score: -1, cited_url: '', cited_text: '', competitor_url: competitor };
  return { score: 0, cited_url: '', cited_text: '', competitor_url: '' };
}

// Judge: is the citation actually answering the user's intent? One small
// Anthropic call, no web search. Returns 'yes' | 'partial' | 'no' | ''.
async function judgeIntentMatch(intent, citedText, answerText) {
  if (!process.env.ANTHROPIC_API_KEY) return '';
  try {
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      {
        model: process.env.ANTHROPIC_PROBE_MODEL || 'claude-opus-4-8',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are auditing an AI answer engine for citation quality.

The user's intent: "${intent}"

The engine's answer cited OUR page. The material associated with the citation:
"${citedText || '(no passage captured — judge from the answer excerpt below)'}"

Answer excerpt:
"${answerText.slice(0, 1500)}"

Question: does the cited material genuinely address the user's intent, or is it a drive-by / off-topic mention? Reply with exactly one word: yes, partial, or no.`,
        }],
      });
    const verdict = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().toLowerCase();
    return ['yes', 'partial', 'no'].find((v) => verdict.startsWith(v)) ?? '';
  } catch { return ''; }
}
async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ─── engines ───────────────────────────────────────────────────────────────
const ENGINES = {
  // Perplexity Sonar — citations are native in the response
  perplexity: {
    key: 'PERPLEXITY_API_KEY',
    async ask(prompt) {
      const j = await post('https://api.perplexity.ai/chat/completions',
        { authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}` },
        { model: process.env.PERPLEXITY_PROBE_MODEL || 'sonar', messages: [{ role: 'user', content: prompt }] });
      const text = j.choices?.[0]?.message?.content ?? '';
      const citedUrls = [
        ...(j.citations ?? []),
        ...((j.search_results ?? []).map((r) => r.url)),
      ].filter(Boolean);
      // Perplexity exposes neither the issued queries nor cited passages
      return { text, citedUrls, queries: [], citedSpans: [] };
    },
  },
  // OpenAI Responses API + web_search — url_citation annotations
  openai: {
    key: 'OPENAI_API_KEY',
    async ask(prompt) {
      const j = await post('https://api.openai.com/v1/responses',
        { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        { model: process.env.OPENAI_PROBE_MODEL || 'gpt-5-mini', tools: [{ type: 'web_search' }], input: prompt });
      let text = ''; const citedUrls = []; const queries = []; const citedSpans = [];
      for (const item of j.output ?? []) {
        if (item.type === 'web_search_call' && item.action?.query) queries.push(item.action.query);
        if (item.type !== 'message') continue;
        for (const c of item.content ?? []) {
          if (c.type !== 'output_text') continue;
          text += c.text ?? '';
          for (const a of c.annotations ?? []) {
            if (a.type !== 'url_citation' || !a.url) continue;
            citedUrls.push(a.url);
            // the answer span this citation supports (start/end index into c.text)
            if (Number.isInteger(a.start_index) && Number.isInteger(a.end_index)) {
              citedSpans.push({ url: a.url, text: (c.text ?? '').slice(a.start_index, a.end_index) });
            }
          }
        }
      }
      return { text, citedUrls, queries, citedSpans };
    },
  },
  // Anthropic Messages + web_search — citations attached to text blocks
  anthropic: {
    key: 'ANTHROPIC_API_KEY',
    async ask(prompt) {
      const j = await post('https://api.anthropic.com/v1/messages',
        { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        {
          model: process.env.ANTHROPIC_PROBE_MODEL || 'claude-opus-4-8',
          max_tokens: 2048,
          tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
          messages: [{ role: 'user', content: prompt }],
        });
      let text = ''; const citedUrls = []; const queries = []; const citedSpans = [];
      for (const block of j.content ?? []) {
        if (block.type === 'server_tool_use' && block.name === 'web_search' && block.input?.query) {
          queries.push(block.input.query);
        }
        if (block.type !== 'text') continue; // web_search_tool_result = retrieved, not cited
        text += block.text ?? '';
        for (const c of block.citations ?? []) {
          if (!c.url) continue;
          citedUrls.push(c.url);
          // cited_text = the excerpt of the SOURCE page that was cited
          if (c.cited_text) citedSpans.push({ url: c.url, text: c.cited_text });
        }
      }
      return { text, citedUrls, queries, citedSpans };
    },
  },
};

// ─── run ───────────────────────────────────────────────────────────────────
const engines = (enginesArg ?? Object.keys(ENGINES)).filter((e) => {
  if (!ENGINES[e]) { log(`⚠️ unknown engine: ${e}`); return false; }
  if (!process.env[ENGINES[e].key]) { log(`⚠️ ${e} skipped (${ENGINES[e].key} not set)`); return false; }
  return true;
});
if (!engines.length) { log('❌ no usable engine — fill in .env (see .env.example)'); process.exit(1); }

const date = new Date().toISOString().slice(0, 10);
mkdirSync(RESULTS_DIR, { recursive: true });
const csvPath = join(RESULTS_DIR, `${cfg.project}.csv`);
if (!existsSync(csvPath)) {
  writeFileSync(csvPath, 'date,prompt_id,engine,run,score,cited_url,cited_text,intent_match,competitor_url,queries_issued,note\n');
}
const csv = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const MARK = { yes: '✓', partial: '~', no: '✗' };

const matrix = {};
for (let run = 1; run <= runs; run++) {
  for (const p of cfg.prompts) {
    for (const engine of engines) {
      let row;
      try {
        const answer = await ENGINES[engine].ask(p.text);
        const s = score(answer, cfg);
        // intent_match: only meaningful when we are cited; judged against the
        // config's `intent` field when present, else the prompt itself
        const intent_match = s.score === 2
          ? await judgeIntentMatch(p.intent ?? p.text, s.cited_text, answer.text)
          : '';
        const note = p.control && s.score !== 0 ? 'NEGATIVE CONTROL SCORED — probe may be biased' : '';
        row = {
          score: s.score, cited_url: s.cited_url, cited_text: s.cited_text, intent_match,
          competitor_url: s.competitor_url, queries_issued: answer.queries.join(' | ').slice(0, 300), note,
        };
      } catch (err) {
        row = { score: '', cited_url: '', cited_text: '', intent_match: '', competitor_url: '', queries_issued: '', note: `ERROR: ${err.message.slice(0, 120)}` };
      }
      appendFileSync(csvPath, [date, p.id, engine, run, row.score, row.cited_url, row.cited_text, row.intent_match, row.competitor_url, row.queries_issued, row.note].map(csv).join(',') + '\n');
      const cell = row.score === '' ? 'ERR' : `${row.score}${MARK[row.intent_match] ?? ''}`;
      (matrix[p.id] ??= {})[engine + (runs > 1 ? `#${run}` : '')] = cell;
      log(`  ${p.id} × ${engine} (run ${run}) → ${cell}${row.cited_url ? ' ✓ ' + row.cited_url : ''}${row.competitor_url ? ' ⚔ ' + row.competitor_url : ''}${row.queries_issued ? `\n      fan-out: ${row.queries_issued}` : ''}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// ─── summary ───────────────────────────────────────────────────────────────
log(`\n=== am-i-cited: ${cfg.project} — ${date} (2 cited · 1 mentioned · 0 absent · -1 competitor · ✓/~/✗ intent match) ===`);
const cols = [...new Set(Object.values(matrix).flatMap((r) => Object.keys(r)))];
log(['prompt'.padEnd(8), ...cols.map((c) => c.padEnd(14))].join(''));
for (const [pid, row] of Object.entries(matrix)) {
  log([pid.padEnd(8), ...cols.map((c) => String(row[c] ?? '-').padEnd(14))].join(''));
}
log(`\nCSV → ${csvPath}`);
