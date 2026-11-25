import type { ContributionsIssue, ContributionsPlugin } from './index.js'

export type Budget = 'toolCard' | 'panel' | 'strip'

export interface ViewIssue {
  /** Like the app: `view.children[2].items[0].action`. */
  path: string
  /** The app's words (zh or en). */
  message: string
  /** broken: that component is a placeholder; note: drawn, something ignored or cut; fatal: the whole view falls back. */
  kind: 'broken' | 'note' | 'fatal'
}

export interface ViewCheck {
  /** The view draws (possibly with placeholders). */
  ok: boolean
  /** The whole view falls back to one "plugin view has an error" line. */
  fatal: boolean
  budget: Budget
  issues: ViewIssue[]
  /** The root title the app shows (tool cards: the collapsed summary). */
  title: string | null
  bytes: number
  components: number
  placeholders: number
  empty: number
  truncated: number
}

/** Parse a view exactly as the app does (a twin of its parser). */
export function checkView(view: unknown, options?: { budget?: Budget; data?: unknown; lang?: 'zh' | 'en' }): ViewCheck

export const BUDGETS: Readonly<Record<Budget, { name: Budget; bytes: number; nodes: number; depth: number; children: number; text: number }>>

/** The bridge's reading of a package.json `dshGo`, in zh-CN and en-US, plus app-side icon checks. Null without dshGo. */
export function checkManifest(pkgJson: Record<string, unknown>, options?: {
  dir?: string
  lang?: 'zh' | 'en'
  app?: string
  registrations?: { panels: string[]; strips: string[]; handlers: string[]; dataPanels: string[] }
}): null | {
  state: ContributionsPlugin['state']
  title: string
  counts: Record<'composer.actions' | 'message.actions' | 'composer.strip' | 'panels', number>
  contributes: ContributionsPlugin['contributes']
  issues: Array<ContributionsIssue | { path: string; code: string; severity: 'error' | 'warn'; message: string }>
}

export interface PluginReport {
  kind: 'plugin'
  target: string
  unreadable?: string
  name?: string
  version?: string
  package?: Array<{ path: string; code: string; severity: 'error' | 'warn'; message: string }>
  manifest?: ReturnType<typeof checkManifest>
  load?: null | { ok: false; error: string } | { ok: true; notes: unknown[]; tools: string[]; registered: number; row: ContributionsPlugin }
  views: Array<ViewCheck & { where: string }>
}

/** Package basics, manifest, static views; `load: true` also runs the host half in a test host. */
export function checkPlugin(dirOrPackageJson: string, options?: { load?: boolean; lang?: 'zh' | 'en'; app?: string }): Promise<PluginReport>
/** A view file's text (or a tool result meta `{ "dsh-go/view": … }`, which gets the tool-card budget). */
export function checkViewText(text: string, options?: { budget?: Budget; lang?: 'zh' | 'en'; target?: string }): { kind: 'view'; target: string; unreadable?: string; views?: Array<ViewCheck & { where: string }> }
/** 0 fine, 1 some items do not apply, 2 nothing native applies / a view falls back / load failed, 3 unreadable. */
export function exitCode(report: unknown): 0 | 1 | 2 | 3
/** Human-readable lines, like the CLI prints. */
export function formatReport(report: unknown, lang?: 'zh' | 'en'): string
/** The CLI. */
export function main(argv: string[]): Promise<number>

export class SchemaSet {
  constructor(schemas?: Record<string, object>)
  /** Errors of `value` against `file#pointer` (e.g. 'contributions.schema.json', '/$defs/viewResponse'); empty when valid. */
  validate(value: unknown, file: string, pointer?: string): Array<{ path: string; schemaPath: string; message: string }>
}
export function loadSchemas(dir?: URL): Record<string, object>
