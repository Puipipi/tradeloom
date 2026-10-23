import { launcherPipeName, reserveNamedPipe } from './core.mjs'

function startupPipeName(home) {
  return launcherPipeName(home).replace('tradeloom-launcher-', 'tradeloom-starting-')
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

/**
 * Runs one local startup callback while reserving its canonical home.
 * @param {string} home The already validated, canonical application home.
 * @param {() => Promise<unknown>} start The promise that owns startup and the resulting controller lifecycle.
 * @returns {Promise<{status: 'already-starting' | 'already-running'} | {status: 'started', value: unknown}>} The startup result or the detected owner state.
 */
export async function withLocalStartGuard(home, start) {
  let guard
  try {
    guard = await reserveNamedPipe(startupPipeName(home))
  } catch (error) {
    if (error.code === 'EADDRINUSE') return { status: 'already-starting' }
    throw error
  }

  try {
    let launcherProbe
    try {
      launcherProbe = await reserveNamedPipe(launcherPipeName(home))
    } catch (error) {
      if (error.code === 'EADDRINUSE') return { status: 'already-running' }
      throw error
    }
    await closeServer(launcherProbe)
    return { status: 'started', value: await start() }
  } finally {
    await closeServer(guard)
  }
}
