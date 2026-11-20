// Main-process owned registry. Renderers can only request bounds for an existing seat.
export function createSurfaceOwner(mainWindow) {
  if (!mainWindow?.frame) throw new Error('main window and frame required')
  const scenes = new Map(), seats = new Map(), sessions = new Map()
  let closed = false
  const key = (scene, panel) => JSON.stringify([scene, panel])
  const sessionKey = (id, surface) => JSON.stringify([id,surface])
  const active = () => { if (closed) throw new Error('owner destroyed') }
  const required = value => typeof value === 'string' && value.length > 0
  return {
    registerScene(sceneId, window) {
      active()
      if (!required(sceneId) || !window?.frame || scenes.has(sceneId) || window === mainWindow || [...scenes.values()].includes(window)) throw new Error('invalid scene window')
      scenes.set(sceneId, window)
      for (const seat of seats.values()) if (seat.sceneId === sceneId && !seat.rehomed) seat.window = window
    },
    attach({ sceneId, panelId, sessionId, view, partition, surface = 'chat' }) {
      active()
      if (!required(sceneId) || !required(panelId) || !view?.frame || !required(partition) || !['chat','files'].includes(surface) || (sessionId !== undefined && !required(sessionId))) throw new Error('invalid seat')
      const id = key(sceneId, panelId)
      if (seats.has(id) || (sessionId && sessions.has(sessionKey(sessionId,surface))) || [...seats.values()].some(s => s.view === view)) throw new Error('seat or session already owned')
      const seat = { sceneId, panelId, sessionId, surface, view, partition, window: scenes.get(sceneId) ?? mainWindow, rehomed: false }
      seats.set(id, seat); if (sessionId) sessions.set(sessionKey(sessionId,surface), seat)
      return seat
    },
    get(sceneId, panelId) { return seats.get(key(sceneId, panelId)) },
    findSession(sessionId, surface = 'chat') { return sessions.get(sessionKey(sessionId,surface)) },
    transfer(sessionId, sceneId, panelId, surface = 'chat') {
      active(); const seat=sessions.get(sessionKey(sessionId,surface)), id=key(sceneId,panelId)
      if (!seat || seats.has(id)) throw new Error('invalid transfer')
      if (seat.rehomed) throw new Error('seat is rehomed')
      seats.delete(key(seat.sceneId,seat.panelId)); seat.sceneId=sceneId; seat.panelId=panelId; seat.window=scenes.get(sceneId) ?? mainWindow; seats.set(id,seat); return seat
    },
    rehome(sceneId, panelId, window) {
      active()
      const seat = seats.get(key(sceneId, panelId))
      if (!seat) throw new Error('unknown seat')
      if (!window?.frame || window === mainWindow || [...scenes.values()].includes(window)
        || [...seats.values()].some(other => other !== seat && other.window === window)) throw new Error('invalid popout window')
      if (seat.rehomed) throw new Error('seat already rehomed')
      seat.window = window
      seat.rehomed = true
      return seat
    },
    returnSeat(sceneId, panelId) {
      active()
      const seat = seats.get(key(sceneId, panelId))
      if (!seat) throw new Error('unknown seat')
      seat.window = scenes.get(sceneId) ?? mainWindow
      seat.rehomed = false
      return seat
    },
    authorizeGuest(view, frame) { return !closed && [...seats.values()].some(seat => seat.view === view && seat.view.frame === frame) },
    revoke(sceneId, panelId) {
      active(); const id = key(sceneId, panelId), seat = seats.get(id)
      if (!seat) return false
      seat.window = scenes.get(sceneId) ?? mainWindow; seat.rehomed = false
      seats.delete(id); if (seat.sessionId) sessions.delete(sessionKey(seat.sessionId,seat.surface))
      return true
    },
    bounds(event, sceneId, panelId, rect) {
      active()
      const seat = seats.get(key(sceneId, panelId))
      if (!seat || event.sender !== seat.window || event.frame !== seat.window.frame) throw new Error('unauthorized sender')
      if (!rect || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(rect[k])) || rect.width < 0 || rect.height < 0) throw new Error('invalid bounds')
      const w = Math.max(0, seat.window.bounds.width), h = Math.max(0, seat.window.bounds.height)
      const x = Math.max(0, Math.min(w, Math.floor(rect.x))), y = Math.max(0, Math.min(h, Math.floor(rect.y)))
      return { x, y, width: Math.max(0, Math.min(w - x, Math.floor(rect.width))), height: Math.max(0, Math.min(h - y, Math.floor(rect.height))) }
    },
    returnScene(sceneId) { active(); if (!scenes.has(sceneId)) throw new Error('unknown scene'); scenes.delete(sceneId); for (const seat of seats.values()) if (seat.sceneId === sceneId && !seat.rehomed) seat.window = mainWindow },
    destroy() { if (closed) return; closed = true; for (const seat of seats.values()) { seat.window = mainWindow; seat.rehomed = false; seat.view.destroy() } seats.clear(); scenes.clear(); sessions.clear() },
  }
}


