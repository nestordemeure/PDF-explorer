'use strict';

// Access to the folder that the user picked, through the File System Access API.
const fsx = {
  root: null,
  listings: new Map(),
  stats: new Map(),

  setRoot(handle) {
    this.root = handle;
    this.listings.clear();
    this.stats.clear();
  },

  async resolveDir(segments) {
    let dir = this.root;
    for (const name of segments) dir = await dir.getDirectoryHandle(name);
    return dir;
  },

  async resolveFile(segments) {
    const dir = await this.resolveDir(segments.slice(0, -1));
    return dir.getFileHandle(segments[segments.length - 1]);
  },

  // Returns the visible subfolders and PDFs of a folder, in natural order.
  async list(segments) {
    const key = pathKey(segments);
    if (this.listings.has(key)) return this.listings.get(key);
    const dir = await this.resolveDir(segments);
    const folders = [];
    const pdfs = [];
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') folders.push({ name, handle });
      else if (/\.pdf$/i.test(name)) pdfs.push({ name, handle });
    }
    const byName = (a, b) => naturalCompare(a.name, b.name);
    folders.sort(byName);
    pdfs.sort(byName);
    const listing = { folders, pdfs };
    this.listings.set(key, listing);
    return listing;
  },

  // Totals over the PDFs in a folder, a few levels down: how many there are, the newest change,
  // the last read and the number of reads. A folder has no data of its own.
  async folderStats(segments, depth = 2) {
    const key = depth + ':' + pathKey(segments);
    if (this.stats.has(key)) return this.stats.get(key);
    const listing = await this.list(segments);
    const empty = { count: 0, date: 0, read: 0, reads: 0 };
    const [pdfs, subs] = await Promise.all([
      Promise.all(listing.pdfs.map((p) => p.handle.getFile().then((file) => {
        const record = pdfData.get(pdfId(file), {});
        return { count: 1, date: file.lastModified, read: record.at ?? 0, reads: record.reads ?? 0 };
      }, () => empty))),
      depth > 0 ? Promise.all(listing.folders.map((f) => this.folderStats([...segments, f.name], depth - 1).catch(() => empty))) : [],
    ]);
    const all = [...pdfs, ...subs];
    const stats = {
      count: all.reduce((sum, s) => sum + s.count, 0),
      date: Math.max(0, ...all.map((s) => s.date)),
      read: Math.max(0, ...all.map((s) => s.read)),
      reads: all.reduce((sum, s) => sum + s.reads, 0),
    };
    this.stats.set(key, stats);
    return stats;
  },

  // Folders can change at any time, so each view reads them again.
  forget() {
    this.listings.clear();
    this.stats.clear();
  },
};
