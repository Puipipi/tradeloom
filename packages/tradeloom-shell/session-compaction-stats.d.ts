import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionMap, SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection/types'

export interface SessionCompactionStats {
  readonly attempts: number
  readonly summaryApplied: number
  readonly completed: number
  readonly failed: number
  readonly inflight: number
}

export interface SessionCompactionStatsAttempt {
  readonly compactionId: string
  readonly startSeq: number
  readonly turn: number | null
  readonly sourceCommandId: string | null
  readonly summarySeq: number | null
  readonly shadowedRange: { readonly start: number; readonly end: number } | null
  readonly summaryApplied: boolean
}

export interface SessionCompactionStatsState {
  readonly attempts: number
  readonly summaryApplied: number
  readonly completed: number
  readonly failed: number
  readonly openAttempts: readonly SessionCompactionStatsAttempt[]
  readonly stats: SessionCompactionStats
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    tradeloomCompactionStats: SessionCompactionStats
  }
  interface SessionProjectionStateMap {
    tradeloomCompactionStats: SessionCompactionStatsState
  }
}

export declare const SESSION_COMPACTION_STATS_KEY: 'tradeloomCompactionStats'
export declare const SESSION_COMPACTION_STATS_STATE_VERSION: 1
export type SessionCompactionStatsProjection = ProjectionDefinition<
  'tradeloomCompactionStats',
  SessionCompactionStatsState
> & {
  wire: NonNullable<ProjectionDefinition<'tradeloomCompactionStats', SessionCompactionStatsState>['wire']>
}
export declare function createSessionCompactionStatsProjection(options: {
  z: Pick<typeof import('zod'), 'custom'>
}): SessionCompactionStatsProjection
export declare function registerSessionCompactionStatsProjection(
  ctx: import('@deepseek-ai/cordis').Context,
  options: { z: Pick<typeof import('zod'), 'custom'> },
): () => void
