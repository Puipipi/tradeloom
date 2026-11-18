import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_TEXT_CHARS = 12_000
const MAX_WAVE_BYTES = 24 * 1024 * 1024
const MAX_STDOUT_CHARS = 4096
const SCRIPT_PATH = fileURLToPath(new URL('./windows-speech-provider.ps1', import.meta.url))

function codedError(code) { return Object.assign(new Error(code), { code }) }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function parseWave(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_WAVE_BYTES
    || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw codedError('session_speech_invalid_wave')
  }
  let offset = 12
  let format = null
  let dataBytes = null
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4)
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    const end = body + chunkSize
    if (end > bytes.length) throw codedError('session_speech_invalid_wave')
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw codedError('session_speech_invalid_wave')
      format = {
        encoding: bytes.readUInt16LE(body),
        channels: bytes.readUInt16LE(body + 2),
        sampleRate: bytes.readUInt32LE(body + 4),
        byteRate: bytes.readUInt32LE(body + 8),
        blockAlign: bytes.readUInt16LE(body + 12),
        bitsPerSample: bytes.readUInt16LE(body + 14),
      }
    } else if (chunkId === 'data' && dataBytes === null) {
      dataBytes = chunkSize
    }
    offset = end + (chunkSize & 1)
  }
  if (!format || !dataBytes || format.encoding !== 1 || format.channels < 1 || format.sampleRate < 1
    || format.byteRate < 1 || format.bitsPerSample < 1 || format.blockAlign < 1) {
    throw codedError('session_speech_invalid_wave')
  }
  return {
    mimeType: 'audio/wav',
    format: {
      encoding: 'pcm', channels: format.channels, sampleRate: format.sampleRate,
      bitsPerSample: format.bitsPerSample, durationSeconds: dataBytes / format.byteRate,
    },
    dataBytes,
  }
}

function resolvePowerShellPath(explicitPath) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  const candidate = explicitPath ?? (systemRoot ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null)
  if (process.platform !== 'win32' || typeof candidate !== 'string' || !isAbsolute(candidate)) {
    throw codedError('session_speech_provider_unavailable')
  }
  return resolve(candidate)
}

/** Windows-only local System.Speech WAV provider. It never plays audio. */
export function createWindowsSpeechProvider(options = {}) {
  if (!isRecord(options) || Object.keys(options).some(key => !['powershellPath', 'voice', 'tempParent'].includes(key))) {
    throw codedError('invalid_arguments')
  }
  const powershellPath = resolvePowerShellPath(options.powershellPath)
  const voice = options.voice
  if (voice !== undefined && (typeof voice !== 'string' || !voice.trim() || voice.length > 128)) throw codedError('invalid_arguments')
  const tempParent = options.tempParent ?? tmpdir()
  if (typeof tempParent !== 'string' || !isAbsolute(tempParent)) throw codedError('invalid_arguments')

  let ownedRoot = null
  let ownedRootPromise = null
  let disposed = false
  let disposePromise = null
  const activeChildren = new Set()
  const activeControllers = new Set()
  const tasks = new Set()
  let started = 0
  let exited = 0

  function getOwnedRoot() {
    if (ownedRootPromise === null) {
      ownedRootPromise = mkdtemp(join(tempParent, 'tradeloom-session-speech-')).then(root => {
        ownedRoot = root
        return root
      }).catch(error => {
        ownedRootPromise = null
        throw error
      })
    }
    return ownedRootPromise
  }

  async function run(text, signal) {
    if (disposed) throw codedError('session_speech_closed')
    if (signal?.aborted) throw codedError('session_speech_cancelled')
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS) throw codedError('invalid_arguments')
    const root = await getOwnedRoot()
    if (disposed || signal?.aborted) throw codedError(disposed ? 'session_speech_closed' : 'session_speech_cancelled')
    const outputPath = join(root, `${randomUUID()}.wav`)
    const childController = new AbortController()
    const relayAbort = () => childController.abort()
    signal?.addEventListener('abort', relayAbort, { once: true })
    activeControllers.add(childController)
    let child = null
    let spawnError = false
    let outputOverflow = false
    let stdout = ''
    try {
      await new Promise((resolveChild, rejectChild) => {
        if (childController.signal.aborted) { rejectChild(codedError('session_speech_cancelled')); return }
        child = spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', SCRIPT_PATH], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
        })
        activeChildren.add(child)
        started += 1
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', chunk => {
          stdout += chunk
          if (stdout.length > MAX_STDOUT_CHARS) {
            outputOverflow = true
            child.kill()
          }
        })
        child.on('error', () => { spawnError = true })
        child.stdin.on('error', () => { spawnError = true })
        const onAbort = () => { child?.kill() }
        childController.signal.addEventListener('abort', onAbort, { once: true })
        child.once('close', code => {
          childController.signal.removeEventListener('abort', onAbort)
          activeChildren.delete(child)
          exited += 1
          if (childController.signal.aborted) return rejectChild(codedError('session_speech_cancelled'))
          let result
          try { result = JSON.parse(stdout.trim()) } catch { return rejectChild(codedError('session_speech_provider_unavailable')) }
          if (!isRecord(result)) return rejectChild(codedError('session_speech_provider_unavailable'))
          if (result.ok !== true) {
            const known = new Set(['session_speech_invalid_arguments', 'session_speech_provider_unavailable',
              'session_speech_voice_unavailable', 'session_speech_synthesis_failed'])
            return rejectChild(codedError(known.has(result?.code) ? result.code : 'session_speech_provider_unavailable'))
          }
          if (outputOverflow || spawnError || code !== 0) return rejectChild(codedError('session_speech_provider_unavailable'))
          resolveChild()
        })
        child.stdin.end(JSON.stringify({ text, outputPath, ...(voice !== undefined ? { voice } : {}) }))
        if (childController.signal.aborted) onAbort()
      })
      if (childController.signal.aborted || disposed) throw codedError(disposed ? 'session_speech_closed' : 'session_speech_cancelled')
      let bytes
      try { bytes = await readFile(outputPath) } catch { throw codedError('session_speech_synthesis_failed') }
      if (childController.signal.aborted || disposed) throw codedError(disposed ? 'session_speech_closed' : 'session_speech_cancelled')
      const wave = parseWave(bytes)
      return { ...wave, bytes: Uint8Array.from(bytes) }
    } catch (error) {
      if (error?.code) throw error
      throw codedError('session_speech_provider_unavailable')
    } finally {
      signal?.removeEventListener('abort', relayAbort)
      activeControllers.delete(childController)
      if (child && activeChildren.has(child)) {
        child.kill()
        await new Promise(resolveChild => child.once('close', resolveChild))
      }
      await rm(outputPath, { force: true }).catch(() => {})
    }
  }

  async function synthesize(text, { signal } = {}) {
    if (disposed) throw codedError('session_speech_closed')
    const task = run(text, signal)
    tasks.add(task)
    try { return await task } finally { tasks.delete(task) }
  }

  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    for (const controller of activeControllers) controller.abort()
    for (const child of activeChildren) child.kill()
    disposePromise = (async () => {
      await Promise.allSettled([...tasks])
      if (ownedRoot !== null) {
        const root = ownedRoot
        ownedRoot = null
        try { await rm(root, { recursive: true }) } catch { throw codedError('session_speech_cleanup_failed') }
      }
    })()
    return disposePromise
  }

  return Object.freeze({
    synthesize,
    dispose,
    diagnostics: () => Object.freeze({ started, exited, active: activeChildren.size }),
  })
}
