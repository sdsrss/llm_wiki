# Eval harness

Dev-only (not shipped). Measures llm-wiki retrieval and answer quality.

## One command

    node scripts/eval/run-all.mjs --kb ./kb --judge-model <model>

Produces `scripts/eval/results/report-<stamp>.md` covering every section below;
sections with missing prerequisites are SKIPPED with the reason printed.

## Probe classes

Probes are JSONL: `{"q", "expect": ["dir/slug"], "lang", "type"}` where `type` ∈
`fact` (single-page) | `multihop` (expect lists ≥2 pages) | `xlang` (question
language ≠ page language) | `none` (`expect: []`, the KB cannot answer — used
only by answer-eval, skipped by retrieval eval).

| file | KB | classes |
|---|---|---|
| probes-kb.jsonl | ./kb (35 zh pages, real links) | fact, multihop, xlang, none |
| probes-50.jsonl / probes-150.jsonl | generated tiers | fact, xlang, none (no multihop: generated pages have no cross-page links) |

## Pieces

    node scripts/eval/eval.mjs --kb ./kb --arms bm25,vector,hybrid,graph -k 5

Retrieval Recall@k / MRR / latency per arm, overall + per probe type. `bm25`
needs no network; `vector`/`hybrid`/`graph` need `wiki/.vectors.json`
(`llm-wiki embed`) + an embeddingModel. `graph` additionally needs a graph.json
with edges; it is an experiment (degree-prior third RRF signal) that lives only
in this harness.
Measured 2026-07-11 on ./kb (24 probes, k=5): graph Recall@5 0.938 vs hybrid 0.979 with an xlang regression (0.833 vs 1.000) — negative result, not promoted to `ask`.

    node scripts/eval/answer-eval.mjs --kb ./kb --arms bm25,hybrid --judge-model <model>

Runs `askKb` per arm, then: abstention rate on `none` probes (higher = honest),
false-abstention on answerable probes (lower better), deterministic citation
checks, and a 3-dimension LLM-as-judge head-to-head (correctness / citations /
completeness) with position-swap debiasing. The judge model must differ from
the answering model.

    node scripts/eval/make-corpus.mjs --tier 50   # then: llm-wiki embed --kb scripts/eval/corpus/kb-50

Builds a scale tier from local `node_modules` markdown (public, on-disk,
lockfile-reproducible; zero network). Prints page + index token costs.

Results land in `scripts/eval/results/` (gitignored); corpora in
`scripts/eval/corpus/` (gitignored). Metric functions are unit-tested in
`test/eval-lib.test.mjs` / `test/eval-corpus.test.mjs`.

Note: per-arm `avg ms` times only the retrieval call; query embedding runs once
per probe outside the timed section, so vector/hybrid/graph `ms` excludes the
embedding round-trip.
