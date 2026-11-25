// Test helper: lets `import { defineTool } from '@deepseek-ai/dsh-tools'`
// resolve outside a DSH profile. Uses a real DSH install when one is found
// (DSH_TOOLS_DIR, or the dsh CLI on PATH), else a stub that returns the
// definition as is. Import this file before lib/index.js.
import { existsSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function findRealDshTools() {
  const candidates = []
  if (process.env.DSH_TOOLS_DIR) candidates.push(process.env.DSH_TOOLS_DIR)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'dsh')
    if (!existsSync(bin)) continue
    try {
      // <prefix>/bin/dsh -> <prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
      const pkg = dirname(dirname(realpathSync(bin)))
      candidates.push(join(pkg, 'node_modules', '@deepseek-ai', 'dsh-tools'))
    } catch {}
  }
  const hit = candidates.find((dir) => existsSync(join(dir, 'lib', 'index.js')))
  return hit === undefined ? undefined : pathToFileURL(join(hit, 'lib', 'index.js')).href
}

export const realDshTools = findRealDshTools()
const target = realDshTools ?? new URL('./dsh-tools-stub.js', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: target, shortCircuit: true }
    return next(specifier, context)
  },
})

/** Loads the plugin's apply() against a fake ctx and returns the registered tools by name. */
export async function registeredTools() {
  const plugin = await import('../lib/index.js')
  const tools = new Map()
  plugin.apply({ tools: { register: (def) => tools.set(def.name, def) } })
  return tools
}
