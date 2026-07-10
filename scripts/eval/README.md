# Retrieval eval harness

Measures Recall@k / MRR / latency per retrieval arm (bm25 | vector | hybrid)
over a JSONL probe set (`{"q","expect":["dir/slug"],"lang"}`).

    node scripts/eval/eval.mjs --kb ./kb --arms bm25 -k 5            # no network
    npx llm-wiki embed --kb ./kb                                     # once, needs embeddingModel
    node scripts/eval/eval.mjs --kb ./kb --arms bm25,vector,hybrid   # full comparison

Results land in scripts/eval/results/ (gitignored). Metric functions are
unit-tested in test/eval-lib.test.mjs. Probe authoring rules: see the plan
(docs/superpowers/plans/2026-07-10-v2.1-vector-location.md Task 4 Step 6).

Note: per-arm `avg ms` times only the retrieval call itself. Query embedding
runs once per probe outside the timed section, so vector/hybrid `ms` is not
same-scope wall-clock with bm25 (it excludes the embedding round-trip).
