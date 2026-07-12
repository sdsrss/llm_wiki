# Changelog

## 0.7.4 (2026-07-12)

Two robustness fixes surfaced by an adversarial QA pass over the CLI. No config
schema change, no KB migration, no retrieval-default change. Suite 230 → 234.

**Fixes:**

- **`index` warns when a page is skipped for invalid frontmatter.** `buildIndex`
  silently excluded any page with unparseable YAML frontmatter from
  `index.md`/`graph.json`/`llms.txt`. Because the docs route hand-editors to
  `index` (not `lint`) after editing, a broken-YAML edit made the page vanish
  from every query surface with no signal — `indexed N pages`, exit 0, nothing
  else. `buildIndex` now returns the skipped pages and the CLI prints a one-line
  stderr warning naming them and pointing at `lint`; stdout stays the clean
  count, and `lint` still owns the detailed per-page report.
- **`scan` near-duplicate detection uses 128 minhash permutations (was 32).**
  Near-dup similarity was estimated from a 32-permutation minhash and compared
  against the 0.85 threshold, but at 32 perms the estimate's standard error
  (~0.05) let a genuine near-duplicate (true Jaccard 0.898) estimate 0.844 and
  be reported as `near: 0`. 128 perms tightens the estimate (SD ~0.026) so real
  near-dups clear the threshold; the cost is trivial next to the per-file
  sha256+read scan already does, and the signature is stripped before the plan
  is persisted (no on-disk change).

## 0.7.3 (2026-07-12)

Two robustness fixes from the final targeted dogfooding sweep. No config schema
change, no KB migration, no retrieval-default change. Suite 228 → 230.

**Fixes:**

- **`graph`/exports name the file on a corrupt `graph.json`.** `loadGraph` was the
  last JSON reader still using a bare `JSON.parse`: a corrupt `wiki/graph.json`
  threw an unqualified `Unexpected token` SyntaxError, and a valid-JSON-but-wrong-
  shape file like `{}` crashed on `graph.nodes.map`. It now routes through the
  shared `readJsonFile` (names the file) and guards the nodes/edges shape, so both
  corruption modes yield a named, actionable "rerun `llm-wiki index`" error.
- **`.scan-plan.json` is written atomically.** `scan` wrote the plan with a direct
  `writeFileSync`, but `convert` reads it from a separate process — the same
  truncate-then-write torn read that 0.7.2 fixed for `graph.json`. It (and
  `.lint-report.json`) now write via the shared temp-and-rename `writeFileAtomic`,
  so every JSON state file another process can read is crash-safe.

## 0.7.2 (2026-07-12)

Three defects found by continued end-to-end dogfooding — two robustness/DoS
guards plus one UX fix. No config schema change, no KB migration, no
retrieval-default change. Suite 221 → 228.

**Fixes:**

- **Malformed numeric config can no longer crash retrieval or hang scan.**
  `wiki.config.json` is shallow-merged as-is, so a numeric key could arrive as a
  string/0/negative/NaN and reach a scalar consumer: `bm25TitleWeight: "high"`
  hit `Array(NaN)` → `RangeError` on *every* `ask`/`search`/MCP query (a huge int
  → per-page `Array(n).fill` OOM), and `batchSize: 0` made `scan`'s batch loop
  (`i += batchSize`) spin forever. `loadKbConfig` now coerces every numeric key
  back to a finite integer ≥ 1 (falling back to its default), and
  `bm25TitleWeight` is additionally capped at its consumer. Legitimate overrides
  are untouched.
- **Derived stores are written atomically.** `buildIndex` wrote `graph.json` /
  `index.md` / `llms.txt` / topic files with a direct `writeFileSync`, which
  truncates the target before writing — a reader running concurrently (a
  long-lived MCP `graph` tool, `ask`'s `llms.txt` fallback) could read a torn
  `graph.json` and crash on `JSON.parse`. All derived stores now write via a
  shared temp-and-rename `writeFileAtomic` (the pattern `saveManifest` /
  `saveVectorStore` already used), so a concurrent reader only ever sees the whole
  old or whole new file.
- **A source that converts to an empty page is no longer silent.** A
  scanned/image-only PDF, an empty DOCX, or a blank `.txt` extracts to no text;
  `convert` still writes the (empty) raw page and counts it as converted, but now
  prints `WARN <src>: converted to an empty page — no extractable text` so the
  user isn't misled into thinking real content was ingested.

## 0.7.1 (2026-07-11)

Four defects found by end-to-end dogfooding — one crash-class fix plus three
robustness/UX fixes. No config change, no KB migration, no retrieval-default
change. Suite 213 → 221.

**Fixes:**

- **A single malformed page no longer breaks the whole KB.** A frontmatter list
  field authored as a bare scalar (`tags: cache` instead of `tags: [cache]`)
  parses as a string, which slipped past the `?? []` guards and then crashed
  `ask`/`embed` (`.join` on a string) or was iterated character-by-character
  (`lint` noise; `index` synthesized a bogus graph edge per character, corrupting
  `graph.json`). List fields now route through an `Array.isArray` guard in every
  consumer, so one bad page can no longer take down retrieval or the graph.
  `lint` now flags `tags must be a YAML list` so the author can fix the shape.
- **`lint` contradiction-scan skips invalidated pages.** Retired knowledge is
  already excluded from stale-scan and the orphan rule; the shared-tag
  contradiction scan now matches, so you are never asked to reconcile a
  contradiction against a dead page.
- **`convert` exits non-zero when every file fails.** `converted 0, failed N`
  used to exit `0`, hiding a total failure from CI/scripts. It now exits `1` on
  total failure; a partial success (some files converted) still exits `0`.
- **Network errors name the endpoint.** A mistyped `baseURL` or offline host used
  to surface undici's opaque `fetch failed`; `ask`/`embed` now report
  `could not reach the LLM/embedding endpoint <url> — check baseURL/network`.

## 0.7.0 (2026-07-11)

Two retrieval-default changes (hence a minor bump). Both are opt-out via
`wiki.config.json`; no KB migration, no re-index needed. Suite 210 → 213.

**What changes for you:**

- **BM25 now weights page titles.** A query term in a page's title outranks the
  same term buried in another page's body. Measured on the dogfood KB (24 probes):
  Recall@5 0.688 → 0.729, MRR 0.646 → 0.675 (the lift is entirely on fact-style
  queries; cross-language and multi-hop are unchanged). **Opt out** by setting
  `"bm25TitleWeight": 1` in `wiki.config.json` (default `3`) — `1` restores the
  previous flat single-field indexing.
- **`ask` now budgets tokens pessimistically.** Page size against `askTokenBudget`
  is now estimated at a worst-case ~2 chars/token (was ~4), so dense
  markdown/code pages no longer silently overflow a small model context window.
  The visible effect: on a tight budget, `ask` may load fewer whole pages before
  trimming the lowest-ranked ones. **To include more pages**, raise
  `"askTokenBudget"` in `wiki.config.json` (default `32000`) — pages are still
  always sent whole, never truncated.

## 0.6.7 (2026-07-11)

Contract/skill clarifications, an env-var convenience, and an explicit platform
declaration. Suite 208 → 210.

- **Platform: macOS / Linux only.** The path handling assumes POSIX separators, so
  Windows is now declared unsupported via the package `os` field (`npm install`
  will refuse it on `win32`) — it never worked there. No change for macOS/Linux
  users.
- **fix(config): `LLM_WIKI_API_KEY` alone is now a complete config.** Setting just
  that env var (no `OPENAI_API_KEY`/provider key) bootstraps the first builtin
  provider instead of erroring "No LLM configured".
- **docs(AGENTS.md): the ingest contract now covers `wiki/hot.md`** — a ~500-char
  snapshot of what the KB covers, refreshed on ingest (it was scaffolded and read
  by the query flow but never named in the contract, so contract-only agents left
  it to go stale). Applies to newly `init`-ed KBs.
- **docs(wiki-lint skill): separated the manual `confidence: ambiguous` review pass
  from the three `lint`-emitted semantic tasks** (they were under one heading,
  reading as if `lint` produced all four).

## 0.6.6 (2026-07-11)

Audit remediation batch (roadmap M2 complete + M3/M4). No breaking changes, no KB
migration; new config keys default to prior behavior. Suite 185 → 208.

- **feat(cli): `llm-wiki --version`** prints the package version (was an unknown
  option).
- **fix(net): LLM and embedding calls now time out and retry.** `chat/completions`
  and `embeddings` requests go through a shared helper with an `AbortSignal.timeout`
  ceiling (120s) and exponential-backoff retry on 429 / 5xx / network errors — a
  hung or rate-limited provider no longer hangs the CLI or aborts a whole `embed`
  run on one transient failure.
- **fix(embed): incremental durability.** `embed` now persists the vector store
  after each batch, so a later batch failing keeps earlier batches' work (the
  re-run reuses them by content hash — no repeated API cost). The store is written
  atomically (temp + rename), as is `.manifest.json`.
- **fix(manifest): tolerate a hand-edited manifest** missing or mistyping the
  `files` key instead of throwing deep in the diff.
- **fix(index): no line injection from frontmatter.** Newlines in a page's
  title/description are collapsed before they are written into `index.md` /
  `llms.txt`, so a crafted value can't inject headings or spoof wikilinks. Stale
  `topics/*.md` are pruned when a type empties or the KB drops back below the split
  threshold.
- **fix(export): escape newlines in Cypher** node titles so they can't split a
  statement.
- **fix(docs): `@0` pin in the generated per-KB README**; corrected a fabricated
  `supersedes` relation type in the main README to the real vocabulary (with a note
  that `superseded_by` is a structural edge, not a `relations:` type); command
  reference now lists `connect` / `install-skills` and documents `--version` /
  `--follow-symlinks`; added an "Operational envelope" section (scale, no concurrent
  writers, size cap, kana/hangul BM25 gap).
- Test coverage: `installSkills` + CLI-layer smokes for `index` / `lint` / `status`
  / `connect` / `install-skills` / `export` / `graph` and the `-k` / `--depth` /
  `--top` guards; a timeout on the MCP stdio handshake test.

## 0.6.5 (2026-07-11)

Three security/robustness fixes from a full architecture-and-security audit
(M1, the release-blocking milestone). Suite 185 → 187.

**Behavior change (opt-out available):** `scan` now refuses a **symlinked source
file whose target resolves outside the source directory**, instead of silently
reading it into `raw/` and into a publishable wiki page. An attacker-supplied
corpus containing e.g. `notes.md -> ~/.llm-wiki/config.json` (or `~/.ssh/id_rsa`,
`/dev/zero`) could otherwise exfiltrate the victim's API key into a shared KB or
hang the process. Escaping links now appear in the scan report as
`skipped (symlink escapes source dir)`. **To restore the old follow-anywhere
behavior for a trusted, curated corpus, pass `--follow-symlinks`.** In-tree
symlinks are unaffected.

- **fix(scan): symlinked files escaping the source tree are refused** (audit
  HIGH-1). `walk()` blocked symlinked *directories* (loop safety) but followed
  symlinked *files* and read the link target; the content was copied into `raw/`
  and `raw/_originals/`. `scan` now `realpath`-resolves each symlinked file and
  skips any whose target is outside the source dir; `--follow-symlinks` opts back
  in.
- **fix(scan): a file-size cap** (audit MEDIUM-1). Reads were unbounded — a
  multi-GB (or `/dev/zero`-symlinked) file could OOM/hang the process. Files over
  `maxFileBytes` (new `wiki.config.json` key, default 50 MB) are now skipped with
  a clear reason rather than read whole.
- **fix(export): `--out` managed-layer guard is now a prefix check** (audit
  MEDIUM-2). The guard rejected `--out <kb>/raw` and `--out <kb>/wiki` exactly
  but let a *subdirectory* (`--out <kb>/raw/sub`) through, where the export's
  re-run `rmSync` would then wipe part of the immutable `raw/` layer. It now
  rejects the KB root and anything inside `raw/`/`wiki/` at any depth.

## 0.6.4 (2026-07-11)

Six fixes from a full-pipeline self-test pass (as a real user across every
command). No breaking changes, no KB migration, no config change. Suite 179 →
185.

- **fix(convert): PDF conversion was 100% broken** and is now restored. The code
  imported `pdf-parse/lib/pdf-parse.js` — the v1 subpath — but the pinned
  dependency is pdf-parse v2, whose export map has no such subpath, so *every*
  PDF failed at import time before any parsing. Switched to the v2 API
  (`new PDFParse({ data }).getText()`). It slipped through because there was no
  PDF fixture and the only test fed garbage bytes, which the import failure also
  satisfied; added a real `test/fixtures/hello.pdf` + a positive extraction test.
- fix(ask): `ask --retrieve-only` no longer prints nothing (exit 0) when
  retrieval locates zero pages — the state right after `init`/`scan`, before the
  wiki is built. It now emits a diagnostic to stderr (stdout stays pipe-clean),
  matching the LLM path which already errored.
- fix(convert): a source file whose whole basename is emoji/symbols
  (e.g. `😀.md`) no longer produces a hidden `raw/.md` that `status` skips
  (silently dropping the source from the incremental workflow). `slugify` now
  falls back to `untitled`, so the existing `-N` collision handler yields
  visible, shell-safe names (`untitled.md`, `untitled-2.md`, …).
- fix(scan): a missing or non-directory source path now gives a human-readable
  error ("source directory not found: X" / "source path is not a directory: X")
  instead of a raw `ENOENT`/`ENOTDIR`; also improves `status --src`.
- fix(export): `export --out path/with/missing/dirs/graph.graphml` now creates
  the parent directory (matching the markdown-export sibling) instead of leaking
  a raw `ENOENT`.
- docs: the layout diagram placed `llms.txt` under `wiki/`, but `index` writes it
  to the KB root (the llms.txt convention); corrected the diagram and command
  table.

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
