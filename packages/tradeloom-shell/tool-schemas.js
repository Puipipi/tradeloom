export const TOOL_SCHEMAS_ROUTE = '/tradeloom/tool-schemas'

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

export function createToolSchemasHandler(ctx) {
  return (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    res.setHeader('cache-control', 'no-store')
    if (rejection !== undefined) { res.statusCode = rejection; res.end(); return }
    if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('allow', 'GET'); res.end(); return }
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { json(res, 400, { error: 'invalid-query' }); return }
    if (url.pathname !== TOOL_SCHEMAS_ROUTE || req.url.includes('?')) { json(res, 400, { error: 'invalid-query' }); return }
    let payload
    try {
      if (typeof ctx.tools?.schemas !== 'function') throw new Error('unavailable')
      const schemas = ctx.tools.schemas()
      if (!Array.isArray(schemas)) throw new Error('unavailable')
      const tools = schemas.map(schema => {
        if (!schema || typeof schema.name !== 'string' || typeof schema.description !== 'string'
          || !schema.parameters || typeof schema.parameters !== 'object' || Array.isArray(schema.parameters)) throw new Error('unavailable')
        const item = { name: schema.name, description: schema.description, parameters: schema.parameters }
        if (Object.hasOwn(schema, 'deferLoading')) {
          if (schema.deferLoading !== true) throw new Error('unavailable')
          item.deferLoading = true
        }
        return item
      })
      payload = JSON.stringify({ scope: 'global', tools })
    } catch { json(res, 503, { error: 'tool-schemas-unavailable' }); return }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(payload)
  }
}

export function registerToolSchemas(ctx) {
  return ctx.webServer.register({ kind: 'exact', path: TOOL_SCHEMAS_ROUTE, handler: createToolSchemasHandler(ctx) })
}
