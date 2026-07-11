#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { program } from 'commander'
import { initKb } from '../src/init.mjs'
import { scanSource } from '../src/scanner.mjs'
import { runConvertPlan } from '../src/convert-run.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { embedKb } from '../src/embed.mjs'
import { askKb } from '../src/ask.mjs'
import { lintKb } from '../src/lint.mjs'
import { statusKb } from '../src/status.mjs'
import { connectProject, installSkills } from '../src/connect.mjs'
import { exportGraph, loadGraph, exportMarkdownPages } from '../src/export.mjs'
import { shortestPath, neighborhood, hubs } from '../src/graph.mjs'
import { runMcpServer } from '../src/mcp.mjs'

program.name('llm-wiki').description('Compile messy directories into an llm_wiki knowledge base')

program.command('init [dir]').description('scaffold a knowledge base').action((dir = '.') => {
  const { created, skipped } = initKb(dir)
  console.log(`created ${created.length} entries, skipped ${skipped.length} existing`)
})

program.command('scan <srcDir>')
  .description('inventory a source directory: dedup, batches, token estimate')
  .option('--kb <dir>', 'knowledge base root', '.')
  .option('--exclude <pattern...>', 'substring patterns to skip')
  .action(async (srcDir, opts) => {
    const r = await scanSource(srcDir, opts.kb, { exclude: opts.exclude ?? [] })
    console.log(`files: ${r.files.length} (skipped ${r.skipped.length})`)
    console.log(`duplicates: ${r.duplicates.exact.length} exact, ${r.duplicates.near.length} near`)
    console.log(`incremental: +${r.incremental.added} ~${r.incremental.changed} -${r.incremental.removed} =${r.incremental.unchanged}`)
    const dm = r.domainMixture
    if (dm.language.flagged) console.log(`warning: mixed-language source (zh ${dm.language.zh} / en ${dm.language.en} files) — this KB may span multiple domains`)
    if (dm.tags?.flagged) console.log(`warning: wiki tags are dispersed (top tag covers ${Math.round(dm.tags.topShare * 100)}% of ${dm.tags.pages} pages) — this KB may span multiple domains`)
    if (dm.flagged) console.log('hint: llm-wiki works best with one domain per KB; consider splitting the source into separate KBs')
    console.log(`compile plan: ${r.batches.length} batches -> ~${r.estimate.inputTokens} in / ~${r.estimate.outputTokens} out tokens`)
    console.log(`plan saved to ${opts.kb}/.scan-plan.json`)
  })

program.command('convert')
  .description('convert files from the scan plan into raw/ markdown')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action(async (opts) => {
    const r = await runConvertPlan(opts.kb)
    console.log(`converted ${r.converted.length}, failed ${r.failed.length}`)
    for (const f of r.failed) console.log(`  FAILED ${f.src}: ${f.warnings.join('; ')}`)
  })

program.command('index')
  .description('rebuild index.md, graph.json and llms.txt from page frontmatter')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action((opts) => {
    const r = buildIndex(opts.kb)
    console.log(`indexed ${r.pageCount} pages${r.topicsSplit ? ' (split into topics/)' : ''}`)
  })

program.command('embed')
  .description('compute/update page embeddings into wiki/.vectors.json (needs embeddingModel in ~/.llm-wiki/config.json)')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action(async (opts) => {
    const r = await embedKb(opts.kb)
    console.log(`embedded ${r.embedded}, reused ${r.reused}, pruned ${r.pruned} (model ${r.model}, dim ${r.dim})`)
  })

program.command('ask <question>')
  .description('answer a question from the knowledge base (full pages, never chunks)')
  .option('--kb <dir>', 'knowledge base root', '.')
  .option('-k <n>', 'pages to load', '6')
  .option('--retrieve-only', 'print located pages without calling the LLM')
  .action(async (question, opts) => {
    const k = Number.parseInt(opts.k, 10)
    if (!Number.isFinite(k) || k < 1) { console.error(`invalid -k value: ${opts.k} (expected a positive integer)`); process.exit(1) }
    const r = await askKb(opts.kb, question, { k, retrieveOnly: opts.retrieveOnly })
    if (opts.retrieveOnly) {
      for (const h of r.pages) console.log(`${h.score.toFixed(3)}  ${h.relPath}  [${(h.sources ?? ['bm25']).join('+')}]`)
    } else {
      console.log(r.answer)
      if (r.fallback) console.log('\n(BM25 found no lexical match; pages were selected from the KB listing by the model)')
      if (r.trimmed?.length) console.log(`\n(token budget: dropped ${r.trimmed.length} lower-ranked page(s): ${r.trimmed.join(', ')} — raise askTokenBudget in wiki.config.json to include them)`)
      console.log(`\n--- pages used: ${r.pages.map(h => h.relPath).join(', ')}`)
    }
  })

program.command('lint')
  .description('mechanical checks + semantic worklist for the LLM')
  .option('--kb <dir>', 'knowledge base root', '.')
  .option('--fix', 'rebuild index/graph/llms.txt')
  .action(async (opts) => {
    const r = await lintKb(opts.kb, { fix: opts.fix })
    for (const i of r.mechanical) console.log(`[${i.rule}] ${i.path}: ${i.detail}`)
    for (const s of r.semantic) console.log(`[semantic:${s.task}] ${s.detail}`)
    console.log(`${r.mechanical.length} mechanical, ${r.semantic.length} semantic, autoFixed: ${r.autoFixed.join(',') || 'none'}`)
  })

program.command('status')
  .description('incremental state: uncompiled raw files, source dir diff')
  .option('--kb <dir>', 'knowledge base root', '.')
  .option('--src <dir>', 'source directory to diff against')
  .action(async (opts) => {
    const s = await statusKb(opts.kb, opts.src)
    if (s.incremental) console.log(`src diff: +${s.incremental.added} ~${s.incremental.changed} -${s.incremental.removed} =${s.incremental.unchanged}`)
    console.log(s.uncompiledRaw.length ? `uncompiled raw:\n  ${s.uncompiledRaw.join('\n  ')}` : 'all raw files compiled')
    for (const a of s.affectedPages) {
      const pages = a.pages.length ? a.pages.map(id => `[[${id}]]`).join(' ') : '(no wiki pages cite its raw output)'
      console.log(`${a.kind}: ${a.src} -> ${pages}`)
    }
  })

program.command('connect <projectDir>')
  .description('register a knowledge base into a project CLAUDE.md (sentinel block)')
  .requiredOption('--kb <path>', 'knowledge base path (as the project should reference it)')
  .option('--role <role>', 'project | reference', 'project')
  .option('--remove', 'detach this kb')
  .action((projectDir, opts) => {
    const { registry } = connectProject(projectDir, { kb: opts.kb, role: opts.role, remove: opts.remove })
    console.log(`registered kbs: ${registry.kbs.map(k => `${k.role}:${k.path}`).join(', ') || 'none'}`)
  })

program.command('install-skills')
  .description('copy the wiki-* skills into a .claude directory')
  .option('--target <dir>', 'target .claude directory', './.claude')
  .action((opts) => {
    const repoSkills = path.resolve(fileURLToPath(import.meta.url), '../..', 'skills')
    const { installed } = installSkills(opts.target, repoSkills)
    console.log(`installed skills: ${installed.join(', ')}`)
  })

program.command('export')
  .description('export wiki/graph.json (graphml | cypher | html) or a markdown-links copy of the wiki (markdown)')
  .option('--kb <dir>', 'knowledge base root', '.')
  .requiredOption('--format <format>', 'graphml | cypher | html | markdown')
  .option('--out <file>', 'output path (default: <kb>/graph.<ext>, or <kb>/wiki-md/ for markdown)')
  .action((opts) => {
    if (opts.format === 'markdown') {
      const r = exportMarkdownPages(opts.kb, { out: opts.out })
      console.log(`exported ${r.pageCount} pages with markdown links -> ${r.out}`)
      return
    }
    const r = exportGraph(opts.kb, { format: opts.format, out: opts.out })
    console.log(`exported ${r.nodeCount} nodes / ${r.edgeCount} edges -> ${r.out}`)
  })

const graphCmd = program.command('graph').description('query wiki/graph.json: path | neighbors | hubs (zero-LLM traversal)')

graphCmd.command('path <from> <to>')
  .description('shortest link chain between two page ids (either link direction)')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action((from, to, opts) => {
    const r = shortestPath(loadGraph(opts.kb), from, to)
    if (!r) { console.log(`no path between ${from} and ${to}`); return }
    console.log(r.nodes[0])
    for (const h of r.hops) console.log(`  ${h.dir === 'out' ? `-[${h.type}]->` : `<-[${h.type}]-`} ${h.to}${h.confidence ? `  (${h.confidence})` : ''}${h.status === 'invalidated' ? '  ⚠ invalidated' : ''}`)
  })

graphCmd.command('neighbors <id>')
  .description('pages within N hops (links counted in both directions)')
  .option('-d, --depth <n>', 'expansion depth', '1')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action((id, opts) => {
    const depth = Number.parseInt(opts.depth, 10)
    if (!Number.isFinite(depth) || depth < 1) { console.error(`invalid depth: ${opts.depth} (expected a positive integer)`); process.exit(1) }
    const r = neighborhood(loadGraph(opts.kb), id, depth)
    if (!r.length) { console.log(`${id} has no linked neighbors`); return }
    for (const n of r) console.log(`d=${n.distance}  ${n.id}  [${n.type}${n.confidence ? '/' + n.confidence : ''} ${n.dir}]${n.status === 'invalidated' ? '  ⚠ invalidated' : ''}`)
  })

graphCmd.command('hubs')
  .description('most-connected pages (degree ranking; raw files excluded)')
  .option('--top <n>', 'how many to show', '10')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action((opts) => {
    const top = Number.parseInt(opts.top, 10)
    if (!Number.isFinite(top) || top < 1) { console.error(`invalid --top: ${opts.top} (expected a positive integer)`); process.exit(1) }
    for (const h of hubs(loadGraph(opts.kb), { top })) {
      console.log(`${String(h.degree).padStart(3)}  ${h.id}  (in ${h.in} / out ${h.out})  ${h.title}${h.status === 'invalidated' ? '  ⚠ invalidated' : ''}`)
    }
  })

program.command('mcp')
  .description('run a read-only MCP server (stdio) over the knowledge base')
  .option('--kb <dir>', 'knowledge base root', '.')
  .action(async (opts) => {
    // stdout belongs to the MCP transport from here on — no console.log.
    await runMcpServer(opts.kb)
  })

program.parseAsync().catch((err) => { console.error(err.message); process.exit(1) })
