// Explicit pinned SDK input for these integration tests; no dependency fallback.
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
assert.ok(process.env.TL_SEVEN_SDK_RUNTIME, 'explicit rc2 SDK runtime required')
const runtime = createRequire(pathToFileURL(join(process.env.TL_SEVEN_SDK_RUNTIME, 'package.json')))
assert.equal(runtime('./package.json').version, '0.2.2-rc.2')
let resolving = false
registerHooks({ resolve(specifier, context, next) {
  if (!resolving && (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@modelcontextprotocol/'))) {
    resolving = true
    try { return { url: pathToFileURL(runtime.resolve(specifier)).href, shortCircuit: true } }
    finally { resolving = false }
  }
  return next(specifier, context)
} })
