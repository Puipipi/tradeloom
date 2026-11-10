/** Profile-owned configuration edits, serialized with Loader hot reload. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Context, FiberState, Service, resolveConfig } from '@deepseek-ai/cordis'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-hmr'
import { composeEntries, loadProfileDirectory, readProfilePatches, reconcileProfilePatches, validateReconcileFailureLocation, type ReconcileFailureLocation } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isSeq, parseDocument, Scalar, visit } from 'yaml'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Persistent edits to the active profile's plugin configuration. */
    configEditor: ConfigEditor
  }
}

function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : []])
}

const THEME_RECONCILE_SUMMARY = Symbol.for('tradeloom.ui18.themeReconcileSummary.v1')
type ReconcilePhase = 'before' | 'apply' | 'rollback'
type ReconcileFailureFamily = 'ui-theme' | 'ui-settings' | 'ui-layout' | 'business-shell' | 'config-editor' | 'app-boot' | 'settings-controller' | 'other' | 'multiple' | 'unknown'
type ReconcileFailureCode = 'ERR_MODULE_NOT_FOUND' | 'ERR_PACKAGE_PATH_NOT_EXPORTED' | 'ERR_REQUIRE_ESM' | 'ERR_UNKNOWN_FILE_EXTENSION' | 'ERR_INVALID_ARG_TYPE' | 'ERR_INVALID_ARG_VALUE' | 'ENOENT' | 'EACCES' | 'EPERM' | 'EEXIST' | 'ETIMEDOUT' | 'SETTINGS_CONFLICT' | 'multiple' | 'unknown'
interface ReconcileFailureDetail { family: ReconcileFailureFamily; code: ReconcileFailureCode; location?: ReconcileFailureLocation }
const RECONCILE_FAMILIES = new Set<unknown>(['ui-theme', 'ui-settings', 'ui-layout', 'business-shell', 'config-editor', 'app-boot', 'settings-controller', 'other', 'multiple', 'unknown'])
const RECONCILE_ERROR_CODES = new Set<unknown>(['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ETIMEDOUT', 'SETTINGS_CONFLICT', 'multiple', 'unknown'])

function readReconcileFailure(error: unknown): ReconcileFailureDetail | undefined {
  try {
    const inspect = (candidate: unknown): ReconcileFailureDetail | undefined => {
      if ((typeof candidate !== 'object' || candidate === null) && typeof candidate !== 'function') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(candidate, THEME_RECONCILE_SUMMARY)
      const summary = descriptor && 'value' in descriptor ? descriptor.value : undefined
      if (summary === null || typeof summary !== 'object') return undefined
      const own = (key: string) => Object.getOwnPropertyDescriptor(summary, key)?.value
      if (own('failureCode') !== 'profile-reconcile-inactive') return undefined
      const family = own('introducedFailureFamily')
      const code = own('introducedFailureCode')
      if (!RECONCILE_FAMILIES.has(family) || !RECONCILE_ERROR_CODES.has(code)) return undefined
      const location = validateReconcileFailureLocation(own('introducedFailureLocation'))
      return { family: family as ReconcileFailureFamily, code: code as ReconcileFailureCode, ...(location ? { location } : {}) }
    }
    const direct = inspect(error)
    if (direct) return direct
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined
    const cause = Object.getOwnPropertyDescriptor(error, 'cause')
    return cause && 'value' in cause ? inspect(cause.value) : undefined
  } catch { return undefined }
}

function attachEditorPhase(error: unknown, editorPhase: ReconcilePhase, applyFailure?: ReconcileFailureDetail): void {
  try {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return
    const descriptor = Object.getOwnPropertyDescriptor(error, THEME_RECONCILE_SUMMARY)
    const summary = descriptor && 'value' in descriptor ? descriptor.value : undefined
    if (summary === null || typeof summary !== 'object') return
    const failureCode = Object.getOwnPropertyDescriptor(summary, 'failureCode')?.value
    const inactive = Object.getOwnPropertyDescriptor(summary, 'introducedInactiveCount')?.value
    const failed = Object.getOwnPropertyDescriptor(summary, 'introducedFailedCount')?.value
    const pending = Object.getOwnPropertyDescriptor(summary, 'introducedPendingCount')?.value
    const family = Object.getOwnPropertyDescriptor(summary, 'introducedFailureFamily')?.value
    const code = Object.getOwnPropertyDescriptor(summary, 'introducedFailureCode')?.value
    const bucket = (value: unknown) => value === '0' || value === '1' || value === '2_plus'
    if (failureCode !== 'profile-reconcile-inactive' || !bucket(inactive) || !bucket(failed) || !bucket(pending)) return
    const safeFailure = readReconcileFailure(error) ?? {
      family: RECONCILE_FAMILIES.has(family) ? family as ReconcileFailureFamily : 'unknown',
      code: RECONCILE_ERROR_CODES.has(code) ? code as ReconcileFailureCode : 'unknown',
      location: validateReconcileFailureLocation(Object.getOwnPropertyDescriptor(summary, 'introducedFailureLocation')?.value),
    }
    Object.defineProperty(error, THEME_RECONCILE_SUMMARY, {
      value: Object.freeze({
        failureCode, introducedInactiveCount: inactive, introducedFailedCount: failed, introducedPendingCount: pending,
        introducedFailureFamily: safeFailure.family, introducedFailureCode: safeFailure.code,
        ...(safeFailure.location ? { introducedFailureLocation: safeFailure.location } : {}),
        ...(applyFailure ? { applyFailureFamily: applyFailure.family, applyFailureCode: applyFailure.code } : {}),
        ...(applyFailure?.location ? { applyFailureLocation: applyFailure.location } : {}),
        editorPhase,
      }),
      enumerable: false, configurable: true,
    })
  } catch { /* phase reporting must not replace the original failure */ }
}

/** Persist complete raw configs and apply them through the normal Loader path. */
export class ConfigEditor extends Service {
  static inject = ['loader', 'profileContext']

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'configEditor')
  }

  /** The profile patch edited by this service. */
  get documentPath(): string { return this.ownerContext.profileContext.patchPath }

  /** Addressable profile rows; nested Includes have independent configuration ownership.
   * @returns Active entries with unique profile patch ids.
   */
  entries(): Entry[] {
    const candidates = [...this.ownerContext.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of candidates) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return candidates.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** Read inherited and explicit profile values for the active entries.
   * @returns Detached layer values alongside their Loader entries.
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    const profile = this.ownerContext.profileContext
    const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
    const entries = this.entries()
    // An own config key can replace inherited config even when its value is undefined.
    const overridden = new Set(loaded.patches.filter(patch => patch.insert === undefined && Object.hasOwn(patch, 'config')).map(patch => patch.id))
    const composed = new Map<string, EntryOptions>()
    if (entries.some(entry => !overridden.has(entry.options.id))) {
      for (const row of flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches]))) {
        if (!composed.has(row.id)) composed.set(row.id, row)
      }
    }
    return entries.map(entry => ({
      entry,
      inherited: overridden.has(entry.options.id)
        ? this.inherited(entry, loaded)
        : structuredClone((composed.get(entry.options.id)?.config ?? {}) as Record<string, unknown>),
      override: structuredClone((loaded.patches.findLast(
        row => row.id === entry.options.id && row.config !== undefined,
      )?.config ?? {}) as Record<string, unknown>),
    }))
  }

  private inherited(entry: Entry, loaded: ReturnType<typeof loadProfileDirectory>): Record<string, unknown> {
    const patches = loaded.patches.map((patch) => {
      if (patch.id !== entry.options.id || patch.insert !== undefined) return patch
      const rest = { ...patch }; Reflect.deleteProperty(rest, 'config')
      return rest
    })
    const row = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), patches])).find(row => row.id === entry.options.id)
    return structuredClone((row?.config ?? {}) as Record<string, unknown>)
  }

  /** Validate, persist, and reconcile a plugin's next config; ordinary fields keep normal lifecycle rules.
   * @param entry Current Loader entry, also used to detect replacement during the write.
   * @param change Derive a raw config from the current entry and its inherited layer.
   * @returns Fulfillment after Loader reconciliation completes.
   */
  async edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const path = this.documentPath
      await withFileLock(join(this.ownerContext.profileContext.dir, 'package.json'), async () => {
        if (!this.entries().includes(entry) || entry.fiber === undefined) throw new Error('Configuration entry is no longer available')
        const beforePatches = readProfilePatches('dsh', this.ownerContext.profileContext)
        try { await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh') }
        catch (error) { attachEditorPhase(error, 'before'); throw error }
        if (!this.entries().includes(entry)) throw new Error('Configuration entry changed during reload')
        const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
        const inherited = this.inherited(entry, loadProfileDirectory('dsh', this.ownerContext.profileContext.dir, this.ownerContext.profileContext.installAnchor))
        const next = change(current, inherited)
        const fiber = entry.fiber
        if (fiber.state !== FiberState.ACTIVE) throw new Error('Configuration plugin is no longer active')
        const resolved: unknown = fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)
        resolveConfig(fiber.runtime as NonNullable<typeof fiber.runtime>, resolved)
        let before: string
        try { before = await readFile(path, 'utf8') }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          before = '[]\n'
        }
        const document = parseDocument(before, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        if (document.errors[0] !== undefined) throw document.errors[0]
        if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
        document.contents.flow = false
        const index = document.contents.items.findLastIndex((item, index) => isMap(item)
          && document.getIn([index, 'id']) === entry.options.id && !item.has('insert')
          && (!item.has('name') || document.getIn([index, 'name']) === entry.options.name))
        if (isDeepStrictEqual(next, inherited)) {
          for (let index = document.contents.items.length - 1; index >= 0; index--) {
            const row = document.contents.items[index]
            if (!isMap(row) || document.getIn([index, 'id']) !== entry.options.id || row.has('insert')) continue
            row.delete('config')
            if (row.items.length === Number(row.has('id')) + Number(row.has('name'))) document.delete(index)
          }
        } else if (index < 0) document.add(document.createNode({ id: entry.options.id, name: entry.options.name, config: next }))
        else document.setIn([index, 'config'], document.createNode(next))
        visit(document, { Map(_key, node) {
          if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') return
          const expression = new Scalar(node.get('__jsExpr'))
          expression.tag = 'tag:yaml.org,2002:js'
          return expression
        } })
        const profile = this.ownerContext.profileContext
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const patches = readProfilePatches('dsh', profile, { ...loaded, patches: yaml.load(String(document), { schema: entryListSchema }) as PatchOptions[] })
        const effective = flatten(composeEntries([patches])).find(row => row.id === entry.options.id)
        if (!isDeepStrictEqual(effective?.config ?? {}, next)) {
          throw new Error(`Configuration for "${entry.options.id}" is overridden by a home patch or command-line overlay`)
        }
        await writeFileAtomic(path, String(document), { mode: 0o600 })
        try {
          await reconcileProfilePatches(this.ownerContext.root, patches, 'dsh', [entry.options.id])
        } catch (error) {
          attachEditorPhase(error, 'apply')
          const applyFailure = readReconcileFailure(error) ?? { family: 'unknown', code: 'unknown' }
          try {
            await writeFileAtomic(path, before, { mode: 0o600 })
            await reconcileProfilePatches(this.ownerContext.root, beforePatches, 'dsh')
          } catch (rollbackError) {
            attachEditorPhase(rollbackError, 'rollback', applyFailure)
            throw rollbackError
          }
          throw error
        }
      })
    }
    const hmr = this.ownerContext.get('hmr')
    await (hmr === undefined ? run() : hmr.runExclusive(run))
  }
}

export default ConfigEditor
