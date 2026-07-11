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
