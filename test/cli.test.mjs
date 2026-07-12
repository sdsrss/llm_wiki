import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { initKb } from '../src/init.mjs'
import { installSkills } from '../src/connect.mjs'

// R5 (audit): installSkills had zero coverage and most CLI commands were only tested
// at the library-function level, so a flag-name/opts-wiring regression would ship
// silently. These smokes drive the real commander layer through bin/llm-wiki.mjs.

const BIN = fileURLToPath(new URL('../bin/llm-wiki.mjs', import.meta.url))
const REPO_SKILLS = fileURLToPath(new URL('../skills', import.meta.url))

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-cli-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' })

// build a small KB with two linked pages so index/lint/graph have something to chew on
function seedKb(d) {
  initKb(d)
  fs.writeFileSync(path.join(d, 'raw/a.md'), 'raw a')
  fs.writeFileSync(path.join(d, 'wiki/sources/a.md'),
    `---\ntype: source\ntitle: A\ndescription: source a\ntags: [x]\nsources: [raw/a.md]\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n\nbody [[entities/thing]]`)
  fs.writeFileSync(path.join(d, 'wiki/entities/thing.md'),
    `---\ntype: entity\ntitle: Thing\ndescription: the thing\ntags: [x]\nsources: [raw/a.md]\ncreated: 2026-07-11\nupdated: 2026-07-11\n---\n\nbody`)
}

test('installSkills copies each skill dir into <target>/skills', (t) => {
  const d = tmp(t)
  const { installed } = installSkills(path.join(d, '.claude'), REPO_SKILLS)
  assert.ok(installed.includes('wiki-build'), 'wiki-build installed')
  assert.ok(fs.existsSync(path.join(d, '.claude/skills/wiki-build/SKILL.md')), 'SKILL.md copied')
  // installed set matches the skill directories in the repo (dirs only, no stray files)
  const repoDirs = fs.readdirSync(REPO_SKILLS).filter(n => fs.statSync(path.join(REPO_SKILLS, n)).isDirectory()).sort()
  assert.deepEqual(installed.sort(), repoDirs)
})

test('install-skills CLI copies skills into the target dir', (t) => {
  const d = tmp(t)
  const r = run('install-skills', '--target', path.join(d, '.claude'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /installed skills:.*wiki-build/)
  assert.ok(fs.existsSync(path.join(d, '.claude/skills/wiki-query/SKILL.md')))
})

test('index / lint / status / graph CLI commands wire through to their modules', (t) => {
  const d = tmp(t)
  seedKb(d)
  assert.match(run('index', '--kb', d).stdout, /indexed 2 pages/)
  assert.equal(run('lint', '--kb', d).status, 0)
  assert.match(run('status', '--kb', d).stdout, /all raw files compiled|uncompiled raw/)
  // graph subcommands (index built graph.json above)
  assert.match(run('graph', 'neighbors', 'sources/a', '--kb', d).stdout, /entities\/thing/)
  assert.match(run('graph', 'hubs', '--kb', d).stdout, /sources\/a|entities\/thing/)
  assert.match(run('graph', 'path', 'sources/a', 'entities/thing', '--kb', d).stdout, /entities\/thing/)
  // --kb also works at the PARENT level (like every other command: `<cmd> --kb ...`),
  // not only after the subcommand — regression guard for the graph option placement.
  const parentKb = run('graph', '--kb', d, 'hubs')
  assert.equal(parentKb.status, 0, parentKb.stderr)
  assert.match(parentKb.stdout, /sources\/a|entities\/thing/)
})

test('index CLI warns on stderr when a page is skipped for invalid frontmatter (QA73-001)', (t) => {
  const d = tmp(t)
  seedKb(d)
  // hand-edited page with broken YAML — the documented post-edit step is `index`, not `lint`
  fs.writeFileSync(path.join(d, 'wiki/concepts/bad.md'), '---\ntitle: Bad\n  bad: [unclosed\n---\n# body\n')
  const r = run('index', '--kb', d)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /indexed 2 pages/, 'stdout still reports the valid page count')
  assert.match(r.stderr, /skipped 1 page.*invalid frontmatter/i, 'the silent drop is surfaced on stderr')
  assert.match(r.stderr, /concepts\/bad\.md/, 'the offending page is named')
})

test('connect CLI writes the sentinel block into a project CLAUDE.md', (t) => {
  const proj = tmp(t)
  const r = run('connect', proj, '--kb', './kb')
  assert.equal(r.status, 0, r.stderr)
  assert.match(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8'), /llm-wiki:begin[\s\S]*role=project path=\.\/kb/)
})

test('export CLI writes each graph format', (t) => {
  const d = tmp(t)
  seedKb(d)
  run('index', '--kb', d)
  for (const fmt of ['graphml', 'cypher', 'html', 'markdown']) {
    const r = run('export', '--kb', d, '--format', fmt)
    assert.equal(r.status, 0, `${fmt}: ${r.stderr}`)
  }
  assert.ok(fs.existsSync(path.join(d, 'graph.graphml')))
  assert.ok(fs.existsSync(path.join(d, 'wiki-md/index.md')))
})

test('CLI rejects non-positive-integer numeric flags with a clear error', (t) => {
  const d = tmp(t)
  seedKb(d)
  run('index', '--kb', d)
  const k = run('ask', 'q', '--kb', d, '-k', '0', '--retrieve-only')
  assert.equal(k.status, 1)
  assert.match(k.stderr, /invalid -k value/)
  const depth = run('graph', 'neighbors', 'sources/a', '--kb', d, '--depth', 'x')
  assert.equal(depth.status, 1)
  assert.match(depth.stderr, /invalid depth/)
  const top = run('graph', 'hubs', '--kb', d, '--top', '-3')
  assert.equal(top.status, 1)
  assert.match(top.stderr, /invalid --top/)
})

test('ask --retrieve-only prints the populated hit format (score / relPath / sources)', (t) => {
  const d = tmp(t)
  seedKb(d)
  run('index', '--kb', d)
  const r = run('ask', 'body thing', '--kb', d, '--retrieve-only')
  assert.equal(r.status, 0, r.stderr)
  // bin/llm-wiki.mjs:98 formats each hit as `score.toFixed(3)  relPath  [sources]`
  assert.match(r.stdout, /^\d\.\d{3}\s+(sources|entities)\/\S+\.md\s+\[[a-z0-9+]+\]/m, 'populated hit line format')
})

test('lint --fix rebuilds the derived index', (t) => {
  const d = tmp(t)
  seedKb(d)
  const r = run('lint', '--kb', d, '--fix')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /autoFixed: index-rebuilt/)
  assert.ok(fs.existsSync(path.join(d, 'wiki/graph.json')), 'index rebuild wrote graph.json')
})

test('status --src reports the source diff against the KB', (t) => {
  const d = tmp(t)
  const src = tmp(t)
  seedKb(d)
  fs.writeFileSync(path.join(src, 'new.md'), '# New\nnever-scanned content')
  const r = run('status', '--kb', d, '--src', src)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /src diff: \+\d+ ~\d+ -\d+ =\d+/, 'prints the incremental diff line')
})

test('connect --role and --remove wire through the CLI', (t) => {
  const proj = tmp(t)
  const added = run('connect', proj, '--kb', './kb', '--role', 'reference')
  assert.equal(added.status, 0, added.stderr)
  assert.match(added.stdout, /reference:\.\/kb/, 'role flag reflected in output')
  const removed = run('connect', proj, '--kb', './kb', '--remove')
  assert.equal(removed.status, 0, removed.stderr)
  assert.match(removed.stdout, /registered kbs: none/, 'remove detaches the kb')
})

test('export --out writes to a custom path', (t) => {
  const d = tmp(t)
  seedKb(d)
  run('index', '--kb', d)
  const out = path.join(d, 'custom', 'g.graphml')
  const r = run('export', '--kb', d, '--format', 'graphml', '--out', out)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(fs.existsSync(out), '--out path created (with parent dirs)')
})

test('scan --follow-symlinks flag is accepted and scans normally', (t) => {
  const d = tmp(t)
  const src = tmp(t)
  initKb(d)
  fs.writeFileSync(path.join(src, 'doc.md'), '# Doc\ncontent')
  const r = run('scan', src, '--kb', d, '--follow-symlinks')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /files: 1/)
})

test('embed exits with a clear error when no LLM/embeddingModel is configured', (t) => {
  const d = tmp(t)
  seedKb(d)
  // Hermetic: force an empty config dir + clear builtin + bootstrap keys so "no config"
  // is genuine (mirrors the ask/mcp hermeticity contract).
  const env = { ...process.env, LLM_WIKI_CONFIG_DIR: path.join(d, 'empty-cfg') }
  delete env.OPENAI_API_KEY; delete env.OPENROUTER_API_KEY; delete env.LLM_WIKI_API_KEY
  fs.mkdirSync(env.LLM_WIKI_CONFIG_DIR)
  const r = spawnSync(process.execPath, [BIN, 'embed', '--kb', d], { encoding: 'utf8', env })
  assert.equal(r.status, 1, 'no provider → exit 1')
  assert.match(r.stderr, /No (LLM configured|embedding model configured)/i)
})

test('convert exits non-zero when every file fails but stays 0 on partial success', (t) => {
  const d = tmp(t)
  const src = tmp(t)
  initKb(d)
  // a corrupt PDF fails to convert; nothing else in the plan -> total failure
  fs.writeFileSync(path.join(src, 'bad.pdf'), '%PDF-1.4 not actually a pdf')
  run('scan', src, '--kb', d)
  const allFail = run('convert', '--kb', d)
  assert.equal(allFail.status, 1, 'total conversion failure must exit 1')
  assert.match(allFail.stdout, /converted 0, failed 1/)

  // add a good markdown file: now one converts, one fails -> partial success, exit 0
  fs.writeFileSync(path.join(src, 'good.md'), '# Good\nreal content here')
  run('scan', src, '--kb', d)
  const partial = run('convert', '--kb', d)
  assert.equal(partial.status, 0, 'partial success must stay exit 0')
  assert.match(partial.stdout, /converted 1, failed 1/)
})
