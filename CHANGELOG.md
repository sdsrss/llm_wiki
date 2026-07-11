# Changelog

## 0.6.3 (2026-07-11)

Two cosmetic fixes from an independent review of 0.6.0–0.6.2; no behavior
change beyond the scan warning's rounding.

- fix(scan): the tag-dispersion warning now flags on the same rounded top-tag
  share it displays, so it can no longer print "top tag covers 30%" while
  firing a "below 30%" rule. Effective threshold is 29.5% (was a raw 30% with
  an inconsistent display); negligible for an advisory heuristic. Suite 178 →
  179.
- docs: note that the JSON Canvas map's `file` cards are vault-relative from the
  KB root, so a canvas written outside the KB via `--out` won't resolve them in
  Obsidian — open the canvas with the KB as its own vault.

## 0.6.2 (2026-07-11)

No breaking changes, no KB migration, no default-behavior change — one additive
export format.

- feat(export): `--format canvas` writes a JSON Canvas 1.0 file
  (`<kb>/graph.canvas`) — a domain map of `file` cards laid out in columns by
  page type (source / entity / concept / comparison / raw), ordered by link
  degree, colored by type, with invalidated pages flagged red. The cards open
  as live, clickable notes in Obsidian Canvas when the KB is opened as its own
  vault. Zero-LLM, alongside the existing graphml / cypher / html / markdown
  exports. Suite 174 → 178.

## 0.6.1 (2026-07-11)

No breaking changes, no KB migration, no default-behavior change: the only
functional addition is advisory `scan` output (exit code and existing lines
untouched).

- feat(scan): domain-mixture heuristic — warns when a source directory looks
  multi-domain and suggests one KB per domain. Two zero-LLM signals: language
  mix across scanned text files (minority language ≥3 files and ≥25%) and
  dispersed wiki tags (≥10 tagged pages with no tag covering ≥30%). Advisory
  only; the scan report gains a `domainMixture` field. Suite 171 → 174.
- docs: README restructured (install → what it does → why-not-RAG →
  usage → FAQ); GitHub repo description refreshed.
- Measured 2026-07-11 (dogfood KB, 28 probes, `locatePages` 'auto' — the path
  `wiki_search`/skills use): enabling `vectorEnabled` on a KB lifts Recall@5
  0.733 → 0.967 (22/30 → 29/30) and MRR 0.646 → 0.769; the previously missed
  cross-language probe now hits via the vector channel. KB-side config, not a
  code change — recorded here as the reference numbers behind the README claim.

## 0.6.0 (2026-07-11)

No breaking changes, no KB migration. Default behavior unchanged for KBs
without embeddings; on a KB with `vectorEnabled: true` and a built vector
store, the MCP `wiki_search` tool now fuses semantic vector matches into its
results (fail-open — any vector error falls back to BM25). Pin
`@sdsrs/llm-wiki@0.5.0` to keep pure-BM25 `wiki_search` everywhere. Skill
texts pick up the new graph-aware procedures on the next `connect`/install.

- feat(mcp): `wiki_search` retrieves via `locatePages` 'auto' mode — BM25
  always, vector fusion only when the KB opted in; when fusion is active, hit
  lines name the retrieval channels (`bm25+vector`) instead of a BM25 score,
  and the zero-hit guidance adapts.
- feat(skills): wiki-query expands hits with `graph neighbors`, traces
  cross-topic questions with `graph path`, and states typed relations bound
  verbatim to graph output (inventing a type is explicitly forbidden);
  wiki-ingest/wiki-build guide typed `relations` frontmatter on pages already
  being touched (backfill sweeps FORBIDDEN — O(1) ingest preserved);
  wiki-lint orders semantic work by `graph hubs` and lists
  `confidence: ambiguous` relations as the human-review queue.
- fix(eval): probe `expect` ids are validated against non-invalidated pages
  (symmetric with answer-eval — an invalidated id now exits 1 instead of
  silently scoring 0).
- tests/docs: pinned tests for the unknown-retrieval-mode error and pure-CJK
  oversized-page embed capping; `locatePages` doc comment covers all three
  retrieval modes. Suite 165 → 171.
- Measured 2026-07-11 (./kb, 3 questions, same-model agents, old vs new
  wiki-query text): graph CLI actually used in 3/3 runs (was 0/3), citations
  +1 on 2/3 questions, expected-page coverage 4/4 in both arms; skill prompt
  payload 5464 → 7166 bytes (~ +426 tokens), added runtime cost is zero-LLM
  CLI calls only.

## 0.5.0 (2026-07-11)

No breaking changes, no KB migration, defaults unchanged. One behavior fix you
may notice: `embed` no longer aborts the whole run when a page exceeds the
embedding model's input limit — the text sent to the API is capped (~8000
worst-case tokens, with a per-page stderr warning); the page file itself is
never modified. Pin `@sdsrs/llm-wiki@0.4.1` to keep the previous (aborting)
behavior.

- feat(ask): `locatePages`/`askKb` accept `retrieval: 'auto' | 'bm25' | 'hybrid'`
  (`auto` = existing behavior exactly; `bm25` forces lexical-only; `hybrid`
  forces fusion and errors when vector prerequisites are missing instead of
  degrading). Programmatic surface only — CLI behavior unchanged. `chatCompletion`
  is now an exported helper.
- fix(embed): oversized pages embed their head instead of killing the run —
  input capped at ~8000 worst-case tokens (binary-search cut, lone-surrogate
  trim at the boundary), per-page warning, incremental reuse unaffected for
  pages under the cap.
- Eval harness completed (dev, in-repo `scripts/eval/`): four probe classes
  (fact / multihop / xlang / none), answer-level eval (abstention honesty +
  3-dimension LLM-as-judge head-to-head with position-swap debiasing),
  50/150-page scale corpora generated from local markdown (zero network),
  experimental graph-degree RRF arm (measured negative on ./kb — recorded in
  `scripts/eval/README.md`, not promoted to `ask`), and `run-all.mjs`
  producing a single markdown report.
- Measured 2026-07-11 (./kb 35pp + tiers, k=5): abstention on unanswerable
  probes 100% for both bm25 and hybrid (n=4, zero fabrication); answer-level
  head-to-head hybrid vs bm25 (n=24, judge gpt-5.1) — correctness 7-1-16,
  citations 11-3-10, completeness 7-3-14 (wins-losses-ties); retrieval
  Recall@5 bm25→hybrid: 35pp .688→.979, 50pp .600→1.000, 150pp .667→1.000
  (no BM25-favored regime found in the 35–150 range).

## 0.4.1 (2026-07-11)

Patch: all fixes, no new features, no deps, no KB migration. Defaults unchanged.

- fix(lint): new `duplicate-relation` rule flags a repeated `to`+`type` relation
  (index keeps the first entry; conflicting `confidence` values are named)
- fix(lint): orphan-page detail now reads "no incoming wikilinks or relations"
- fix(lint): promote-concepts no longer truncates concept names at an embedded
  en/em dash (`pages 1–2`); a dash is a separator only when followed by a space
- fix(scan): a symlinked directory matching `--exclude` is reported as `excluded`
  rather than `symlinked directory (not followed)`
- fix(graph): `path`/`neighbors`/`hubs` (CLI and MCP `wiki_graph`) mark invalidated
  nodes with `⚠ invalidated`; `hubs` ignores dangling edge endpoints so a stale
  edge no longer invents a phantom hub or inflates degree
- fix(vector): a corrupt `wiki/.vectors.json` now fails open — `ask` degrades to
  BM25 with a stderr warning instead of crashing
- fix(embed): `embedded` count reports only pages actually stored (a pathological
  zero-vector page is skipped, not counted)
- fix(export): `.llm-wiki-export` marker now records `{tool, version}` provenance
  (old empty markers still recognized); `--out` pointing at a file errors clearly
- fix(templates): AGENTS.md wiki-layer line harmonizes "Humans review" with the
  documented occasional hand-edit exception

## 0.4.0 (2026-07-11)

All additive — no breaking changes, no KB migration, defaults unchanged
(vector location stays opt-in via `vectorEnabled: true`). Pin `@sdsrs/llm-wiki@0.3.0`
to stay on the previous behavior.

- **MCP server (v2.0)**: `llm-wiki mcp --kb <dir>` exposes the KB over stdio MCP —
  `wiki_overview` / `wiki_search` / `wiki_read_page` / `wiki_ask` (all read-only,
  whole pages only, untrusted-data notice on every result). Opens llm-wiki to
  MCP-only agents (Cursor, Windsurf). New deps: `@modelcontextprotocol/sdk`, `zod`.
- **Vector page location (v2.1, opt-in)**: `llm-wiki embed` builds incremental
  whole-page embeddings (`wiki/.vectors.json`); with `vectorEnabled: true`,
  `ask` fuses BM25 + cosine via RRF (fail-open to BM25). `--retrieve-only` now
  labels hit sources. Plus a retrieval eval harness (`scripts/eval/`).
- feat: typed relations — optional `relations:` frontmatter (`to`/`type`/`confidence`) merged into graph.json; all edges now carry `confidence` (`extracted` for CLI-derived source/superseded_by edges, `inferred` for wikilinks and agent-written relations)
- feat: `llm-wiki graph path|neighbors|hubs` — zero-LLM graph queries over graph.json
- feat: MCP tool `wiki_graph` (path/neighbors/hubs)
- feat: lint validates relations (target exists, type in `relationTypes` vocabulary, confidence value); relation targets count as incoming links for orphan detection
- feat: GraphML/Cypher exports carry edge confidence
- feat: `llm-wiki export --format markdown` — wiki copy with [[wikilinks]] converted to relative markdown links (index.md and topics/ included), for tools without wikilink support
- feat: AGENTS.md contract documents optional `aliases` frontmatter and the Obsidian browse-&-annotate convention (manual edits → rerun `llm-wiki index`)
- docs: README "Obsidian integration" — vault usage, Bases filtering, graph view, verification checklist

## 0.3.0 (2026-07-10)

No breaking changes; no KB migration needed. Two behavior changes you may
notice: (1) `ask` with pages exceeding `askTokenBudget` (default 32000) now
drops the lowest-ranked pages instead of sending an oversized request —
raise the key in `wiki.config.json` to restore the old envelope; (2) `ask`
with zero BM25 hits now makes an extra LLM call to pick pages from the KB
listing instead of erroring. The CLI prints a note whenever either kicks
in. To stay on the previous behavior entirely, pin
`npx @sdsrs/llm-wiki@0.2.0`. If a project was connected before the 0.2.0
npm rename, re-run `connect` once — old blocks invoke `npx llm-wiki`,
which is an unrelated npm package.

- **Claude Code plugin support** — install the wiki-* skills straight from
  GitHub: `/plugin marketplace add sdsrss/llm_wiki` then `/plugin install llm-wiki`.
  (`.claude-plugin/plugin.json` + `marketplace.json`; the skills keep calling the
  CLI via `npx @sdsrs/llm-wiki`, so nothing changes on the npm side.)

### Fixed (audit batch, 2026-07-10)

- **fix: corrupt or stale state files now fail with the file named in the
  error.** `.manifest.json` / `.scan-plan.json` / `wiki.config.json` parse
  failures no longer surface as bare `SyntaxError`s; a missing or
  hand-edited scan plan says to re-run `llm-wiki scan` (a stale batch entry
  fails just that entry, not the run). Corrupt `~/.llm-wiki/config.json`
  errors are redacted — V8's JSON error quotes the input, which could echo
  an API-key fragment to the terminal. `wiki.config.json` reading is
  consolidated into one `loadKbConfig` shared by scan/lint/index/ask.

- **fix: `index` no longer swallows user sections added after "Pending
  concepts".** The pending section is now bounded at the next `## ` heading;
  anything after it is carried over verbatim on rebuild. `lint` uses the same
  boundary, so list items in user sections are no longer counted as pending
  concepts.
- **fix: same-basename originals no longer overwrite each other.** Converting
  `a/doc.pdf` and `b/doc.pdf` now lands `_originals/doc.pdf` and
  `_originals/doc-2.pdf`; the path is recorded in the manifest (`original`)
  and reused on re-convert.

- **fix: re-converting a changed source now overwrites its raw file in place.**
  Previously a fresh `-2` suffixed file was created, orphaning the old raw file
  and silently defeating lint's `stale-scan` (pages cite the old raw path while
  the manifest pointed at the new one, so staleness never fired).
- **fix: `status --src` no longer overwrites `.scan-plan.json`** — the internal
  scan runs read-only, so a saved plan (including its `--exclude` choices)
  survives status checks.
- **fix: `ask` error handling** — non-ok API responses now include the response
  body (first 200 chars); unexpected 200-response shapes raise a clear error
  instead of a bare `TypeError`.
- **fix: `lint` promote-concepts now accepts hyphen/en-dash pending lines**
  (previously only em-dash `—` lines were counted, so hand-written entries
  never promoted).

### Changed

- **`ask` zero-hit fallback** — when BM25 finds no lexical match (e.g. the
  question is in a different language than the KB pages), `ask` now lets the
  model select pages from the KB listing (`llms.txt`, or `index.md` if
  absent) and answers from those whole pages instead of erroring out. Only
  ids of real, non-invalidated pages are accepted from the model's reply;
  `--retrieve-only` remains pure BM25. The CLI notes when the fallback was
  used, and `askKb` returns `fallback: 'index'`.
- **`ask` token budget** — selected pages are dropped (whole, lowest BM25 rank
  first) when they exceed `askTokenBudget` (`wiki.config.json`, default 32000);
  the CLI reports which pages were dropped. Pages are never truncated.
- **Skills and `connect` blocks pin the CLI major version** (`npx
  @sdsrs/llm-wiki@0 ...`) so a future 1.x npm release cannot silently change
  what installed skills execute. **Re-run `connect` on projects wired before
  the npm rename** — old blocks say `npx llm-wiki`, which is an unrelated
  npm package.
- **`scan` reports symlinks** — symlinked directories (not followed) and broken
  symlinks now appear in the `skipped` list instead of vanishing silently.

### Added

- **CI** — GitHub Actions runs the test suite on Node 22/24 plus
  `npm pack --dry-run` and a version-sync check across `package.json`,
  `plugin.json`, and `marketplace.json` (`scripts/check-versions.mjs`).

### Removed

- `serializeFrontmatter` (dead export, no production callers).
- **`rawDir` / `schemaFile` pseudo-config keys.** They were accepted by
  `kbPaths` but never wired through the 12 call sites, so setting them in
  `wiki.config.json` silently did nothing; `init` never emitted them either.
  The KB layout is fixed: `raw/` and `AGENTS.md`. A hand-added key remains
  ignored, exactly as before — no KB changes needed.

### Fixed (misc)

- `connect --remove` on a project that was never connected no longer leaves
  an empty `.llm-wiki.json` behind (same guard CLAUDE.md already had);
  a corrupt registry file now errors with the file named.

## 0.2.0 (2026-07-10)

First npm release, published as **`@sdsrs/llm-wiki`** (the bare name `llm-wiki` was
already taken on the registry by an unrelated project). The installed binary is
still `llm-wiki`. If you used the CLI from a git checkout before, only the
`npx` invocation changes: `npx llm-wiki ...` → `npx @sdsrs/llm-wiki ...`.

### Added (v1.2 research-adoption batch)

- **Time-aware invalidation** — mark outdated pages with frontmatter
  `status: invalidated` / `invalidated: YYYY-MM-DD` / `superseded_by: <page>`
  instead of deleting them. Invalidated pages are annotated in `index.md`,
  excluded from `llms.txt` and `ask` retrieval, and carried as `status` +
  `superseded_by` edges in `graph.json`. New lint rules: `invalid-status`,
  `superseded-target-missing`.
- **Provenance in `status`** — `llm-wiki status --src <dir>` now reports which
  wiki pages are affected by changed/removed source files (derived from the
  manifest joined with page `sources`, nothing extra stored).
- **`lint` stale-scan** — a new semantic worklist item flags pages whose cited
  raw file was reconverted after the page was last updated.
- **`export` command** — `llm-wiki export --format graphml|cypher|html` renders
  `wiki/graph.json` for Gephi/yEd, Neo4j, or a self-contained interactive HTML
  viewer (zero external requests).
- **`wiki-distill` skill** — distill episodic memory (session logs, notes,
  memory-tool output) into wiki pages through a prediction-error gate: only
  claims the wiki cannot already answer are ingested, via a dated
  `raw/distilled/` evidence file.

### Note for existing knowledge bases

`lint` may now emit `stale-scan` items on KBs whose sources were reconverted
after pages were written. This is the new staleness detector working as
intended — the items are an advisory worklist, not errors, and nothing changes
in your pages until an agent (or you) acts on them. All v1.2 schema additions
are optional fields; KBs without them behave exactly as before.
