---
name: wiki-query
description: Answer a question from an llm_wiki knowledge base with citations. Use when the user asks a question against a KB or says /wiki-query.
---

# wiki-query

1. Read `<kbDir>/wiki/index.md` (and hot.md). Pick candidate pages; for large KBs run
   `npx llm-wiki ask "<question>" --kb <kbDir> --retrieve-only` to locate pages by BM25.
2. Read the full candidate pages (never fragments). Follow [[wikilinks]] up to 2 hops
   when needed; consult wiki/graph.json for reverse links.
3. Answer with inline [[dir/slug]] citations. If the KB lacks the answer, say so.
4. If the answer produced a genuinely new cross-source insight, PROPOSE saving it as
   wiki/comparisons/<slug>.md — create it only after the user confirms, then run
   `npx llm-wiki index --kb <kbDir>` and append a query line to wiki/log.md.
