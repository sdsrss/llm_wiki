# Changelog

## Unreleased

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
