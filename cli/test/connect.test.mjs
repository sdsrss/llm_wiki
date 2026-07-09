import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectProject } from '../src/connect.mjs'

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

test('connect adds sentinel block, updates registry, removes cleanly', (t) => {
  const proj = tmp(t)
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# My project\n\nuser content\n')
  connectProject(proj, { kb: '../kb-a', role: 'project' })
  connectProject(proj, { kb: '/abs/kb-b', role: 'reference' })
  const md = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8')
  assert.match(md, /user content/)
  assert.equal(md.match(/llm-wiki:begin/g).length, 1, 'single managed block')
  assert.match(md, /role=project path=\.\.\/kb-a/)
  assert.match(md, /role=reference path=\/abs\/kb-b/)
  const reg = JSON.parse(fs.readFileSync(path.join(proj, '.llm-wiki.json'), 'utf8'))
  assert.equal(reg.kbs.length, 2)
  connectProject(proj, { kb: '../kb-a', remove: true })
  const md2 = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8')
  assert.ok(!/kb-a/.test(md2))
  assert.match(md2, /kb-b/)
  connectProject(proj, { kb: '/abs/kb-b', remove: true })
  const md3 = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8')
  assert.ok(!/llm-wiki:begin/.test(md3), 'block removed when registry empty')
  assert.match(md3, /user content/)
})

test('connect creates CLAUDE.md when absent', (t) => {
  const proj = tmp(t)
  connectProject(proj, { kb: './kb', role: 'project' })
  assert.match(fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8'), /llm-wiki:begin/)
})
