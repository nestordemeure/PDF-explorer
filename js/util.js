'use strict';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// "vol 2", "vol_2" and "vol2" sort the same.
const sortKey = (name) => name.replace(/(\D)[\s_-]*(?=\d)/g, '$1 ');
const naturalCompare = (a, b) => collator.compare(sortKey(a), sortKey(b)) || collator.compare(a, b);
const hasNumber = (name) => /\d/.test(name);
// The title of a series: the text before the first number, without "vol", "#" and the like.
const SERIES_END = /(?:[^\p{L}\p{N}]+(?:vol(?:ume)?|tome|issue|no|part|chapter|ch|book))?[^\p{L}\p{N}]*$/iu;
const seriesTitle = (name) => name.split(/\d/)[0].replace(SERIES_END, '').toLowerCase();

// Orders the PDFs of a folder of PDFs alone. Numbered names come first, so that issues
// come before extras. A name without a number that is the title of a numbered series
// stays with that series.
function sortIssues(pdfs) {
  const series = new Set(pdfs.filter((p) => hasNumber(p.name)).map((p) => seriesTitle(displayName(p.name))));
  const group = (name) => (hasNumber(name) || series.has(seriesTitle(name)) ? 0 : 1);
  return pdfs.sort((a, b) => {
    const nameA = displayName(a.name);
    const nameB = displayName(b.name);
    return group(nameA) - group(nameB) || naturalCompare(nameA, nameB);
  });
}

const crumbsEl = document.getElementById('crumbs');
const toolsEl = document.getElementById('tools');
const mainEl = document.getElementById('main');
const progressEl = document.getElementById('progress');

// Routes: "#/a/b/" is a folder, "#/a/b/c.pdf" is a PDF.
function parseHash(hash) {
  const raw = hash.replace(/^#\/?/, '');
  const isFolder = raw === '' || raw.endsWith('/');
  const segments = raw.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  return { segments, isFolder };
}

// A PDF route leaves out ".pdf": some PDF viewer extensions catch every URL that ends with it.
function makeHash(segments, isFolder) {
  if (!isFolder && segments.length) segments = [...segments.slice(0, -1), displayName(segments[segments.length - 1])];
  const s = segments.map(encodeURIComponent).join('/');
  return '#/' + s + (isFolder && s ? '/' : '');
}

const pathKey = (segments) => segments.join('/');
const displayName = (name) => name.replace(/\.pdf$/i, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, title, onClick) {
  const b = el('button', null, label);
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function link(label, href, className) {
  const a = el('a', className, label);
  a.href = href;
  return a;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Runs at most `max` of the given async functions at the same time.
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function throttle(fn, ms) {
  let timer = null;
  const wrapped = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
  wrapped.flush = () => { clearTimeout(timer); timer = null; fn(); };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

function setTitle(name) {
  document.title = name ? `${name} · PDF Explorer` : 'PDF Explorer';
}

function renderCrumbs(segments, isFolder) {
  const parts = [link(fsx.root.name, '#/', segments.length ? null : 'here')];
  segments.forEach((name, i) => {
    parts.push(el('span', 'sep', '/'));
    const last = i === segments.length - 1;
    if (last) parts.push(el('span', 'here', isFolder ? name : displayName(name)));
    else parts.push(link(name, makeHash(segments.slice(0, i + 1), true)));
  });
  crumbsEl.replaceChildren(...parts);
  crumbsEl.scrollLeft = crumbsEl.scrollWidth;
}

// Small JSON store in localStorage.
class Store {
  constructor(prefix) {
    this.prefix = prefix;
  }

  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(this.prefix + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  }

  set(key, value) {
    try { localStorage.setItem(this.prefix + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }

  update(key, changes) {
    this.set(key, { ...this.get(key, {}), ...changes });
  }
}

// Settings of each folder. The prefix holds the name of the root folder.
const store = new Store('px:');

// Reading data of each PDF: position, page count, last read, read count.
// The key is the file name and size, so that the data follows the file when it moves.
const pdfData = new Store('px:pdf:');
const pdfId = (file) => `${file.name}|${file.size}`;

// Fraction of a PDF that the user has read, or null.
function readProgress(record) {
  if (!record.pages || record.page === undefined) return null;
  return record.done ? 1 : clamp((record.page + Math.min(record.frac, 1)) / record.pages, 0, 1);
}

// IndexedDB keeps the root folder handle and the cover thumbnails.
const idb = (() => {
  let dbPromise = null;
  function open() {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('pdf-explorer', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('thumbs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function run(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    get: (storeName, key) => run(storeName, 'readonly', (s) => s.get(key)),
    set: (storeName, key, value) => run(storeName, 'readwrite', (s) => s.put(value, key)),
  };
})();
