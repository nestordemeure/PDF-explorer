'use strict';

let currentView = null;

async function boot() {
  if (!window.showDirectoryPicker) {
    showWelcome(null, 'This app needs Chrome, Edge, Brave or another Chromium browser. It reads your folders with the File System Access API, which other browsers do not have.');
    return;
  }
  let handle = null;
  try { handle = await idb.get('kv', 'root'); } catch { /* no stored folder */ }
  try {
    if (handle && await handle.queryPermission({ mode: 'read' }) === 'granted') return useRoot(handle);
  } catch { handle = null; }
  showWelcome(handle);
}

function showWelcome(handle, error) {
  currentView?.destroy();
  currentView = null;
  setTitle('');
  crumbsEl.replaceChildren(el('span', 'here', '📚 PDF Explorer'));
  toolsEl.replaceChildren();
  const box = el('div', 'welcome');
  box.append(el('div', 'welcome-icon', '📚'), el('h1', null, 'PDF Explorer'));
  if (error) {
    box.append(el('p', null, error));
  } else if (handle) {
    box.append(el('p', null, `The browser needs your permission again to read “${handle.name}”.`));
    const actions = el('div', 'actions');
    const open = button(`Open ${handle.name}`, null, async () => {
      if (await handle.requestPermission({ mode: 'read' }) === 'granted') useRoot(handle);
    });
    open.className = 'primary';
    actions.append(open, button('Choose another folder', null, () => chooseRoot()));
    box.append(actions);
  } else {
    box.append(el('p', null, 'Choose the folder that holds your PDFs. The browser asks once for permission to read it.'));
    const choose = button('Choose folder', null, () => chooseRoot());
    choose.className = 'primary';
    box.append(choose);
  }
  mainEl.replaceChildren(box);
}

async function chooseRoot() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'pdf-explorer', mode: 'read' });
  } catch (e) {
    if (e.name !== 'AbortError') alert(`Cannot open this folder: ${e.message}`);
    return;
  }
  try { await idb.set('kv', 'root', handle); } catch (e) { console.warn('Cannot remember the folder', e); }
  const changed = fsx.root && !(await fsx.root.isSameEntry(handle));
  if (changed && location.hash !== '#/') {
    useRoot(handle, false);
    location.hash = '#/';
  } else {
    useRoot(handle);
  }
}

function useRoot(handle, render = true) {
  fsx.setRoot(handle);
  store.prefix = `px:${handle.name}:`;
  if (render) route();
}

async function route() {
  if (!fsx.root) return;
  currentView?.destroy();
  fsx.forget();
  const { segments, isFolder } = parseHash(location.hash);
  const view = isFolder ? new FolderView(segments) : new ReaderView(segments);
  currentView = view;
  mainEl.replaceChildren();
  mainEl.scrollTop = 0;
  mainEl.scrollLeft = 0;
  try {
    await view.mount();
  } catch (e) {
    if (currentView !== view) return;
    console.error(e);
    showError(segments, e);
  }
}

async function showError(segments, e) {
  setTitle('Not found');
  toolsEl.replaceChildren();
  const box = el('div', 'welcome');
  const missing = ['NotFoundError', 'TypeMismatchError', 'MissingPdfError'].includes(e.name);
  box.append(el('p', null, missing ? `“${segments.join('/')}” is not in ${fsx.root.name} any more.` : e.message));
  mainEl.replaceChildren(box);
  // Things move: offer the nearest folder that still exists.
  for (let i = segments.length - 1; i > 0; i--) {
    try {
      await fsx.resolveDir(segments.slice(0, i));
      box.append(link(`Open ${segments[i - 1]}`, makeHash(segments.slice(0, i), true)), ' · ');
      break;
    } catch { /* go up one level */ }
  }
  box.append(link(`Open ${fsx.root.name}`, '#/'));
}

window.addEventListener('hashchange', route);
boot();
