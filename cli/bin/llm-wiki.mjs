#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { program } from 'commander'
import { initKb } from '../src/init.mjs'
import { scanSource } from '../src/scanner.mjs'
import { runConvertPlan } from '../src/convert-run.mjs'
import { buildIndex } from '../src/indexer.mjs'
import { askKb } from '../src/ask.mjs'
import { lintKb } from '../src/lint.mjs'
import { statusKb } from '../src/status.mjs'
import { connectProject, installSkills } from '../src/connect.mjs'

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
    const repoSkills = path.resolve(fileURLToPath(import.meta.url), '../../..', 'skills')
    const { installed } = installSkills(opts.target, repoSkills)
    console.log(`installed skills: ${installed.join(', ')}`)
  })

program.parseAsync().catch((err) => { console.error(err.message); process.exit(1) })
