#!/usr/bin/env node
// Generates wire types from schema/*.schema.json and public SDK declarations
// from scripts/types/index.d.ts.in. Run after a schema or template change:
//
//   node scripts/gen-types.mjs           write schema, index and testing declarations
//   node scripts/gen-types.mjs --check   exit 1 if any output is out of date
//
// Handles the JSON Schema subset these files use: $ref (local and
// cross-file), const, enum, anyOf / oneOf, type (incl. arrays), properties /
// required / additionalProperties, items, and the `allOf: [{if: {properties:
// {type: {const}}}, then}]` pattern that view.schema.json uses to switch on a
// component's `type` (emitted as a discriminated union).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** File -> type-name prefix and the name of its root type. */
const FILES = {
  'view.schema.json': { prefix: 'View', rootName: 'View' },
  'manifest.schema.json': { prefix: 'Manifest', rootName: 'Manifest' },
  'invoke.schema.json': { prefix: 'Invoke', rootName: 'InvokeRequestRoot' },
  'contributions.schema.json': { prefix: 'Contributions', rootName: 'ContributionsResponse' },
  'stream.schema.json': { prefix: 'Stream', rootName: 'StreamMessage' },
}

const schemas = Object.fromEntries(
  Object.keys(FILES).map((f) => [f, JSON.parse(readFileSync(join(root, 'schema', f), 'utf8'))]),
)

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase())
const typeName = (file, def) => `${FILES[file].prefix}${pascal(def)}`
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const key = (k) => (IDENT.test(k) ? k : JSON.stringify(k))

function refName(ref, file) {
  const [target, pointer] = ref.split('#')
  const f = target === '' ? file : target
  if (!(f in FILES)) throw new Error(`unknown $ref target ${ref} in ${file}`)
  if (pointer === undefined || pointer === '') return FILES[f].rootName
  const m = /^\/\$defs\/([^/]+)$/.exec(pointer)
  if (!m) throw new Error(`unsupported $ref ${ref}`)
  return typeName(f, m[1])
}

const comment = (text, indent) => {
  if (!text) return ''
  const lines = String(text).split('\n')
  if (lines.length === 1) return `${indent}/** ${lines[0].replaceAll('*/', '*\\/')} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l.replaceAll('*/', '*\\/')}`).join('\n')}\n${indent} */\n`
}

/** The `type` discriminator values a node schema switches on, if it uses allOf/if/then. */
function discriminated(schema) {
  if (!Array.isArray(schema.allOf) || schema.properties?.type?.enum === undefined) return undefined
  const thens = new Map()
  for (const branch of schema.allOf) {
    const value = branch?.if?.properties?.type?.const
    if (typeof value !== 'string' || branch.then === undefined) return undefined
    thens.set(value, branch.then)
  }
  return { values: schema.properties.type.enum, thens }
}

function union(parts) {
  const unique = [...new Set(parts)]
  if (unique.length === 0) return 'never'
  return unique.length === 1 ? unique[0] : unique.map((p) => (p.includes(' & ') ? `(${p})` : p)).join(' | ')
}

function objectType(schema, file, indent, omit = []) {
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const lines = []
  for (const [k, sub] of Object.entries(props)) {
    if (omit.includes(k)) continue
    const desc = typeof sub === 'object' ? sub.description : undefined
    lines.push(`${comment(desc, indent + '  ')}${indent}  ${key(k)}${required.has(k) ? '' : '?'}: ${ts(sub, file, indent + '  ')}`)
  }
  const extra = schema.additionalProperties
  if (typeof extra === 'object' && extra !== null) {
    lines.push(`${indent}  [key: string]: ${ts(extra, file, indent + '  ')}`)
  } else if (Object.keys(props).length === 0 && extra !== false && schema.unevaluatedProperties !== false) {
    return 'Record<string, unknown>'
  }
  if (lines.length === 0) return 'Record<string, never>'
  return `{\n${lines.join('\n')}\n${indent}}`
}

function ts(schema, file, indent = '') {
  if (schema === true || schema === undefined) return 'unknown'
  if (schema === false) return 'never'
  if (schema.$ref) return refName(schema.$ref, file)
  if ('const' in schema) return JSON.stringify(schema.const)
  if (Array.isArray(schema.enum)) return union(schema.enum.map((v) => JSON.stringify(v)))
  if (Array.isArray(schema.anyOf)) return union(schema.anyOf.map((s) => ts(s, file, indent)))
  if (Array.isArray(schema.oneOf)) return union(schema.oneOf.map((s) => ts(s, file, indent)))
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type]
  if (types.length === 0) {
    if (schema.properties || schema.required) return objectType(schema, file, indent)
    return 'unknown'
  }
  return union(types.map((t) => {
    switch (t) {
      case 'string': return 'string'
      case 'number':
      case 'integer': return 'number'
      case 'boolean': return 'boolean'
      case 'null': return 'null'
      case 'array': {
        const item = schema.items === undefined ? 'unknown' : ts(schema.items, file, indent)
        return /[|&]/.test(item) ? `Array<${item}>` : `${item}[]`
      }
      case 'object': return objectType(schema, file, indent)
      default: throw new Error(`unsupported type ${t}`)
    }
  }))
}

function emitDef(file, name, schema, out) {
  const disc = discriminated(schema)
  if (disc !== undefined) {
    const base = objectType({ ...schema, required: (schema.required ?? []).filter((r) => r !== 'type') }, file, '', ['type'])
    const members = []
    for (const value of disc.values) {
      const member = `${FILES[file].prefix}${pascal(value)}Component`
      const then = disc.thens.get(value)
      const parts = [`{ type: ${JSON.stringify(value)} }`]
      if (base !== 'Record<string, never>') parts.push(`${name}Base`)
      if (then !== undefined) parts.push(ts(then, file))
      out.push(`/** \`${value}\` */\nexport type ${member} = ${parts.join(' & ')}\n`)
      members.push(member)
    }
    if (base !== 'Record<string, never>') out.splice(out.length - members.length, 0, `${comment('Properties every component accepts.', '')}export interface ${name}Base ${base}\n`)
    out.push(`${comment(schema.description, '')}export type ${name} =\n  | ${members.join('\n  | ')}\n`)
    return
  }
  const body = ts(schema, file)
  // An interface only for a single object literal (not a union of them).
  const single = body.startsWith('{\n') && body.endsWith('\n}') && !/^\} \|/m.test(body)
  if (single) out.push(`${comment(schema.description, '')}export interface ${name} ${body}\n`)
  else out.push(`${comment(schema.description, '')}export type ${name} = ${body}\n`)
}

function generate() {
  const out = [
    '// GENERATED by scripts/gen-types.mjs from schema/*.schema.json — do not edit.',
    '// Run `node scripts/gen-types.mjs` after changing a schema.',
    '/* eslint-disable */',
    '',
  ]
  for (const [file, { rootName }] of Object.entries(FILES)) {
    const schema = schemas[file]
    out.push(`// ── ${file} ${'─'.repeat(Math.max(0, 70 - file.length))}\n`)
    for (const [def, sub] of Object.entries(schema.$defs ?? {})) emitDef(file, typeName(file, def), sub, out)
    const rootSchema = { ...schema }
    delete rootSchema.$defs
    delete rootSchema.$schema
    delete rootSchema.$id
    delete rootSchema.title
    for (const k of Object.keys(rootSchema)) if (k.startsWith('x-')) delete rootSchema[k]
    emitDef(file, rootName, { ...rootSchema, description: schema.title }, out)
  }
  return out.join('\n')
}

// The public service/builder declarations have a source template too. This keeps
// these declarations generated while schema remains the source of wire shapes.
const controlBuilders = schemas['view.schema.json']['x-dsh-go']?.controlBuilders ?? []
const builderDeclarations = controlBuilders.map(name => {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error('invalid control builder name')
  const type = `View${pascal(name)}Component`
  return `export function ${name}(props: Omit<import('./schema.js').${type}, 'type'>): import('./schema.js').${type}`
}).join('\n')
const publicTypes = readFileSync(join(here, 'types', 'index.d.ts.in'), 'utf8')
  .replace('// generated control builders', builderDeclarations).trimEnd() + '\n'
const outputs = {
  'schema.d.ts': generate(),
  'index.d.ts': '// GENERATED by scripts/gen-types.mjs — do not edit.\n' + publicTypes,
  'testing.d.ts': '// GENERATED by scripts/gen-types.mjs — do not edit.\n' + readFileSync(join(here, 'types', 'testing.d.ts.in'), 'utf8'),
}
let stale = false
for (const [name, text] of Object.entries(outputs)) {
  const target = join(root, 'types', name)
  if (process.argv.includes('--check')) {
    let current = ''
    try { current = readFileSync(target, 'utf8') } catch {}
    if (current !== text) {
      process.stderr.write(`types/${name} is out of date: run node scripts/gen-types.mjs\n`)
      stale = true
    }
  } else {
    writeFileSync(target, text)
    process.stdout.write(`wrote ${target}\n`)
  }
}
if (stale) process.exitCode = 1
