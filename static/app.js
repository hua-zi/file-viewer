const state = {
  path: new URLSearchParams(location.search).get('path') || '',
  items: [],
  filter: 'all',
  query: '',
  view: localStorage.getItem('file-view') || 'grid',
  sort: localStorage.getItem('file-sort') || 'name',
  rootName: '服务器',
};

const $ = (selector) => document.querySelector(selector);
const grid = $('#fileGrid');
const loading = $('#loadingState');
const empty = $('#emptyState');
const errorState = $('#errorState');
const preview = $('#preview');
const previewPanel = preview.querySelector('.preview-panel');
const previewStage = $('#previewStage');

const typeOf = (item) => {
  if (item.kind === 'folder') return 'folder';
  if (isDatabase(item)) return 'database';
  if (isArchive(item)) return 'archive';
  const group = item.mime.split('/')[0];
  if (['video', 'image', 'audio'].includes(group)) return group;
  if (item.mime === 'application/pdf' || isTextPreview(item)) return 'document';
  return 'other';
};

const isDatabase = (item) => {
  const extension = item.name.split('.').pop()?.toLowerCase();
  return item.mime === 'application/vnd.sqlite3' || ['db', 'sqlite', 'sqlite3'].includes(extension);
};

const isArchive = (item) => {
  const name = item.name.toLowerCase();
  return ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz']
    .some((extension) => name.endsWith(extension));
};

const isTextPreview = (item) => {
  const extension = item.name.split('.').pop()?.toLowerCase();
  return item.mime.startsWith('text/')
    || ['application/json', 'application/yaml', 'application/x-yaml'].includes(item.mime)
    || ['json', 'yaml', 'yml'].includes(extension);
};

const iconFor = (type) => ({
  folder: '▰', video: '▷', image: '▧', audio: '♫', document: '▤', database: '▦', archive: '▥', other: '◇',
})[type];

const formatSize = (bytes) => {
  if (bytes == null) return '文件夹';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

const formatDate = (iso, long = false) => new Intl.DateTimeFormat('zh-CN', {
  year: long ? 'numeric' : undefined,
  month: long ? 'long' : '2-digit',
  day: '2-digit',
  hour: long ? '2-digit' : undefined,
  minute: long ? '2-digit' : undefined,
}).format(new Date(iso));

const encodedUrl = (prefix, path) => `${prefix}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function loadFiles(pushHistory = false) {
  loading.hidden = false;
  grid.hidden = true;
  empty.hidden = true;
  errorState.hidden = true;
  try {
    const response = await fetch(`/api/files?path=${encodeURIComponent(state.path)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '服务器响应异常');
    state.items = data.items;
    state.path = data.path;
    state.rootName = data.rootName;
    if (pushHistory) {
      const suffix = state.path ? `?path=${encodeURIComponent(state.path)}` : location.pathname;
      history.pushState({ path: state.path }, '', suffix);
    }
    renderBreadcrumbs();
    renderFiles();
  } catch (error) {
    loading.hidden = true;
    errorState.hidden = false;
    $('#errorMessage').textContent = error.message;
  }
}

function visibleItems() {
  const items = state.items.filter((item) => {
    const itemType = typeOf(item);
    const matchesType = state.filter === 'all'
      || itemType === state.filter
      || (state.filter === 'document' && ['database', 'archive'].includes(itemType));
    const matchesQuery = item.name.toLocaleLowerCase().includes(state.query.toLocaleLowerCase());
    return matchesType && matchesQuery;
  });
  return items.sort((left, right) => {
    if (state.sort === 'modified-desc') {
      return new Date(right.modified).getTime() - new Date(left.modified).getTime()
        || left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
    }
    if (state.sort === 'modified-asc') {
      return new Date(left.modified).getTime() - new Date(right.modified).getTime()
        || left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
    }
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
  });
}

function renderFiles() {
  const items = visibleItems();
  loading.hidden = true;
  errorState.hidden = true;
  grid.hidden = items.length === 0;
  empty.hidden = items.length !== 0;
  $('#itemCount').textContent = `${items.length} 项${state.items.length !== items.length ? ` / 共 ${state.items.length} 项` : ''}`;
  grid.classList.toggle('list-view', state.view === 'list');
  $('#gridView').classList.toggle('active', state.view === 'grid');
  $('#listView').classList.toggle('active', state.view === 'list');
  grid.replaceChildren(...items.map(makeCard));
}

function makeCard(item, index) {
  const type = typeOf(item);
  const card = document.createElement('article');
  card.className = 'file-card';
  card.dataset.type = type;
  card.tabIndex = 0;
  card.style.animationDelay = `${Math.min(index * 18, 180)}ms`;
  const ext = item.kind === 'file' && item.name.includes('.') ? item.name.split('.').pop().slice(0, 5).toUpperCase() : '';
  card.innerHTML = `
    <div class="file-visual">
      <span class="file-icon">${iconFor(type)}</span>
      ${ext ? `<span class="extension">${escapeHtml(ext)}</span>` : ''}
      ${type === 'folder' ? '<span class="folder-arrow">→</span>' : ''}
    </div>
    <div class="file-info">
      <p class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
      <div class="file-subtitle"><span>${formatDate(item.modified)}</span><span>${formatSize(item.size)}</span></div>
    </div>`;
  const open = () => item.kind === 'folder' ? navigate(item.path) : openPreview(item);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
  return card;
}

function renderBreadcrumbs() {
  const crumbs = [{ name: state.rootName, path: '' }];
  let built = '';
  for (const segment of state.path.split('/').filter(Boolean)) {
    built = built ? `${built}/${segment}` : segment;
    crumbs.push({ name: segment, path: built });
  }
  const nav = $('#breadcrumbs');
  nav.replaceChildren();
  crumbs.forEach((crumb, index) => {
    if (index) nav.append(Object.assign(document.createElement('span'), { textContent: '/' }));
    const button = Object.assign(document.createElement('button'), { textContent: crumb.name });
    button.addEventListener('click', () => navigate(crumb.path));
    nav.append(button);
  });
}

function navigate(path, push = true) {
  state.path = path;
  state.query = '';
  $('#searchInput').value = '';
  document.body.classList.remove('menu-open');
  loadFiles(push);
}

function openPreview(item) {
  resetPreviewPanel();
  const type = typeOf(item);
  const contentUrl = encodedUrl('/content', item.path);
  $('#previewTitle').textContent = item.name;
  $('#previewMeta').textContent = `${type.toUpperCase()} · ${formatSize(item.size)}`;
  $('#previewTypeIcon').textContent = iconFor(type);
  $('#previewPath').textContent = `/${item.path}`;
  $('#previewDate').textContent = formatDate(item.modified, true);
  $('#previewMime').textContent = item.mime;
  $('#downloadButton').href = encodedUrl('/download', item.path);
  $('#downloadButton').setAttribute('download', item.name);
  previewStage.replaceChildren();

  let media;
  if (type === 'video') {
    media = document.createElement('video');
    media.src = contentUrl; media.controls = true; media.autoplay = true; media.playsInline = true;
  } else if (type === 'image') {
    media = document.createElement('img');
    media.src = contentUrl; media.alt = item.name;
  } else if (type === 'audio') {
    media = document.createElement('audio');
    media.src = contentUrl; media.controls = true; media.autoplay = true;
  } else if (item.mime === 'application/pdf') {
    media = document.createElement('iframe');
    media.src = contentUrl; media.title = item.name;
  } else if (type === 'database') {
    media = createDatabasePreview(item);
  } else if (type === 'archive') {
    media = createArchivePreview(item);
  } else if (isTextPreview(item)) {
    media = document.createElement('pre');
    media.textContent = '正在载入文本…';
    fetch(contentUrl, { headers: { Range: 'bytes=0-524287' } })
      .then((response) => response.text())
      .then((text) => {
        const extension = item.name.split('.').pop()?.toLowerCase();
        if (extension === 'json' || item.mime === 'application/json') {
          try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 展示原始内容 */ }
        }
        media.textContent = text + (item.size > 524288 ? '\n\n… 仅显示前 512 KB' : '');
      })
      .catch(() => { media.textContent = '无法读取文本内容'; });
  } else {
    media = document.createElement('div');
    media.className = 'unsupported';
    media.innerHTML = `<span>${iconFor(type)}</span><strong>暂无在线预览</strong><small>你仍然可以下载此文件</small>`;
  }
  previewStage.append(media);
  preview.hidden = false;
  document.body.style.overflow = 'hidden';
}

function createDatabasePreview(item) {
  const viewer = document.createElement('div');
  viewer.className = 'db-viewer';
  viewer.innerHTML = '<div class="db-loading"><div class="spinner"></div><span>正在读取数据库…</span></div>';

  const load = async (table = '', page = 1) => {
    viewer.innerHTML = '<div class="db-loading"><div class="spinner"></div><span>正在读取数据…</span></div>';
    const params = new URLSearchParams({ path: item.path, page: String(page), pageSize: '50' });
    if (table) params.set('table', table);
    try {
      const response = await fetch(`/api/database?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '数据库读取失败');
      renderDatabase(viewer, data, load);
    } catch (error) {
      viewer.innerHTML = `<div class="db-error"><strong>无法预览数据库</strong><span>${escapeHtml(error.message)}</span></div>`;
    }
  };
  load();
  return viewer;
}

function createArchivePreview(item) {
  const viewer = document.createElement('div');
  viewer.className = 'archive-viewer';
  viewer.innerHTML = '<div class="archive-loading"><div class="spinner"></div><span>正在读取压缩包目录…</span></div>';
  fetch(`/api/archive?path=${encodeURIComponent(item.path)}`)
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '压缩包读取失败');
      renderArchive(viewer, data);
    })
    .catch((error) => {
      viewer.innerHTML = `<div class="archive-error"><strong>无法预览压缩包</strong><span>${escapeHtml(error.message)}</span></div>`;
    });
  return viewer;
}

function renderArchive(viewer, data) {
  const root = { name: '', children: new Map(), kind: 'directory' };
  data.entries.forEach((entry) => {
    const parts = entry.path.split('/').filter(Boolean);
    let parent = root;
    parts.forEach((name, index) => {
      if (!parent.children.has(name)) {
        parent.children.set(name, { name, kind: 'directory', size: 0, children: new Map() });
      }
      const node = parent.children.get(name);
      if (index === parts.length - 1) Object.assign(node, entry, { name, children: node.children });
      parent = node;
    });
  });

  viewer.replaceChildren();
  const toolbar = document.createElement('header');
  toolbar.className = 'archive-toolbar';
  toolbar.innerHTML = `
    <div><strong>${escapeHtml(data.format)} 压缩包</strong><span>${data.fileCount.toLocaleString()} 个文件 · ${data.directoryCount.toLocaleString()} 个目录</span></div>
    ${data.truncated ? `<div class="archive-warning">仅显示前 ${data.limit.toLocaleString()} 项</div>` : ''}`;
  viewer.append(toolbar);

  if (!data.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'archive-empty';
    empty.innerHTML = '<strong>空压缩包</strong><span>没有找到文件或目录</span>';
    viewer.append(empty);
    return;
  }
  const treeWrap = document.createElement('div');
  treeWrap.className = 'archive-tree-wrap';
  treeWrap.append(buildArchiveTree(root.children, 0));
  viewer.append(treeWrap);
}

function buildArchiveTree(children, depth) {
  const list = document.createElement('ul');
  list.className = 'archive-tree';
  [...children.values()]
    .sort((left, right) => {
      const leftFolder = left.kind === 'directory' || left.children.size > 0;
      const rightFolder = right.kind === 'directory' || right.children.size > 0;
      return Number(rightFolder) - Number(leftFolder) || left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
    })
    .forEach((node) => {
      const item = document.createElement('li');
      const hasChildren = node.children.size > 0;
      if (hasChildren || node.kind === 'directory') {
        const details = document.createElement('details');
        details.open = depth < 1;
        const summary = document.createElement('summary');
        summary.innerHTML = `<span class="archive-node-icon">▰</span><span class="archive-node-name"></span><small>${node.children.size} 项</small>`;
        summary.querySelector('.archive-node-name').textContent = node.name;
        details.append(summary, buildArchiveTree(node.children, depth + 1));
        item.append(details);
      } else {
        const row = document.createElement('div');
        row.className = 'archive-file-row';
        const icon = node.kind === 'link' ? '↗' : node.encrypted ? '◆' : '◇';
        row.innerHTML = `<span class="archive-node-icon">${icon}</span><span class="archive-node-name"></span><small>${formatSize(node.size)}</small>`;
        row.querySelector('.archive-node-name').textContent = node.name;
        row.title = node.linkTarget ? `链接至 ${node.linkTarget}` : node.encrypted ? '加密文件' : node.path;
        item.append(row);
      }
      list.append(item);
    });
  return list;
}

function renderDatabase(viewer, data, load) {
  if (!data.tables.length) {
    viewer.innerHTML = '<div class="db-empty"><strong>空数据库</strong><span>没有找到数据表或视图</span></div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  viewer.innerHTML = `
    <aside class="db-sidebar">
      <div class="db-sidebar-title">数据表 <span>${data.tables.length}</span></div>
      <div class="db-table-list"></div>
    </aside>
    <section class="db-content">
      <header class="db-toolbar">
        <div><strong>${escapeHtml(data.table)}</strong><span>${data.total.toLocaleString()} 行 · ${data.columns.length} 列</span></div>
        <div class="db-pagination">
          <button data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>←</button>
          <span>${data.page} / ${totalPages}</span>
          <button data-page="${data.page + 1}" ${data.page >= totalPages ? 'disabled' : ''}>→</button>
        </div>
      </header>
      <div class="db-table-wrap"><table class="db-data-table"><thead><tr></tr></thead><tbody></tbody></table></div>
    </section>`;

  const list = viewer.querySelector('.db-table-list');
  data.tables.forEach((entry) => {
    const button = document.createElement('button');
    button.className = entry.name === data.table ? 'active' : '';
    button.innerHTML = `<span>${entry.type === 'view' ? '◇' : '▦'}</span><span title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>`;
    button.addEventListener('click', () => load(entry.name, 1));
    list.append(button);
  });

  const head = viewer.querySelector('thead tr');
  data.columns.forEach((column) => {
    const cell = document.createElement('th');
    cell.innerHTML = `<span>${escapeHtml(column.name)}</span><small>${escapeHtml(column.type)}${column.primaryKey ? ' · PK' : ''}</small>`;
    head.append(cell);
  });
  const body = viewer.querySelector('tbody');
  if (!data.rows.length) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = Math.max(1, data.columns.length);
    cell.className = 'db-no-rows';
    cell.textContent = '此表没有数据';
  } else {
    data.rows.forEach((values) => {
      const row = body.insertRow();
      values.forEach((value) => {
        const cell = row.insertCell();
        if (value === null) {
          cell.innerHTML = '<i>NULL</i>';
        } else if (typeof value === 'object' && value.blob) {
          cell.innerHTML = `<span class="db-blob">BLOB · ${formatSize(value.size)}</span>`;
          cell.title = value.preview;
        } else {
          cell.textContent = String(value);
          cell.title = String(value);
        }
      });
    });
  }
  viewer.querySelectorAll('.db-pagination button:not(:disabled)').forEach((button) => {
    button.addEventListener('click', () => load(data.table, Number(button.dataset.page)));
  });
}

function closePreview() {
  preview.hidden = true;
  previewStage.querySelectorAll('video,audio').forEach((media) => media.pause());
  previewStage.replaceChildren();
  document.body.style.overflow = '';
}

function resetPreviewPanel() {
  previewPanel.style.removeProperty('position');
  previewPanel.style.removeProperty('left');
  previewPanel.style.removeProperty('top');
  previewPanel.style.removeProperty('width');
  previewPanel.style.removeProperty('height');
  previewPanel.style.removeProperty('max-height');
}

const resizeHandle = $('#previewResizeHandle');
let resizeState = null;

resizeHandle.addEventListener('pointerdown', (event) => {
  if (window.matchMedia('(max-width: 760px)').matches) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = previewPanel.getBoundingClientRect();
  resizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: rect.width,
    startHeight: rect.height,
  };
  previewPanel.style.width = `${rect.width}px`;
  previewPanel.style.height = `${rect.height}px`;
  previewPanel.style.maxHeight = 'none';
  resizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add('preview-resizing');
});

resizeHandle.addEventListener('pointermove', (event) => {
  if (!resizeState || event.pointerId !== resizeState.pointerId) return;
  const maxWidth = Math.max(360, window.innerWidth - 56);
  const maxHeight = Math.max(300, window.innerHeight - 56);
  const width = Math.min(maxWidth, Math.max(520, resizeState.startWidth + event.clientX - resizeState.startX));
  const height = Math.min(maxHeight, Math.max(400, resizeState.startHeight + event.clientY - resizeState.startY));
  previewPanel.style.width = `${width}px`;
  previewPanel.style.height = `${height}px`;
});

const finishResize = (event) => {
  if (!resizeState || event.pointerId !== resizeState.pointerId) return;
  resizeState = null;
  document.body.classList.remove('preview-resizing');
  if (resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
};
resizeHandle.addEventListener('pointerup', finishResize);
resizeHandle.addEventListener('pointercancel', finishResize);

function escapeHtml(text) {
  const element = document.createElement('span');
  element.textContent = text;
  return element.innerHTML;
}

function setView(view) {
  state.view = view;
  localStorage.setItem('file-view', view);
  renderFiles();
}

$('#searchInput').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderFiles(); });
$('#sortSelect').value = ['name', 'modified-desc', 'modified-asc'].includes(state.sort) ? state.sort : 'name';
$('#sortSelect').addEventListener('change', (event) => {
  state.sort = event.target.value;
  localStorage.setItem('file-sort', state.sort);
  renderFiles();
});
$('#refreshButton').addEventListener('click', () => { loadFiles(); showToast('文件列表已刷新'); });
$('#retryButton').addEventListener('click', () => loadFiles());
$('#gridView').addEventListener('click', () => setView('grid'));
$('#listView').addEventListener('click', () => setView('list'));
$('#mobileMenu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
document.querySelectorAll('[data-close-preview]').forEach((el) => el.addEventListener('click', closePreview));
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.filter = button.dataset.filter;
  document.body.classList.remove('menu-open');
  renderFiles();
}));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !preview.hidden) closePreview();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); $('#searchInput').focus();
  }
});
window.addEventListener('popstate', (event) => navigate(event.state?.path ?? new URLSearchParams(location.search).get('path') ?? '', false));

let toastTimer;
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

loadFiles();
