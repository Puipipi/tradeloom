import { chooseAddress, networkCandidates } from './core.mjs'

// Desktop-16 is the current pinned candidate; migration still validates its receipt.
export const DEFAULT_RUNTIME_CANDIDATE = '0.2.1-rc.3-tradeloom-desktop-16'

export function choosePayloadAddress(payload, requested) {
  const adapters = Array.isArray(payload) ? payload : [payload]
  return chooseAddress(networkCandidates(adapters), requested)
}
