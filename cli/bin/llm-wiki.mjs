#!/usr/bin/env node
import { program } from 'commander'
import { initKb } from '../src/init.mjs'
import { scanSource } from '../src/scanner.mjs'
import { runConvertPlan } from '../src/convert-run.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { askKb } from '../src/ask.mjs'

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

program.command('ask <question>')
  .description('answer a question from the knowledge base (full pages, never chunks)')
  .option('--kb <dir>', 'knowledge base root', '.')
  .option('-k <n>', 'pages to load', '6')
  .option('--retrieve-only', 'print located pages without calling the LLM')
  .action(async (question, opts) => {
    const r = await askKb(opts.kb, question, { k: Number(opts.k), retrieveOnly: opts.retrieveOnly })
    if (opts.retrieveOnly) {
      for (const h of r.pages) console.log(`${h.score.toFixed(2)}  ${h.relPath}`)
    } else {
      console.log(r.answer)
      console.log(`\n--- pages used: ${r.pages.map(h => h.relPath).join(', ')}`)
    }
  })

program.parseAsync().catch((err) => { console.error(err.message); process.exit(1) })
