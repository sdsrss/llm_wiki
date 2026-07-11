#!/usr/bin/env node
// One command → full eval report (retrieval per KB/tier + answer-level).
// Usage: node scripts/eval/run-all.mjs --kb ./kb [--tiers 50,150]
//        [--arms bm25,vector,hybrid,graph] [--judge-model M] [-k 5]
// Sections whose prerequisites are missing are SKIPPED with the reason in the
// report — never silently.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1] }
const kb = opt('--kb', './kb')
const tiers = opt('--tiers', '50,150').split(',').filter(Boolean)
const arms = opt('--arms', 'bm25,vector,hybrid,graph')
const judgeModel = opt('--judge-model', null)
const k = opt('-k', '5')

const sections = []
const run = (title, argv) => {
  try {
    const out = execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    sections.push(`## ${title}\n\n\`node ${argv.join(' ')}\`\n\n${out.trim()}\n`)
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim()
    sections.push(`## ${title} — SKIPPED\n\n\`node ${argv.join(' ')}\`\n\n\`\`\`\n${detail || err.message}\n\`\`\`\n`)
  }
}

run(`Retrieval — ${kb}`, ['scripts/eval/eval.mjs', '--kb', kb, '--arms', arms, '-k', k])
for (const tier of tiers) {
  const tierKb = `scripts/eval/corpus/kb-${tier}`
  if (!fs.existsSync(tierKb)) {
    sections.push(`## Retrieval — tier ${tier} — SKIPPED\n\n${tierKb} not built. Run: \`node scripts/eval/make-corpus.mjs --tier ${tier}\` (+ \`llm-wiki embed\` for vector arms)\n`)
    continue
  }
  // generated tiers have no cross-page links → graph arm excluded by design
  const tierArms = arms.split(',').filter(a => a !== 'graph').join(',')
  run(`Retrieval — tier ${tier}`, ['scripts/eval/eval.mjs', '--kb', tierKb, '--probes', `scripts/eval/probes-${tier}.jsonl`, '--arms', tierArms, '-k', k])
}
if (judgeModel) {
  run(`Answers — ${kb} (abstention + head-to-head)`, ['scripts/eval/answer-eval.mjs', '--kb', kb, '--arms', 'bm25,hybrid', '--judge-model', judgeModel, '-k', k])
} else {
  sections.push('## Answers — SKIPPED\n\nno --judge-model given (needed for abstention classification and head-to-head judging)\n')
}

const resultsDir = 'scripts/eval/results'
fs.mkdirSync(resultsDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outFile = path.join(resultsDir, `report-${stamp}.md`)
fs.writeFileSync(outFile, `# llm-wiki eval report — ${stamp}\n\n${sections.join('\n')}`)
console.log(sections.map(s => s.split('\n')[0]).join('\n'))
console.log(`\nfull report: ${outFile}`)
