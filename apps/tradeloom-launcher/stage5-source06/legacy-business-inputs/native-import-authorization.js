const cordisOriginal = Symbol.for('cordis.original')
const sameService = (left, right) => (left?.[cordisOriginal] ?? left) === (right?.[cordisOriginal] ?? right)

export function createNativeImportAuthorizer(ctx) {
  return async (request, signal) => {
    if (signal?.aborted) return undefined
    let service
    try { service = ctx.get?.('nativeImportAuthorization') } catch { return undefined }
    if (typeof service?.authorizeImport !== 'function') return undefined
    let result
    try { result = await service.authorizeImport(request, signal) } catch { return undefined }
    if (signal?.aborted) return undefined
    let current
    try { current = ctx.get?.('nativeImportAuthorization') } catch { return undefined }
    if (!sameService(current, service) || result !== 'allowed-once') return undefined
    return 'allowed-once'
  }
}
