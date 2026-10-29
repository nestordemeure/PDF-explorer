'use strict';

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const DEFAULT_ZOOM = { portrait: 0.5, landscape: 0.8 };
const MAX_CANVAS_PIXELS = 16e6;
// The current page is the one under this line, as a fraction of the view height.
const READING_LINE = 0.3;
// A visit counts as a read after this time with the tab visible, and this many pages seen.
const READ_MIN_MS = 60 * 1000;
const READ_MIN_PAGES = 2;
// The same PDF counts again only after this time.
const READ_COOLDOWN_MS = 6 * 3600 * 1000;
const READ_TICK_MS = 5000;

function countRead(id) {
  const record = pdfData.get(id, {});
  const now = Date.now();
  if (now - (record.readAt ?? 0) < READ_COOLDOWN_MS) return;
  pdfData.update(id, { reads: (record.reads ?? 0) + 1, readAt: now });
}

// Page sizes per file, so that coming back to a PDF does not measure it again.
const pageSizeCache = new Map();

// Infinite scroll over all the PDFs of one folder.
// A zoom of 1 makes the median page of each PDF as wide as the window.
// Each folder keeps one zoom for portrait PDFs and one for landscape PDFs.
// Wider pages, such as double-page covers, shrink to that width.
class ReaderView {
  constructor(segments) {
    this.folder = segments.slice(0, -1);
    this.folderKey = pathKey(this.folder);
    this.fileName = segments[segments.length - 1];
    this.sections = [];
    this.current = null;
    this.alive = true;
    this.events = new AbortController();
    this.extending = { [-1]: false, [1]: false };
    this.pending = new Set();
    this.rendering = 0;
    this.visits = new Map();
  }

  async mount() {
    const listing = await fsx.list(this.folder);
    let index = listing.pdfs.findIndex((p) => displayName(p.name) === this.fileName || p.name === this.fileName);
    if (index < 0) throw Object.assign(new Error(`${this.fileName} is not in this folder.`), { name: 'MissingPdfError' });
    // Only a folder of PDFs alone scrolls from one PDF into the next.
    const single = listing.folders.length > 0;
    this.pdfs = single ? [listing.pdfs[index]] : listing.pdfs;
    this.single = single;
    if (single) index = 0;
    this.zooms = {};
    for (const shape of Object.keys(DEFAULT_ZOOM)) {
      this.zooms[shape] = store.get(`zoom:${this.folderKey}|${shape}`, DEFAULT_ZOOM[shape]);
    }

    this.buildTools();
    this.container = el('div', 'reader');
    this.startMarker = el('div', 'edge', single ? 'Start of PDF' : 'Start of folder');
    this.endMarker = el('div', 'edge');
    this.endMarker.append(single ? 'End of PDF · ' : 'End of folder · ', link('Back to covers', makeHash(this.folder, true)));
    this.startMarker.hidden = this.endMarker.hidden = true;
    this.container.append(this.startMarker, this.endMarker);
    mainEl.replaceChildren(this.container);

    this.nearObserver = new IntersectionObserver((entries) => this.onNear(entries), { root: mainEl, rootMargin: '150% 0px' });
    this.farObserver = new IntersectionObserver((entries) => this.onFar(entries), { root: mainEl, rootMargin: '400% 0px' });

    const section = await this.loadSection(index);
    if (!this.alive) return;
    this.insertSection(section, 1);
    this.restorePosition(section);
    this.setCurrent(section);
    this.readTimer = setInterval(() => this.tickReading(), READ_TICK_MS);
    mainEl.focus({ preventScroll: true });

    const signal = this.events.signal;
    let frame = 0;
    mainEl.addEventListener('scroll', () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.onScroll(); });
    }, { signal });
    mainEl.addEventListener('wheel', (e) => this.onWheel(e), { signal, passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e), { signal });
    window.addEventListener('pagehide', () => this.savePosition.flush(), { signal });
    let width = mainEl.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      if (mainEl.clientWidth === width) return;
      width = mainEl.clientWidth;
      this.relayout();
    });
    this.resizeObserver.observe(mainEl);

    this.savePosition = throttle(() => this.writePosition(), 400);
    this.onScroll();
  }

  buildTools() {
    this.pageLabel = el('span', 'page-label');
    this.pageLabel.title = 'Page in this PDF';
    this.pdfLabel = el('span', 'pdf-label');
    this.pdfLabel.title = 'PDF in this folder';
    this.pdfLabel.hidden = this.single;
    this.zoomLabel = button('', 'Back to the default zoom (0)', () => this.setZoom(DEFAULT_ZOOM[this.shape]));
    this.zoomLabel.className = 'zoom-label';
    this.updateZoomLabel();
    toolsEl.replaceChildren(
      this.pdfLabel,
      this.pageLabel,
      el('span', 'divider'),
      button('−', 'Zoom out (−)', () => this.setZoom(this.zoom / 1.1)),
      this.zoomLabel,
      button('+', 'Zoom in (+)', () => this.setZoom(this.zoom * 1.1)),
      el('span', 'divider'),
      button('▦ Covers', 'Show the covers of this folder (Esc)', () => { location.hash = makeHash(this.folder, true); }),
    );
  }

  // The shape of the PDF in view. The zoom controls act on the zoom of that shape.
  get shape() {
    return this.current?.shape ?? 'landscape';
  }

  get zoom() {
    return this.zooms[this.shape];
  }

  updateZoomLabel() {
    this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
  }

  // Opens a PDF of the folder and builds placeholders with the size of its pages.
  async loadSection(index) {
    const entry = this.pdfs[index];
    const section = {
      index,
      name: entry.name,
      handle: entry.handle,
      path: [...this.folder, entry.name],
      el: el('section', 'doc'),
      pages: [],
      sizes: [],
      doc: null,
      docPromise: null,
      task: null,
    };
    section.el.append(el('div', 'doc-title', displayName(entry.name)));
    try {
      const file = await entry.handle.getFile();
      section.id = pdfId(file);
      const sizeKey = `${store.prefix}${pathKey(section.path)}|${file.size}|${file.lastModified}`;
      let sizes = pageSizeCache.get(sizeKey);
      if (!sizes) {
        const doc = await this.ensureDoc(section, file);
        sizes = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1).then((page) => {
          const v = page.getViewport({ scale: 1 });
          return { w: v.width, h: v.height };
        })));
        pageSizeCache.set(sizeKey, sizes);
        pdfData.update(section.id, { pages: sizes.length });
      }
      section.sizes = sizes;
      // Covers often have an odd size, so only a one-page PDF uses its first page here.
      const body = sizes.length > 1 ? sizes.slice(1) : sizes;
      section.medianWidth = median(body.map((s) => s.w));
      section.shape = median(body.map((s) => s.h / s.w)) > 1 ? 'portrait' : 'landscape';
      section.pages = sizes.map((_, i) => {
        const page = el('div', 'page');
        page.dataset.n = i + 1;
        page.section = section;
        page.pageIndex = i;
        page.renderedScale = 0;
        return page;
      });
      section.el.append(...section.pages);
    } catch (e) {
      console.warn('Cannot open', entry.name, e);
      section.el.append(el('div', 'doc-error', `Cannot open this PDF: ${e.message}`));
    }
    return section;
  }

  ensureDoc(section, file) {
    if (section.docPromise) return section.docPromise;
    section.docPromise = (async () => {
      file ??= await section.handle.getFile();
      section.task = openPdf(file, { autoFetch: true });
      section.doc = await section.task.promise;
      return section.doc;
    })();
    section.docPromise.catch(() => { section.docPromise = null; });
    return section.docPromise;
  }

  releaseDoc(section) {
    if (!section.docPromise) return;
    for (const page of section.pages) this.clearPage(page);
    section.task?.destroy();
    section.task = section.doc = section.docPromise = null;
  }

  layoutSection(section) {
    if (!section.pages.length) return;
    const maxWidth = this.zooms[section.shape] * mainEl.clientWidth;
    const scale = maxWidth / section.medianWidth;
    section.pages.forEach((page, i) => {
      const size = section.sizes[i];
      page.scale = Math.min(scale, maxWidth / size.w);
      page.style.width = Math.floor(size.w * page.scale) + 'px';
      page.style.height = Math.round(size.h * page.scale) + 'px';
    });
  }

  // Adds a section at the end (dir = 1) or the start (dir = -1) and keeps the view still.
  insertSection(section, dir) {
    this.layoutSection(section);
    if (dir > 0) {
      this.endMarker.before(section.el);
      this.sections.push(section);
    } else {
      const before = this.container.offsetHeight;
      this.startMarker.after(section.el);
      this.sections.unshift(section);
      mainEl.scrollTop += this.container.offsetHeight - before;
    }
    for (const page of section.pages) {
      this.nearObserver.observe(page);
      this.farObserver.observe(page);
    }
  }

  async extend(dir) {
    if (this.extending[dir]) return;
    const edge = dir > 0 ? this.sections[this.sections.length - 1] : this.sections[0];
    const index = edge.index + dir;
    if (index < 0 || index >= this.pdfs.length) {
      (dir > 0 ? this.endMarker : this.startMarker).hidden = false;
      return;
    }
    this.extending[dir] = true;
    const section = await this.loadSection(index);
    this.extending[dir] = false;
    if (!this.alive) return;
    this.insertSection(section, dir);
    this.onScroll();
  }

  allPages() {
    return this.sections.flatMap((s) => s.pages);
  }

  // The page under the reading line, and where the line crosses it.
  getAnchor() {
    const pages = this.allPages();
    if (!pages.length) return null;
    const line = mainEl.scrollTop + READING_LINE * mainEl.clientHeight;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pages[mid].offsetTop <= line) lo = mid;
      else hi = mid - 1;
    }
    const page = pages[lo];
    return { page, frac: clamp((line - page.offsetTop) / page.offsetHeight, 0, 1) };
  }

  applyAnchor(anchor) {
    mainEl.scrollTop = anchor.page.offsetTop + anchor.frac * anchor.page.offsetHeight - READING_LINE * mainEl.clientHeight;
  }

  restorePosition(section) {
    const pos = section.id && pdfData.get(section.id);
    if (pos && pos.page !== undefined && !pos.done && section.pages.length) {
      this.applyAnchor({ page: section.pages[Math.min(pos.page, section.pages.length - 1)], frac: pos.frac });
    } else {
      mainEl.scrollTop = section.el.offsetTop;
    }
  }

  onScroll() {
    if (!this.alive) return;
    const anchor = this.getAnchor();
    if (anchor) {
      const section = anchor.page.section;
      if (section !== this.current) this.setCurrent(section);
      this.anchor = anchor;
      this.visit(section).pages.add(anchor.page.pageIndex);
      this.checkRead(section);
      this.showProgress(anchor);
      this.savePosition();
    }
    const viewport = mainEl.clientHeight;
    if (this.container.offsetHeight - mainEl.scrollTop - viewport < 2 * viewport) this.extend(1);
    if (mainEl.scrollTop < 2 * viewport) this.extend(-1);
  }

  setCurrent(section) {
    const previous = this.current;
    this.current = section;
    // Reading past a PDF marks it as done, so that it opens from the start next time.
    if (previous && section.index > previous.index) {
      for (const s of this.sections) {
        if (s.index >= previous.index && s.index < section.index && s.pages.length) {
          pdfData.update(s.id, { page: s.pages.length - 1, frac: 1, pages: s.pages.length, done: true, at: Date.now() });
        }
      }
    }
    history.replaceState(null, '', makeHash(section.path, false));
    setTitle(displayName(section.name));
    renderCrumbs(section.path, false);
    this.updateZoomLabel();
    store.set('last:' + this.folderKey, section.name);
    for (const s of this.sections) {
      if (Math.abs(s.index - section.index) > 1) this.releaseDoc(s);
    }
  }

  writePosition() {
    const anchor = this.anchor;
    if (!anchor || !this.alive) return;
    const section = anchor.page.section;
    pdfData.update(section.id, {
      page: anchor.page.pageIndex,
      frac: +anchor.frac.toFixed(4),
      pages: section.pages.length,
      done: false,
      at: Date.now(),
    });
  }

  setZoom(zoom) {
    zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(zoom - this.zoom) < 1e-4) return;
    this.zooms[this.shape] = zoom;
    store.set(`zoom:${this.folderKey}|${this.shape}`, zoom);
    this.updateZoomLabel();
    this.relayout();
  }

  // Applies the zoom and the window width to all pages, and keeps the same spot in view.
  relayout() {
    const anchor = this.getAnchor();
    const centerX = mainEl.scrollWidth > mainEl.clientWidth
      ? (mainEl.scrollLeft + mainEl.clientWidth / 2) / mainEl.scrollWidth
      : 0.5;
    for (const section of this.sections) this.layoutSection(section);
    if (anchor) this.applyAnchor(anchor);
    mainEl.scrollLeft = centerX * mainEl.scrollWidth - mainEl.clientWidth / 2;
    clearTimeout(this.rerenderTimer);
    this.rerenderTimer = setTimeout(() => {
      for (const page of this.allPages()) if (page.near) this.pending.add(page);
      this.pump();
    }, 200);
  }

  onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002));
  }

  onKey(e) {
    if (e.altKey || e.metaKey) return;
    if (e.key === '+' || e.key === '=') this.setZoom(this.zoom * 1.1);
    else if (e.key === '-' || e.key === '_') this.setZoom(this.zoom / 1.1);
    else if (e.key === '0') this.setZoom(DEFAULT_ZOOM[this.shape]);
    else if (e.key === 'Escape' && !e.ctrlKey) location.hash = makeHash(this.folder, true);
    else return;
    e.preventDefault();
  }

  onNear(entries) {
    for (const entry of entries) {
      const page = entry.target;
      page.near = entry.isIntersecting;
      if (page.near) this.pending.add(page);
    }
    this.pump();
  }

  onFar(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) this.clearPage(entry.target);
    }
  }

  // Renders the pending pages, nearest to the view first.
  pump() {
    while (this.rendering < 2 && this.pending.size && this.alive) {
      const middle = mainEl.scrollTop + mainEl.clientHeight / 2;
      let best = null;
      let bestDistance = Infinity;
      for (const page of this.pending) {
        const d = Math.abs(page.offsetTop + page.offsetHeight / 2 - middle);
        if (d < bestDistance) { best = page; bestDistance = d; }
      }
      this.pending.delete(best);
      if (!best.near || best.renderedScale === best.scale) continue;
      this.rendering++;
      this.renderPage(best)
        .catch((e) => { if (e?.name !== 'RenderingCancelledException') console.warn('Render failed', e); })
        .finally(() => { this.rendering--; this.pump(); });
    }
  }

  async renderPage(page) {
    const section = page.section;
    const scale = page.scale;
    const doc = await this.ensureDoc(section);
    const pdfPage = await doc.getPage(page.pageIndex + 1);
    if (!this.alive || !page.near || page.scale !== scale) return;
    const size = section.sizes[page.pageIndex];
    let pixelScale = scale * (window.devicePixelRatio || 1);
    const pixels = size.w * size.h * pixelScale * pixelScale;
    if (pixels > MAX_CANVAS_PIXELS) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    const viewport = pdfPage.getViewport({ scale: pixelScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const task = pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
    page.task = task;
    await task.promise;
    if (page.task !== task) return;
    page.task = null;
    const old = page.querySelector('canvas');
    if (old) old.width = 0;
    page.replaceChildren(canvas);
    page.renderedScale = scale;
  }

  clearPage(page) {
    page.task?.cancel();
    page.task = null;
    const canvas = page.querySelector('canvas');
    if (canvas) {
      canvas.width = 0;
      canvas.remove();
    }
    page.renderedScale = 0;
  }

  visit(section) {
    if (!this.visits.has(section)) this.visits.set(section, { ms: 0, pages: new Set(), counted: false });
    return this.visits.get(section);
  }

  tickReading() {
    const section = this.current;
    if (document.hidden || !section?.pages.length) return;
    this.visit(section).ms += READ_TICK_MS;
    this.checkRead(section);
  }

  checkRead(section) {
    const visit = this.visit(section);
    if (!visit.counted && visit.ms >= READ_MIN_MS && visit.pages.size >= Math.min(READ_MIN_PAGES, section.pages.length)) {
      visit.counted = true;
      countRead(section.id);
    }
  }

  // Page and PDF numbers, and a bar that fills over the folder, or over the PDF when it is alone.
  showProgress(anchor) {
    const section = anchor.page.section;
    this.pageLabel.textContent = `p. ${anchor.page.pageIndex + 1}/${section.pages.length}`;
    this.pdfLabel.textContent = `PDF ${section.index + 1}/${this.pdfs.length}`;
    const inPdf = (anchor.page.pageIndex + anchor.frac) / section.pages.length;
    progressEl.firstChild.style.width = ((section.index + inPdf) / this.pdfs.length * 100).toFixed(2) + '%';
    progressEl.hidden = false;
  }

  destroy() {
    progressEl.hidden = true;
    clearInterval(this.readTimer);
    this.savePosition?.flush();
    this.alive = false;
    this.events.abort();
    this.nearObserver?.disconnect();
    this.farObserver?.disconnect();
    this.resizeObserver?.disconnect();
    clearTimeout(this.rerenderTimer);
    for (const section of this.sections) this.releaseDoc(section);
  }
}
