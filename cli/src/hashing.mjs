import crypto from 'node:crypto'
import fs from 'node:fs'

export const sha256Text = (t) => crypto.createHash('sha256').update(t).digest('hex')
export const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function minhashSignature(text, perms = 32) {
  const norm = text.toLowerCase().replace(/\s+/g, ' ')
  const shingles = new Set()
  for (let i = 0; i <= norm.length - 5; i++) shingles.add(norm.slice(i, i + 5))
  if (shingles.size === 0) return new Array(perms).fill(0)
  const sig = new Array(perms).fill(Infinity)
  for (const s of shingles) {
    for (let p = 0; p < perms; p++) {
      const h = fnv1a(p + ' ' + s)
      if (h < sig[p]) sig[p] = h
    }
  }
  return sig
}

export function jaccardEstimate(a, b) {
  let eq = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++
  return eq / a.length
}
