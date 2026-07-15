# am-i-cited

**Do AI assistants recommend you to someone who has your problem?** Search
consoles measure impressions; analytics measure referrers. Neither answers
that question — a site can have zero clicks and be cited by ChatGPT, or the
reverse. `am-i-cited` measures the thing itself: it asks Perplexity, ChatGPT
(OpenAI API) and Claude (Anthropic API) the questions your users actually ask,
and records whether **your domain shows up in the answer's citations**.

Open source (MIT), bring-your-own-keys, zero dependencies — one Node 18+
script, a JSON config per project, a CSV of history. A full 3-run probe over
10 prompts and 3 engines costs a few tens of cents; the SaaS tools doing the
same start at $29/month.

## Quick start

```bash
git clone https://github.com/wellknownmcp/am-i-cited
cd am-i-cited
cp .env.example .env      # add the key(s) you have — missing engines are skipped
node am-i-cited.mjs example --runs 3
```

Output: a score matrix on stderr, and one CSV row per (date, prompt, engine,
run) appended to `results/<project>.csv`:

```csv
date,prompt_id,engine,run,score,cited_url,competitor_url,note
2026-07-15,P02,perplexity,1,2,https://cortex-gateway.dev/guides/rest-api-to-mcp-server/,,
2026-07-15,P06,openai,1,-1,,https://github.com/some/competitor,
2026-07-15,P04,anthropic,1,0,,,
```

## Scoring

| Score | Meaning | What it tells you |
|---|---|---|
| `2` | Your domain appears in the answer's **citations** | You are the answer. The only result that counts. |
| `1` | Your brand is **mentioned** without a link | The model knows you (entity/corpus) but does not retrieve you. Lever: indexing and freshness. |
| `0` | Absent | Nobody owns this intent — or you don't. A recurring `0` where *no one* is cited is the best opportunity in the file. |
| `-1` | A **competitor** is cited and you are not | Their page beats yours (or yours doesn't exist). `competitor_url` is the brief for the page to write. |

## Writing a project config

Copy `projects/example.json`. Rules that make the measurement honest:

- **8–15 prompts, phrased as the user would phrase them, never containing
  your brand.** A prompt with your name in it measures notoriety, not
  citation.
- Include one or two **negative controls** (`"control": true`): an intent you
  deliberately do not cover. If a control scores non-zero, the probe is
  biased — the script flags it in the `note` column.
- `domains` are yours (a `github.com/your-org/repo` path form is supported);
  `competitors` carry the domains whose citations you want to track.

## Methodology — read this before trusting the numbers

- **The API surface is a trend instrument, not a consumer-surface snapshot.**
  API calls have no account personalization and may rank differently from
  chatgpt.com or claude.ai. For "did we improve between day 0 and day 30",
  the API is valid and automatable; for "what does a user see right now",
  nothing replaces a clean manual session.
- **Retrieved is not cited.** Engines fetch far more URLs than they
  attribute. Only citations attached to the answer text score a `2` here —
  seeing your URL in a model's search results while scoring `0` is a
  citability problem, not a retrievability one.
- **Never conclude from a single run.** Answer engines rotate sources
  constantly while the *direction* stays stable. Run 3 passes (`--runs 3`),
  look at the trend across dates.
- **Baseline first.** Run the probe *before* publishing new pages (day 0),
  again at day 30. Without a baseline there is no attribution.

## Engines

| Engine | API | Default model | Citations come from |
|---|---|---|---|
| `perplexity` | `chat/completions` | `sonar` | `citations[]` + `search_results[]` in the response |
| `openai` | Responses API + `web_search` tool | `gpt-5-mini` | `url_citation` annotations on output text |
| `anthropic` | Messages API + `web_search` tool | `claude-opus-4-8` | `citations[]` on text blocks (tool results are retrieved, not cited) |

Override models via `*_PROBE_MODEL` env vars. Engines whose key is absent are
skipped, so you can start with a single key.

## Automating (cron)

```cron
15 7 * * 1 cd ~/am-i-cited && for p in projects/*.json; do node am-i-cited.mjs $(basename $p .json) --runs 3 >> logs/$(basename $p .json).log 2>&1; done
```

Weekly is plenty: the useful signal is the month-over-month trend, and the
negative control keeps you honest.

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
is our own live probe config, kept honest in public.
