export type FixedAccountEntryProvider = 'deepseek' | 'doubao'
export type FixedCandidateCount = 0 | 1 | '2_plus' | 'unknown'
export type FixedProbeReason = 'observed' | 'unknown' | 'bounded_unknown' | 'menu_still_open' | 'entry_changed'

export interface DeepSeekEntryProbeResult {
  readonly provider: 'deepseek'
  readonly phase: 'open' | 'closed'
  readonly reason: FixedProbeReason
  readonly menuState: 'open' | 'closed' | 'unknown'
  readonly visibleCandidateCount: FixedCandidateCount
  readonly capturedPathMatchesCandidate: boolean | null
}

export interface DoubaoEntryProbeResult {
  readonly provider: 'doubao'
  readonly phase: 'open' | 'closed'
  readonly reason: FixedProbeReason
  readonly menuState: 'open' | 'closed' | 'unknown'
  readonly visibleNavigationCount?: FixedCandidateCount
  readonly insideNavigation?: boolean | null
  /** Number of visible buttons matching the fixed aria-controls/menu selector, not just buttons linked to this menu. */
  readonly visibleMenuButtonCandidateCountInNavigation?: FixedCandidateCount
  readonly capturedButtonIsUniqueCandidate?: boolean | null
  /** Visible navigation buttons with aria-haspopup="menu", independent of aria-controls. */
  readonly visiblePopupMenuButtonCountInNavigation: FixedCandidateCount
  /** True only when the exact private capture is the sole visible popup-menu button candidate in one navigation. */
  readonly capturedButtonIsUniquePopupCandidate: boolean | null
  readonly sameCapturedButton?: boolean | null
  readonly closedHasAriaControls?: boolean | null
  readonly closedHasPopupMenu?: boolean | null
  readonly closedUniqueCandidate?: boolean | null
}

export type FixedAccountEntryProbeResult = DeepSeekEntryProbeResult | DoubaoEntryProbeResult

/** Same-realm only. DOM references are accepted from the fixed R2 positive hook and never returned. */
export interface FixedAccountEntryProbe {
  confirmMenu(menu: Element, trustedPath: readonly Element[]): FixedAccountEntryProbeResult
  inspectClosed(): FixedAccountEntryProbeResult
  dispose(): void
}

/** Construct only inside the owned isolated world. No selectors or scripts are caller-configurable. */
export function createFixedAccountEntryProbe(doc: Document, provider: FixedAccountEntryProvider): FixedAccountEntryProbe | null
export function fixedAccountEntryProbeInstallScript(provider: FixedAccountEntryProvider): string
/** Expression that uses the R2 same-realm closure after its exact positive-menu check; requires the documented hook patch. */
export function fixedAccountEntryProbeR2ConfirmExpression(provider: FixedAccountEntryProvider): string
export function fixedAccountEntryProbeClosedScript(provider: FixedAccountEntryProvider): string
export function fixedAccountEntryProbeDisposeScript(provider: FixedAccountEntryProvider): string
