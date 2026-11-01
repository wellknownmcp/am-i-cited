# am-i-cited

**Do AI assistants recommend you to someone who has your problem?** Search
consoles measure impressions; analytics measure referrers. Neither answers
that question — a site can have zero clicks and be cited by ChatGPT, or the
reverse. `am-i-cited` measures the thing itself: it asks Perplexity, ChatGPT
(OpenAI API), Claude (Anthropic API), Grok (xAI API) and Muse (Meta Model API)
the questions your users actually ask, and records whether **your domain shows
up in the answer's citations**.

Open source (MIT), bring-your-own-keys, zero dependencies — one Node 18+
script, a JSON config per project, a CSV of history. You pay the providers
directly for what the probe uses. Web search makes these calls costlier than
plain chat, so start with one run and a dedicated, budget-capped key.

## Quick start

```bash
git clone https://github.com/wellknownmcp/am-i-cited
cd am-i-cited
cp .env.example .env      # add the key(s) you have — missing engines are skipped
node am-i-cited.mjs example --runs 3
```

Useful flags:

```bash
node am-i-cited.mjs example --engines perplexity,anthropic   # only these engines
node am-i-cited.mjs example --prompts P06,P08                # re-run a subset
```

Output: a score matrix on stderr, and one CSV row per (date, prompt, engine,
run) appended to `results/<project>.csv`:

```csv
date,prompt_id,engine,run,score,cited_url,cited_text,intent_match,competitor_url,queries_issued,note,our_url_retrieved
2026-07-15,P02,anthropic,1,2,https://cortex-gateway.dev/guides/rest-api-to-mcp-server/,"Expose your REST API as an MCP server...",yes,,turn REST API into MCP server | REST API MCP wrapper,,yes
2026-07-15,P06,openai,1,-1,,,,https://github.com/some/competitor,best open source MCP gateway self hosted,,
2026-07-15,P04,perplexity,1,0,,,,,,,no
```

In the matrix, `✓` / `~` / `✗` after a score is the intent verdict, `BLIND`
is a failed canary, and `ERR` is an API failure (empty `score`, the reason in
`note`). Timeouts, 429s and 5xx are retried once. CSVs created before
`our_url_retrieved` existed get a new header on the next run; their old rows
keep one fewer field.

## Scoring

| Score | Meaning | What it tells you |
|---|---|---|
| `2` | Your domain appears in the answer's **citations** | You are the answer. The only result that counts. |
| `1` | Your brand is **mentioned** without a link | The model knows you (entity/corpus) but does not retrieve you. Lever: indexing and freshness. |
| `0` | Absent | Nobody owns this intent — or you don't. A recurring `0` where *no one* is cited is the best opportunity in the file. |
| `-1` | A **competitor** is cited and you are neither cited nor mentioned | Their page beats yours (or yours doesn't exist). `competitor_url` is the brief for the page to write. |

A `1` can also carry a `competitor_url`: you were named, but they got the link.

## Why the score is bad: findability vs preference

`our_url_retrieved` records whether your domain was in the engine's search
results, independently of whether it was cited:

- **`no` — a findability problem.** The engine never saw your page. Work on
  indexing, freshness, internal links and sitemaps, not on rewriting the page.
- **`yes` without a citation — a preference problem.** The engine saw your
  page and chose another passage. Work on the format (a "best X" intent wants
  a comparison, not a product page), the passage and the freshness date.
- **empty — unknown.** The engine doesn't expose its results, or returned none
  for that answer. Don't infer anything from it.

## Beyond the score: intent capture

Being cited is worthless if the engine translated the user's intent into
something you don't answer, or if your citation is a drive-by mention. Three
columns capture this:

- **`queries_issued`** — the web-search queries the engine actually ran for
  the prompt: its *translation* of the user intent (the fan-out). If
  "give each agent the user's own permissions" fans out into "API key
  management", you now know *which* sub-intent you are losing — far more
  actionable than a bare `0`.
- **`cited_text`** — the passage associated with your citation. This tells
  you *which* section of your page does the work (and which sections never
  get cited).
- **`intent_match`** — an LLM-judged verdict (`yes` / `partial` / `no`):
  does the cited material genuinely address the user's intent? Judged only
  when you are cited (score `2`), using your Anthropic key (one extra small
  call; left empty without that key). A `2/no` is a vanity citation; treat it
  like a `0` with better PR. Give the judge a cleaner target by adding an
  optional `"intent"` field to a prompt ("user wants per-user authorization
  for AI agents, not shared keys") — it falls back to the prompt text
  otherwise.

What each engine exposes:

| Engine | `queries_issued` | `cited_text` | `our_url_retrieved` |
|---|---|---|---|
| `openai` | ✅ `web_search_call.action.query` | ✅ the answer span the citation supports | ❌ not exposed |
| `anthropic` | ✅ `server_tool_use` input | ✅ the excerpt of *your page* that was cited | ✅ `web_search_tool_result` |
| `grok` | ❌ not exposed today (captured if xAI adds it) | ✅ the answer span the citation supports | ❌ not exposed |
| `muse` | ❌ not documented (captured if exposed) | ✅ the answer span the citation supports | ✅ `web_search_call.results` |
| `perplexity` | ❌ not exposed | ❌ not exposed | ⚠️ `search_results`, `no` only (see [Methodology](#methodology--read-this-before-trusting-the-numbers)) |

## Writing a project config

Copy `projects/example.json`. Rules that make the measurement honest:

- **8–15 prompts, phrased as the user would phrase them, never containing
  your brand.** A prompt with your name in it measures notoriety, not
  citation.
- Include one or two **negative controls** (`"control": true`): an intent you
  deliberately do not cover. If a control scores non-zero, the probe is
  biased — the script flags it in the `note` column.
- Include at least one **positive control, or canary**
  (`"expect_citations": true`): a prompt whose answer must cite something on
  a healthy engine, such as a question about a recent release. Zero citations
  there shows as `BLIND` in the matrix and `CANARY FAILED` in `note`. It can
  also mean the engine answered from memory, so check before concluding the
  capture is broken. `projects/example.json` doesn't include one yet: add it
  to your copy.
- `domains` are yours (a `github.com/your-org/repo` path form is supported);
  `competitors` carry the domains whose citations you want to track.

```json
{ "id": "C02", "text": "What changed in the latest stable Node.js release?", "expect_citations": true }
```

## Methodology — read this before trusting the numbers

- **The API surface is a trend instrument, not a consumer-surface snapshot.**
  API calls have no account personalization and may rank differently from
  chatgpt.com or claude.ai. For "did we improve between day 0 and day 30",
  the API is valid and automatable; for "what does a user see right now",
  nothing replaces a clean manual session.
- **A 0 only counts if the sensor is alive.** On 2026-08-19 this probe wrote
  26 plausible zeros while a `web_search` variant change had silently removed
  every citation. That is why canaries exist, and why an engine with zero
  citations across a whole run gets a loud warning in the summary: its scores
  are blindness, not absence.
- **Retrieved is not cited.** Engines fetch far more URLs than they
  attribute. On `openai`, `anthropic`, `grok` and `muse`, only citations
  attached to the answer text score a `2`.
- **Perplexity is the exception: read its scores as "retrieved".** Its `2` and
  `-1` also count URLs that appear only in `search_results`, which keeps scores
  comparable with older baselines. So it can overstate citations, and it can
  never report `our_url_retrieved = yes` without a `2`: no preference problem
  will show up on this engine. In one 99-answer sample, about 46% of
  `search_results` URLs had no matching `[n]` marker in the answer text
  (assuming markers follow the list order).
- **Never conclude from a single run.** Answer engines rotate sources
  constantly while the *direction* stays stable. Run 3 passes (`--runs 3`),
  look at the trend across dates.
- **Baseline first.** Run the probe *before* publishing new pages (day 0),
  again at day 30. Without a baseline there is no attribution.

## Engines

| Engine | API | Default model | Citations come from |
|---|---|---|---|
| `perplexity` | `chat/completions` | `sonar` | `citations[]` + `search_results[]` in the response |
| `openai` | Responses API + `web_search` tool | `gpt-6-astra` | `url_citation` annotations on output text |
| `anthropic` | Messages API + `web_search` tool | `claude-opus-5-5` | `citations[]` on text blocks (tool results are retrieved, not cited) |
| `grok` | xAI Responses API + `web_search` tool | `grok-4.7` | `url_citation` annotations on output text |
| `muse` | Meta Model API (Responses) + `web_search` tool | `muse-spark-1.3` | `url_citation` annotations on output text |

Override models via `*_PROBE_MODEL` env vars. Engines whose key is absent, or
still a template placeholder, are skipped, so you can start with a single key.
Defaults move with new releases and the CSV doesn't record the model: pin
`*_PROBE_MODEL` to keep a trend comparable with an earlier baseline.

The `muse` connector follows Meta's documentation and passes a mocked test, but
hasn't run against the live API yet: use a canary on your first run. Check that
the Meta Model API is available in your region too.

### Adding an engine

An engine is one entry in the `ENGINES` object of `am-i-cited.mjs`: the env var
holding its key, and an `ask(prompt)` function returning
`{ text, citedUrls, queries, citedSpans, retrievedUrls }`. If the provider has
a Responses-style API with `url_citation` annotations, the entry is a few lines:
copy `muse` and pass the response to `parseResponsesOutput`.

The API must return a **written answer with structured citations**. A search
API that only returns pages measures a search engine, not an answer engine, and
an answer without citations can only ever score `1`, `0` or `-1`. Validate any
new engine with a canary before trusting its zeros.

Kimi, for example, isn't built in: its citation format still has to be confirmed
against a live `$web_search` response. In hosted mode, a new engine must also be
added to `server/vault.mjs` and to the key mapping in `server/backend.mjs`.

## Automating (cron)

```cron
15 7 * * 1 cd ~/am-i-cited && mkdir -p logs && for p in projects/*.json; do node am-i-cited.mjs $(basename $p .json) --runs 3 >> logs/$(basename $p .json).log 2>&1; done
```

Weekly is plenty: the useful signal is the month-over-month trend, and the
negative control keeps you honest.

## Hosted mode (multi-user BYOK)

`server/backend.mjs` turns the probe into a multi-user service, designed to
run behind [cortex-gateway](https://github.com/wellknownmcp/cortex-gateway)
(OAuth 2.1, per-user identity propagation). Each user stores their own
engine keys — encrypted per user with AES-256-GCM, write-only, masked
status, audit trail, real deletion — and owns their project configs and
history. The full custody design, including what it does *not* protect
against, is public: [docs/byok.md](docs/byok.md).

```bash
AMICITED_VAULT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  node server/backend.mjs   # cortex backend contract on :4930
```

## What this is not

- Not a rank tracker — LLMs don't have ranks, they have citations.
- Not a volume estimator — a cited intent is not necessarily a demanded one;
  cross with your search-console data.
- Not affiliated with any engine. `am-i-cited` calls public APIs you pay for
  with your own keys.

## License

MIT — from the people behind
[cortex-gateway](https://github.com/wellknownmcp/cortex-gateway), the
self-hosted MCP gateway with user-level permissions. `projects/example.json`
is our own probe config for it, kept in public.
