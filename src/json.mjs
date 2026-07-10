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
