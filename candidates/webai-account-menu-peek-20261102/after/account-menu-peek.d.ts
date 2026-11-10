export type AccountMenuPeekProvider = 'deepseek' | 'doubao'
export type AccountMenuPeekAuthState = 'authenticated' | 'unknown'
export type AccountMenuPeekEvidence = 'account-menu' | 'none'
export type AccountMenuPeekOperation = 'confirmed' | 'already-open' | 'unknown' | 'busy' | 'restore-failed'
export type AccountMenuRestoreState = 'restored' | 'not-needed' | 'failed' | 'unknown'
export type AccountMenuPeekReason =
  | 'no_binding' | 'disposed' | 'stale_context' | 'negative_evidence' | 'menu_not_confirmed'
  | 'menu_already_open' | 'open_failed' | 'open_not_dispatched' | 'probe_failed'
  | 'restore_failed' | 'restore_unconfirmed' | 'observed' | 'busy'

/** Host-owned identity snapshot. `owner` is compared by object identity and is never returned. */
export interface AccountMenuPeekContext {
  readonly owner: object
  readonly origin: string
  readonly documentId: string
  readonly generation: number
  readonly alive: boolean
  readonly focused: boolean
}

/** Opaque capability kept only inside the trusted Host controller; never a serialized DOM node. */
export interface ConfirmedTriggerCapture {
  readonly context: AccountMenuPeekContext
  readonly capability: object
  readonly proof: {
    readonly trustedPointerDown: true
    readonly strictMenuPositive: true
    readonly exactLinkedButton: true
  }
}

export interface BoundMenuObservation {
  readonly state: 'open' | 'closed' | 'negative' | 'unknown'
  readonly evidence: 'positive' | 'negative' | 'unknown'
  /** Opaque identity for the exact menu associated with the bound button; not a DOM object. */
  readonly menuIdentity?: object
}

export interface AccountMenuPeekOptions {
  readonly provider: AccountMenuPeekProvider
  readonly readContext: () => AccountMenuPeekContext
  /** Called only by trusted Host code after strict positive menu, trusted pointer, and exact-link checks. */
  readonly captureConfirmedTrigger: () => ConfirmedTriggerCapture | Promise<ConfirmedTriggerCapture>
  /** Reads only fixed provider menu/login evidence associated with the private capability. Positive is valid only for an open, strictly confirmed menu; return an opaque identity, never a DOM node. */
  readonly readBoundMenu: (capability: object, expectedMenuIdentity: object | null) => BoundMenuObservation | Promise<BoundMenuObservation>
  /** Uses only the private bound button, rechecking owner/document/menu immediately before action. Call `markDispatched` immediately after native input is sent. */
  readonly openBoundMenu: (capability: object, markDispatched: () => void) => unknown | Promise<unknown>
  /** Rechecks owner/document and closes only `menuIdentity`, the exact menu opened by this operation. */
  readonly closeBoundMenu: (capability: object, menuIdentity: object) => unknown | Promise<unknown>
  /** Host navigation/close/generation invalidation hook. */
  readonly subscribeLifecycle?: (listener: () => void) => (() => void) | void
}

export interface AccountMenuPeekResult {
  readonly provider: AccountMenuPeekProvider
  readonly generation?: number
  readonly authState: AccountMenuPeekAuthState
  readonly evidence: AccountMenuPeekEvidence
  readonly operation: AccountMenuPeekOperation
  readonly menuRestore: AccountMenuRestoreState
  readonly reason: AccountMenuPeekReason
}

export interface AccountMenuPeekController {
  /** Host-only: captures an opaque capability after the existing strict menu and trusted-pointer proof. */
  bindFromConfirmedMenu(): Promise<boolean>
  /** Performs at most one fixed open/read/restore cycle; no caller-supplied target or script is accepted. */
  peek(): Promise<AccountMenuPeekResult>
  /** Invalidates on Host navigation, close, owner replacement, or other lifecycle changes. */
  invalidate(): void
  /** Clears binding after the existing fixed provider-negative signal. */
  observeNegative(): void
  dispose(): void
}

/** Creates a Host-only state machine; the callback closures own all isolated-world DOM references. */
export function createAccountMenuPeekController(options: AccountMenuPeekOptions): AccountMenuPeekController
