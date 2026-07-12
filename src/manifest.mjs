import fs from 'node:fs'
import { kbPaths } from './paths.mjs'
import { readJsonFile, writeFileAtomic } from './json.mjs'

export function loadManifest(kbRoot) {
  const p = kbPaths(kbRoot)
  if (!fs.existsSync(p.manifest)) return { files: {} }
  const m = readJsonFile(p.manifest)
  // Shape guard: a hand-edited or half-written manifest lacking `files` (or with a
  // non-object there) would make diffManifest's `Object.keys(manifest.files)` throw.
  return (m && typeof m.files === 'object' && m.files !== null && !Array.isArray(m.files)) ? m : { files: {} }
}

export function saveManifest(kbRoot, manifest) {
  const p = kbPaths(kbRoot)
  // Atomic write (shared writeFileAtomic): manifest is non-derived state (hash->raw
  // map) and a crash or concurrent reader must never see a truncated/corrupt file.
  writeFileAtomic(p.manifest, JSON.stringify(manifest, null, 2) + '\n')
}

export function diffManifest(manifest, entries) {
  const added = [], changed = [], unchanged = []
  const seen = new Set()
  for (const e of entries) {
    seen.add(e.rel)
    const prev = manifest.files[e.rel]
    if (!prev) added.push(e)
    else if (prev.hash !== e.hash) changed.push(e)
    else unchanged.push(e)
  }
  const removed = Object.keys(manifest.files).filter(rel => !seen.has(rel))
  return { added, changed, removed, unchanged }
}
