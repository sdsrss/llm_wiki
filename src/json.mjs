import fs from 'node:fs'

// JSON.parse with the offending file named in the error — a bare SyntaxError
// from a corrupt state file gives the user nothing to act on.
// redactContents: V8's SyntaxError message quotes a snippet of the input
// ("Unexpected token 'x', ...\"apiKey\": \"sk-...\" is not valid JSON");
// set it for files that may contain secrets so no fragment reaches the
// terminal or logs.
export function readJsonFile(file, { redactContents = false } = {}) {
  const text = fs.readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(redactContents ? `${file}: invalid JSON` : `${file}: invalid JSON (${err.message})`)
  }
}

// Atomic file write: `fs.writeFileSync` truncates the target *before* writing, so a
// concurrent reader (a long-lived MCP server, an `ask` fallback) can observe an empty
// or half-written file — for JSON stores that means a `JSON.parse` crash. Write a temp
// sibling and rename (atomic on the POSIX filesystems this tool supports) so a reader
// only ever sees the whole old file or the whole new one. Single source of the pattern
// that manifest/vector already used and buildIndex's derived stores previously missed.
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
