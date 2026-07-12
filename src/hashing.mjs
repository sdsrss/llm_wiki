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

// Prefix cap for the shingle scan. minhashSignature is O(text length x perms): the
// shingle Set grows with the file and each shingle is hashed `perms` times, so a large
// input is far more expensive than the sha256+read that gates it (measured: 2MB of
// high-entropy text ~7s / 350MB RSS at 128 perms). The scanner's maxFileBytes cap
// (50MB, sized for I/O) does NOT bound this, so a single large legit .txt/.md would
// hang `scan` for minutes. Cap the *shingled* text to a prefix: near-duplicate files
// almost always diverge late, so a prefix signature still catches them, and the cost
// is bounded regardless of file size. Exact duplicates are caught separately by full
// sha256, so the prefix only ever affects the fuzzy near-dup estimate.
export const MINHASH_MAX_SHINGLE_CHARS = 262144 // 256 KiB of normalized text

// 128 permutations, not 32: the near-dup estimate's standard error is ~sqrt(J(1-J)/perms),
// so at 32 perms a genuine near-duplicate (true Jaccard ~0.90) estimated as low as 0.84 and
// fell below NEAR_DUP_THRESHOLD (0.85), silently missing it (QA73-002). 128 perms tightens the
// estimate (SD ~0.026) so real near-dups clear the threshold; the cost is trivial next to the
// per-file sha256+read scan already does, and `_sig` is stripped before the plan is persisted.
export function minhashSignature(text, perms = 128) {
  let norm = text.toLowerCase().replace(/\s+/g, ' ')
  if (norm.length > MINHASH_MAX_SHINGLE_CHARS) norm = norm.slice(0, MINHASH_MAX_SHINGLE_CHARS)
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
