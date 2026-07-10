import fs from 'node:fs'
import { kbPaths } from './paths.mjs'

export function loadManifest(kbRoot) {
  const p = kbPaths(kbRoot)
  if (!fs.existsSync(p.manifest)) return { files: {} }
  return JSON.parse(fs.readFileSync(p.manifest, 'utf8'))
}

export function saveManifest(kbRoot, manifest) {
  const p = kbPaths(kbRoot)
  fs.writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n')
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
