import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import {
  createSessionCompactionStatsProjection,
  registerSessionCompactionStatsProjection,
  type SessionCompactionStats,
  type SessionCompactionStatsState,
} from '@tradeloom/dsh-business-shell/session-compaction-stats'

declare const ctx: Context
const projection = createSessionCompactionStatsProjection({ z })
const unregisterDirect: () => void = ctx.sessionProjections.register(projection)
const view: SessionProjectionMap['tradeloomCompactionStats'] = projection.wire!.view(projection.init({} as never, SessionLogOffset(0)))
const stats: SessionCompactionStats = view
const state: SessionCompactionStatsState = projection.init({} as never, SessionLogOffset(0))
const unregister: () => void = registerSessionCompactionStatsProjection(ctx, { z })
void [stats, state, unregister, unregisterDirect]
