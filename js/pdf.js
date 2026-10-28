'use strict';

const pdfjs = window.pdfjsLib;

// Chrome does not start a worker from a file:// script, but it does from a blob URL.
// All documents share this worker. pdf.js does not stop a worker that it did not make.
const pdfWorker = new pdfjs.PDFWorker({
  port: new Worker(URL.createObjectURL(new Blob([window.PDFJS_WORKER_SOURCE], { type: 'text/javascript' }))),
});

// Opens a PDF and reads only the byte ranges that pdf.js asks for.
function openPdf(file, { autoFetch = false } = {}) {
  const transport = new pdfjs.PDFDataRangeTransport(file.size, null);
  const task = pdfjs.getDocument({
    range: transport,
    worker: pdfWorker,
    rangeChunkSize: 256 * 1024,
    disableAutoFetch: !autoFetch,
    disableStream: true,
    isEvalSupported: false,
  });
  transport.requestDataRange = (begin, end) => {
    file.slice(begin, end).arrayBuffer().then(
      (buf) => transport.onDataRange(begin, new Uint8Array(buf)),
      () => task.destroy(),
    );
  };
  return task;
}

const pageCountLimit = limiter(4);

async function pageCount(file) {
  const id = pdfId(file);
  const known = pdfData.get(id, {}).pages;
  if (known) return known;
  const pages = await pageCountLimit(async () => {
    const task = openPdf(file);
    try { return (await task.promise).numPages; } finally { task.destroy(); }
  });
  pdfData.update(id, { pages });
  return pages;
}

const THUMB_W = 320;
const THUMB_H = 453;

async function renderCover(file) {
  const task = openPdf(file);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(THUMB_W / base.width, THUMB_H / base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    task.destroy();
  }
}

// Cover thumbnails, cached in IndexedDB. Only the rendering goes through a queue.
const thumbs = {
  urls: new Map(),
  queue: [],
  active: 0,
  maxActive: 3,

  async get(segments, fileHandle) {
    const file = await fileHandle.getFile();
    const key = `${store.prefix}${pathKey(segments)}|${file.size}|${file.lastModified}`;
    if (this.urls.has(key)) return this.urls.get(key);
    let blob = await idb.get('thumbs', key).catch(() => null);
    if (!blob) {
      blob = await new Promise((resolve, reject) => {
        this.queue.push({ file, resolve, reject });
        this.pump();
      });
      idb.set('thumbs', key, blob).catch(() => {});
    }
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  },

  pump() {
    while (this.active < this.maxActive && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      renderCover(job.file).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  },

  cancelPending() {
    for (const job of this.queue) job.reject(new DOMException('Cancelled', 'AbortError'));
    this.queue = [];
  },
};
