# Changelog

## 0.2.0 (2026-07-10)

First npm release, published as **`llm-wiki-cli`** (the bare name `llm-wiki` was
already taken on the registry by an unrelated project). The installed binary is
still `llm-wiki`. If you used the CLI from a git checkout before, only the
`npx` invocation changes: `npx llm-wiki ...` → `npx llm-wiki-cli ...`.

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
