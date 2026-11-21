(() => {
  window.TradeLoomPdfPreviewReady = import('./pdf-preview-runtime.mjs')
    .then(module => Object.freeze({ mount: module.mountPdfPreview }))
    .catch(() => { throw new Error('PDF preview module unavailable') })
})()
