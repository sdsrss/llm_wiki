#!/usr/bin/env node
import { program } from 'commander'
import { initKb } from '../src/init.mjs'
import { scanSource } from '../src/scanner.mjs'

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

program.parseAsync().catch((err) => { console.error(err.message); process.exit(1) })
