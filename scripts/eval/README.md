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

Weighted-RRF / vector-first experiment (2026-07-11, offline recombination of
the same bm25 + vector rankings; weighted RRF = `w/(60+rank+1)` on the vector
list with bm25 weight 1; vector-first = vector ranking then unseen bm25 hits;
k=5, three tiers, 46 probes): no arm dominates standard RRF. On ./kb, every
vector-weighted arm trades recall for MRR (hybrid 0.979/0.769 vs wrrf-w2
0.958/0.833 vs vector-first 0.958/0.927) — the lost probe is a two-page zh
paraphrase where bm25's unique contribution gets crowded out of top-5. On
kb-50, wrrf w=1.5–2 is a mild Pareto gain (MRR 0.900→0.950); on kb-150 all
fused arms tie (1.000/0.933–0.938). Since `ask` consumes the whole top-k,
recall@k is the answer-quality metric and MRR only orders budget drops —
standard RRF keeps the best recall everywhere, so it stays. If a k=1 /
first-hit UI ever appears, vector-first is the candidate (pooled xlang MRR
0.714→0.904, same recall).

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
