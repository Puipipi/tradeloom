import * as pdfjsLib from './vendor/pdfjs-dist/legacy/build/pdf.min.mjs'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_PAGES = 500
const MAX_LONG_EDGE = 1800
const MAX_CANVAS_PIXELS = 4_000_000
const MAX_CANVAS_BYTES = 16 * 1024 * 1024

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href

function assetDirectory(name) {
  return new URL(`./vendor/pdfjs-dist/${name}/`, import.meta.url).href
}

function decodePdf(base64) {
  if (typeof base64 !== 'string' || base64.length < 8 || base64.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) {
    throw new Error('invalid PDF data')
  }
  const binary = atob(base64)
  if (binary.length > MAX_FILE_BYTES || binary.length < 5 || binary.slice(0, 5) !== '%PDF-') throw new Error('invalid PDF signature')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function mountPdfPreview(container, base64, name) {
  if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('PDF preview container unavailable')
  const root = document.createElement('section')
  root.className = 'tl-pdf-preview'
  root.setAttribute('aria-label', name || 'PDF 预览')
  const toolbar = document.createElement('div')
  toolbar.className = 'tl-pdf-preview-toolbar'
  const previous = document.createElement('button')
  previous.type = 'button'
  previous.textContent = '上一页'
  previous.disabled = true
  const page = document.createElement('input')
  page.type = 'number'
  page.min = '1'
  page.value = '1'
  page.disabled = true
  page.setAttribute('aria-label', 'PDF 页码')
  const count = document.createElement('span')
  count.textContent = '/ …'
  const next = document.createElement('button')
  next.type = 'button'
  next.textContent = '下一页'
  next.disabled = true
  toolbar.append(previous, page, count, next)
  const status = document.createElement('p')
  status.className = 'tl-pdf-preview-status'
  status.setAttribute('role', 'status')
  status.textContent = '正在解析 PDF…'
  const viewport = document.createElement('div')
  viewport.className = 'tl-pdf-preview-viewport'
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-label', name || 'PDF 页面')
  viewport.append(canvas)
  root.append(toolbar, status, viewport)
  container.replaceChildren(root)

  let loadingTask
  let pdfDocument
  let renderTask
  let renderGeneration = 0
  let disposed = false
  const updateControls = () => {
    const current = Number(page.value)
    previous.disabled = disposed || !pdfDocument || current <= 1
    next.disabled = disposed || !pdfDocument || current >= pdfDocument.numPages
    page.disabled = disposed || !pdfDocument
  }

  async function renderPage() {
    if (disposed || !pdfDocument) return
    const pageNumber = Number(page.value)
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdfDocument.numPages) return
    const generation = ++renderGeneration
    renderTask?.cancel()
    renderTask = null
    status.textContent = `正在绘制第 ${pageNumber} 页…`
    try {
      const pdfPage = await pdfDocument.getPage(pageNumber)
      if (disposed || generation !== renderGeneration) return
      const natural = pdfPage.getViewport({ scale: 1 })
      const naturalArea = natural.width * natural.height
      const scale = Math.min(1, MAX_LONG_EDGE / Math.max(natural.width, natural.height), Math.sqrt(MAX_CANVAS_PIXELS / naturalArea))
      const pageViewport = pdfPage.getViewport({ scale })
      const width = Math.ceil(pageViewport.width)
      const height = Math.ceil(pageViewport.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1
        || width > MAX_LONG_EDGE || height > MAX_LONG_EDGE || width * height > MAX_CANVAS_PIXELS) {
        throw new Error('page dimensions exceed preview limits')
      }
      canvas.width = width
      canvas.height = height
      canvas.style.width = `${width}px`
      canvas.style.height = 'auto'
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('canvas unavailable')
      const task = pdfPage.render({ canvasContext: context, viewport: pageViewport })
      renderTask = task
      await task.promise
      if (disposed || generation !== renderGeneration) return
      status.textContent = `第 ${pageNumber} 页 / 共 ${pdfDocument.numPages} 页`
      updateControls()
      pdfPage.cleanup()
    } catch (error) {
      if (disposed || generation !== renderGeneration || error?.name === 'RenderingCancelledException') return
      status.textContent = '此 PDF 页面无法预览。'
      updateControls()
    } finally {
      if (generation === renderGeneration) renderTask = null
    }
  }

  previous.addEventListener('click', () => {
    const nextPage = Math.max(1, Number(page.value) - 1)
    page.value = String(nextPage)
    updateControls()
    void renderPage()
  })
  next.addEventListener('click', () => {
    const nextPage = Math.min(pdfDocument?.numPages ?? 1, Number(page.value) + 1)
    page.value = String(nextPage)
    updateControls()
    void renderPage()
  })
  page.addEventListener('change', () => {
    if (!pdfDocument) return
    page.value = String(Math.min(pdfDocument.numPages, Math.max(1, Math.trunc(Number(page.value) || 1))))
    updateControls()
    void renderPage()
  })

  try {
    const data = decodePdf(base64)
    loadingTask = pdfjsLib.getDocument({
      data,
      cMapUrl: assetDirectory('cmaps'),
      cMapPacked: true,
      iccUrl: assetDirectory('iccs'),
      standardFontDataUrl: assetDirectory('standard_fonts'),
      wasmUrl: assetDirectory('wasm'),
      useWorkerFetch: true,
      useWasm: true,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      enableXfa: false,
      disableFontFace: true,
      isImageDecoderSupported: false,
      maxImageSize: MAX_CANVAS_PIXELS,
      canvasMaxAreaInBytes: MAX_CANVAS_BYTES,
      stopAtErrors: true,
      verbosity: 0,
    })
    void loadingTask.promise.then(documentProxy => {
      if (disposed) { void loadingTask?.destroy(); return }
      if (!Number.isSafeInteger(documentProxy.numPages) || documentProxy.numPages < 1 || documentProxy.numPages > MAX_PAGES) {
        status.textContent = `PDF 页数超过预览上限（${MAX_PAGES} 页）。`
        void loadingTask?.destroy()
        updateControls()
        return
      }
      pdfDocument = documentProxy
      page.max = String(documentProxy.numPages)
      count.textContent = `/ ${documentProxy.numPages}`
      updateControls()
      void renderPage()
    }).catch(() => {
      if (!disposed) status.textContent = '此 PDF 文件无效或无法解析。'
    })
  } catch {
    status.textContent = '此 PDF 文件无效或无法解析。'
  }

  return () => {
    if (disposed) return
    disposed = true
    renderGeneration++
    renderTask?.cancel()
    renderTask = null
    page.disabled = true
    previous.disabled = true
    next.disabled = true
    canvas.width = 0
    canvas.height = 0
    status.textContent = ''
    void loadingTask?.destroy().catch(() => {})
    pdfDocument = undefined
    container.replaceChildren()
  }
}
