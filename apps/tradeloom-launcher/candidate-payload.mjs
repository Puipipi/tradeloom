import { chooseAddress, networkCandidates } from './core.mjs'

export const DEFAULT_RUNTIME_CANDIDATE = '0.2.1-rc.2-tradeloom-desktop-2'

export function choosePayloadAddress(payload, requested) {
  const adapters = Array.isArray(payload) ? payload : [payload]
  return chooseAddress(networkCandidates(adapters), requested)
}
