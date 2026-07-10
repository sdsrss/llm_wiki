---
name: wiki-connect
description: Register an llm_wiki knowledge base into the current project so coding agents use it. Use when the user wants a project to consume a KB (default or third-party) or says /wiki-connect.
---

# wiki-connect

1. Confirm the KB path and role with the user: `project` (this project's own KB) or
   `reference` (third-party knowledge).
2. Run `npx @sdsrs/llm-wiki connect <projectDir> --kb <kbPath> --role <role>`. This maintains
   `.llm-wiki.json` and a sentinel block in the project's CLAUDE.md.
3. Verify the block: read CLAUDE.md, confirm it lists the KB with role and the
   index-first reading instruction.
4. To detach: `npx @sdsrs/llm-wiki connect <projectDir> --kb <kbPath> --remove`.
