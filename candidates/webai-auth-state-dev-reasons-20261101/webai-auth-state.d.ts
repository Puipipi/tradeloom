export type WebAiProvider = 'deepseek' | 'doubao'
export type WebAiAuthState = 'unknown' | 'unauthenticated' | 'authenticated'
export type WebAiAuthEvidence = 'none' | 'deepseek-sign-in-path' | 'doubao-login-button'
export interface WebAiAuthStateDto {
  readonly provider: WebAiProvider
  readonly authState: WebAiAuthState
  readonly evidence: WebAiAuthEvidence
  readonly generation: number
}

export interface WebAiDocumentIdentity {
  /** Host-internal URL; it is never included in the public DTO. */
  readonly url: string
  /** Host-owned main-document token, changed for every new document. */
  readonly documentId: string
  readonly alive: boolean
}

export interface WebAiAuthStateAdapterOptions {
  readonly provider: WebAiProvider
  readonly readDocumentIdentity: () => WebAiDocumentIdentity
  /** Host-only isolated-world executor. The adapter supplies its fixed probe script. */
  readonly executeReadOnlyProbe?: (script: string) => unknown | Promise<unknown>
  readonly subscribeLifecycle?: (listener: (event: string) => void) => () => void
}

export interface WebAiAuthStateAdapter {
  getState(): WebAiAuthStateDto
  sample(): Promise<WebAiAuthStateDto>
  /** Read-only semantic sample; it never changes authState or emits authenticated. */
  sampleAccountMenu(): Promise<DoubaoAccountMenuEvidence | DeepSeekAccountMenuEvidence>
  /** Temporary host-only bounded diagnostics; not exposed through normal status. */
  sampleDeepSeekMenuDevelopment(): Promise<DeepSeekMenuDevelopmentSample>
  dispose(): void
}

export interface DeepSeekMenuDevelopmentPathEntry {
  readonly tag: string
  readonly role?: string
  readonly classes: readonly string[]
}

export interface DeepSeekMenuDevelopmentSample {
  readonly status: 'observed' | 'unknown'
  readonly provider: 'deepseek'
  readonly reason: DeepSeekDevelopmentReason
  readonly budgetKind: DeepSeekDevelopmentBudgetKind
  readonly rootCount: number
  readonly visitedNodes: number
  readonly processedRoots: number
  readonly downloadMobileAppVisible: boolean
  readonly settingsVisible: boolean
  readonly helpAndFeedbackVisible: boolean
  readonly logoutVisible: boolean
  readonly sameRestrictedContainer: boolean
  readonly containerPath: readonly DeepSeekMenuDevelopmentPathEntry[]
  readonly generation: number
}

/** Temporary diagnostic labels only; these values never determine authState. */
export type DeepSeekDevelopmentReason =
  | 'matched'
  | 'no_same_container_match'
  | 'roots_missing'
  | 'roots_over_limit'
  | 'traversal_budget_exceeded'
  | 'probe_error'
  | 'document_identity_unavailable'
  | 'unsupported_origin'
  | 'generation_changed_or_disposed'
  | 'document_changed'
  | 'projection_rejected'
  | 'adapter_unavailable'

export type DeepSeekDevelopmentBudgetKind =
  | 'none'
  | 'per_root'
  | 'total_nodes'
  | 'direct_children'
  | 'children'
  | 'stack'

export interface WebAiMenuTriggerEvidence {
  readonly triggerPresent: boolean
  readonly triggerVisible: boolean
  readonly hasPopup: boolean
  readonly linked: boolean
  /** Presence only; this does not assert the value or meaning of a shortcut. */
  readonly shortcutAttributePresent: boolean
}

export interface DoubaoAccountMenuEvidence extends WebAiMenuTriggerEvidence {
  readonly status: 'observed' | 'unknown'
  readonly provider: 'doubao'
  readonly menuVisible: boolean
  readonly addAccountVisible: boolean
  readonly logoutVisible: boolean
  /** True only when both allowlisted controls are visible in the same role=menu. */
  readonly sameMenu: boolean
  readonly generation: number
}

export interface DeepSeekAccountMenuEvidence extends WebAiMenuTriggerEvidence {
  readonly status: 'observed' | 'unknown'
  readonly provider: 'deepseek'
  readonly menuVisible: boolean
  readonly downloadMobileAppVisible: boolean
  readonly settingsVisible: boolean
  readonly helpAndFeedbackVisible: boolean
  readonly logoutVisible: boolean
  readonly sameContainer: boolean
  readonly generation: number
}

/** Current implementation never emits authState='authenticated'. */
export function createWebAiAuthStateAdapter(options: WebAiAuthStateAdapterOptions): WebAiAuthStateAdapter
/** Returns only the fixed read-only script for the known Doubao login control. */
export function doubaoLoginButtonVisibleScript(): string
/** Returns the fixed Doubao menu script with a boolean-only result. */
export function doubaoAccountMenuProbeScript(): string
/** Returns the fixed DeepSeek candidate-menu script with an allowlisted result. */
export function deepseekAccountMenuProbeScript(): string
/** Temporary fixed deep-diagnostic script; metadata is limited to 3 tag/role/class layers. */
export function deepseekMenuDevelopmentProbeScript(): string
