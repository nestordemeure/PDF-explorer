'use strict';

// The PDF to open when the user switches a folder to reading mode.
function readTarget(segments, listing) {
  const last = store.get('last:' + pathKey(segments));
  const entry = listing.pdfs.find((p) => p.name === last) ?? listing.pdfs[0];
  return entry ? [...segments, entry.name] : null;
}

class FolderView {
  constructor(segments) {
    this.segments = segments;
    this.key = pathKey(segments);
    this.alive = true;
    this.events = new AbortController();
  }

  async mount() {
    const listing = await fsx.list(this.segments);
    if (!this.alive) return;

    // Folders and PDFs share one list. Only folders with subfolders can change the order,
    // so that the covers of a PDF folder keep the reading order.
    const canSort = listing.folders.length > 0;
    const sort = canSort ? store.get('sort:' + this.key, 'name') : 'name';
    const reverse = canSort && store.get('reverse:' + this.key, false);
    const items = [
      ...listing.folders.map((entry) => ({ entry, isFolder: true, label: entry.name })),
      ...listing.pdfs.map((entry) => ({ entry, isFolder: false, label: displayName(entry.name) })),
    ];
    items.sort((a, b) => naturalCompare(a.label, b.label));
    if (sort !== 'name') {
      mainEl.replaceChildren(el('p', 'empty', 'Sorting…'));
      await Promise.all(items.map((item) => this.measure(item, sort)));
      if (!this.alive) return;
      // Largest first on each key in turn. Sort is stable, so full ties stay in name order.
      const { keys } = SORT_MODES.find((m) => m.mode === sort);
      items.sort((a, b) => {
        for (const key of keys) if (b[key] !== a[key]) return b[key] - a[key];
        return 0;
      });
    }
    if (reverse) items.reverse();

    setTitle(this.segments.length ? this.segments[this.segments.length - 1] : fsx.root.name);
    renderCrumbs(this.segments, true);
    const tools = [];
    const target = readTarget(this.segments, listing);
    if (target) {
      tools.push(button('📖 Read', 'Read all PDFs of this folder in one scroll (R)', () => {
        location.hash = makeHash(target, false);
      }));
    }
    if (canSort) tools.push(this.sortButtons(sort), this.reverseToggle(reverse));
    tools.push(button('📂', 'Choose another root folder', () => chooseRoot()));
    toolsEl.replaceChildren(...tools);

    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.observer.unobserve(entry.target);
        entry.target.load();
      }
    }, { root: mainEl, rootMargin: '600px 0px' });

    const content = [];
    const last = store.get('last:' + this.key);
    const lastEntry = listing.pdfs.find((p) => p.name === last);
    if (lastEntry) {
      const pos = await lastEntry.handle.getFile().then((file) => pdfData.get(pdfId(file), {}), () => ({}));
      if (!this.alive) return;
      const where = pos.page !== undefined && !pos.done ? ` · page ${pos.page + 1} of ${pos.pages}` : '';
      const resume = link('', makeHash([...this.segments, last], false), 'resume');
      resume.append(el('span', 'resume-label', 'Continue reading'), el('span', 'resume-name', displayName(last) + where));
      content.push(resume);
    }

    if (!listing.folders.length && !listing.pdfs.length) {
      content.push(el('p', 'empty', 'No folders or PDFs here.'));
    } else {
      const grid = el('div', 'grid');
      for (const item of items) {
        grid.append(item.isFolder ? this.folderCard(item.entry, item.info) : this.pdfCard(item.entry, item.info));
      }
      content.push(grid);
    }

    mainEl.replaceChildren(...content);
    mainEl.scrollTop = store.get('scroll:' + this.key, 0);
    mainEl.focus({ preventScroll: true });

    const saveScroll = throttle(() => store.set('scroll:' + this.key, mainEl.scrollTop), 250);
    this.saveScroll = saveScroll;
    mainEl.addEventListener('scroll', saveScroll, { signal: this.events.signal });
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'r' && target && !e.ctrlKey && !e.metaKey && !e.altKey) {
        location.hash = makeHash(target, false);
      }
    }, { signal: this.events.signal });
  }

  // Finds the sort key of an item, and the text that its card shows for it.
  async measure(item, sort) {
    const segments = [...this.segments, item.entry.name];
    Object.assign(item, { date: 0, read: 0, reads: 0, count: 0, pages: 0 });
    try {
      if (item.isFolder) {
        Object.assign(item, await fsx.folderStats(segments));
        const sub = await fsx.list(segments);
        if (sort === 'size' && sub.folders.length) item.info = plural(item.count, 'PDF') + ' in all';
      } else {
        const file = await item.entry.handle.getFile();
        const record = pdfData.get(pdfId(file), {});
        Object.assign(item, { date: file.lastModified, read: record.at ?? 0, reads: record.reads ?? 0, count: 1 });
        if (sort === 'size') {
          item.pages = await pageCount(file);
          item.info = plural(item.pages, 'page');
        }
      }
    } catch { /* unreadable items go last */ }
    if (sort === 'date' && item.date) item.info = formatDate(item.date);
    if (sort === 'read' && item.read) item.info = 'Read ' + formatDate(item.read);
    if (sort === 'popular' && item.reads) item.info = item.reads === 1 ? 'Read once' : `Read ${item.reads} times`;
  }

  sortButtons(sort) {
    const group = el('div', 'segmented');
    for (const { mode, label, title } of SORT_MODES) {
      const b = button(label, title, () => {
        if (mode === sort) return;
        store.set('sort:' + this.key, mode);
        store.set('scroll:' + this.key, 0);
        route();
      });
      if (mode === sort) b.className = 'active';
      group.append(b);
    }
    return group;
  }

  reverseToggle(reverse) {
    const b = button(reverse ? '↑' : '↓', reverse ? 'Reversed order: click for the normal order' : 'Reverse the order', () => {
      store.set('reverse:' + this.key, !reverse);
      store.set('scroll:' + this.key, 0);
      route();
    });
    if (reverse) b.className = 'active';
    return b;
  }

  folderCard(folder, info) {
    const segments = [...this.segments, folder.name];
    const card = link('', makeHash(segments, true), 'card folder');
    const thumb = el('div', 'thumb');
    thumb.append(el('span', 'icon', '📁'));
    const meta = el('div', 'meta');
    card.append(thumb, el('div', 'name', folder.name), meta);

    card.load = async () => {
      try {
        const sub = await fsx.list(segments);
        const parts = [];
        if (sub.folders.length) parts.push(plural(sub.folders.length, 'folder'));
        if (sub.pdfs.length) parts.push(plural(sub.pdfs.length, 'PDF'));
        if (info) parts.push(info);
        meta.textContent = parts.join(' · ') || 'Empty';
        // A folder with only PDFs shows the cover of its first PDF.
        if (!sub.folders.length && sub.pdfs.length) {
          card.classList.add('stack');
          const url = await thumbs.get([...segments, sub.pdfs[0].name], sub.pdfs[0].handle);
          if (this.alive) showCover(thumb, url);
        }
      } catch (e) {
        if (e.name !== 'AbortError') meta.textContent = 'Cannot read';
      }
    };
    this.observer.observe(card);
    return card;
  }

  pdfCard(pdf, info) {
    const segments = [...this.segments, pdf.name];
    const card = link('', makeHash(segments, false), 'card pdf');
    const thumb = el('div', 'thumb');
    thumb.append(el('span', 'icon', '📄'));
    card.append(thumb, el('div', 'name', displayName(pdf.name)));
    if (info) card.append(el('div', 'meta', info));

    card.load = async () => {
      try {
        const file = await pdf.handle.getFile();
        const progress = readProgress(pdfData.get(pdfId(file), {}));
        if (progress !== null) {
          const bar = el('div', 'progress');
          const fill = el('i');
          fill.style.width = (progress * 100).toFixed(1) + '%';
          bar.append(fill);
          card.append(bar);
        }
        const url = await thumbs.get(segments, pdf.handle);
        if (this.alive) showCover(thumb, url);
      } catch (e) {
        if (e.name !== 'AbortError') thumb.classList.add('broken');
      }
    };
    this.observer.observe(card);
    return card;
  }

  destroy() {
    this.alive = false;
    this.saveScroll?.flush();
    this.events.abort();
    this.observer?.disconnect();
    thumbs.cancelPending();
  }
}

// Each mode sorts on its keys in turn, largest first.
const SORT_MODES = [
  { mode: 'name', keys: [], label: 'A–Z', title: 'Sort by name' },
  { mode: 'date', keys: ['date'], label: 'Modified', title: 'Sort by last change, newest first' },
  { mode: 'read', keys: ['read', 'reads'], label: 'Last read', title: 'Sort by last reading, most recent first' },
  { mode: 'size', keys: ['count', 'pages'], label: 'Size', title: 'Sort by number of PDFs, then by number of pages, largest first' },
  { mode: 'popular', keys: ['reads', 'read'], label: 'Most read', title: 'Sort by number of reads, then by last reading' },
];

const A4_RATIO = 210 / 297;

// Covers close to A4 fill the card and lose a thin edge. Other shapes fit inside it.
function showCover(thumb, url) {
  const img = el('img');
  img.alt = '';
  img.onload = () => {
    const ratio = img.naturalWidth / img.naturalHeight;
    if (Math.abs(ratio / A4_RATIO - 1) < 0.2) img.classList.add('fill');
  };
  img.src = url;
  thumb.replaceChildren(img);
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (ms) => dateFormat.format(new Date(ms));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
