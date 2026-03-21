(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const STORAGE_KEY = 'textbook_maker_state_v3';
  const LAYOUT_KEY = 'textbook_maker_layout_v3';
  const MIN_PANEL = 240;
  const MAX_PANEL = 720;
  const COLLAPSED_WIDTH = 52;
  const HISTORY_LIMIT = 40;
  const FULLSCREEN_CLASS = 'fullscreen-preview';
  const GRID_KINDS = new Set(['tile', 'dot', 'array', 'ohajiki', 'bead', 'grid']);
  const SPRITE_MASK_ENABLED = window.location.protocol !== 'file:';
  let saveTimer = null;
  let saveRetryAt = 0;
  let saveFailNotified = false;
  let persistLayout = () => {};
  let previewFullscreen = false;

  const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
  const normalizeCombineDigits = (value) => {
    const parsed = parseInt(value, 10);
    return parsed === 3 ? 3 : 2;
  };
  const isTransparent = (value) => {
    if (!value) return true;
    const v = String(value).toLowerCase().trim();
    if (v === 'transparent') return true;
    if (v.startsWith('rgba') && v.endsWith(', 0)')) return true;
    if (v.endsWith(',0)')) return true;
    return false;
  };
  const hexToRgba = (hex, alpha = 1) => {
    const raw = String(hex).trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) return hex;
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const TOAST_DURATION = 2400;
  const showToast = (message, type = 'info') => {
    const root = $('#toast-root');
    if (!root) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    root.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('hide');
      toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, TOAST_DURATION);
  };

  const showContextMenu = (x, y) => {
    const menu = $('#context-menu');
    if (!menu) return;
    menu.classList.add('open');
    menu.setAttribute('aria-hidden', 'false');
    const rect = menu.getBoundingClientRect();
    const nextX = clamp(x, 8, window.innerWidth - rect.width - 8);
    const nextY = clamp(y, 8, window.innerHeight - rect.height - 8);
    menu.style.left = `${nextX}px`;
    menu.style.top = `${nextY}px`;
  };

  const hideContextMenu = () => {
    const menu = $('#context-menu');
    if (!menu) return;
    menu.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
  };

  const downloadBackup = (reason = 'backup') => {
    const safeReason = String(reason || 'backup').replace(/[^a-z0-9_-]+/gi, '-');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `textbook_project_${safeReason}_${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  let renderQueued = false;
  const pendingRender = { pages: false, inspector: false, layers: false };
  const scheduleRender = (opts = {}) => {
    if (opts.pages) pendingRender.pages = true;
    if (opts.inspector) pendingRender.inspector = true;
    if (opts.layers) pendingRender.layers = true;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (pendingRender.pages) renderPages();
      if (pendingRender.inspector) renderInspector();
      if (pendingRender.layers) renderLayers();
      pendingRender.pages = false;
      pendingRender.inspector = false;
      pendingRender.layers = false;
    });
  };

  let gridSizeCache = null;
  const getGridSize = () => {
    if (gridSizeCache) return gridSizeCache;
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--grid-size');
    const parsed = parseFloat(raw);
    gridSizeCache = Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
    return gridSizeCache;
  };
  const snapValue = (value) => {
    const size = getGridSize();
    return Math.round(value / size) * size;
  };

  const history = { stack: [], index: -1 };
  let historyTimer = null;
  let historyLocked = false;

  const updateHistoryButtons = () => {
    const undoBtn = $('#undo');
    const redoBtn = $('#redo');
    const undoCount = Math.max(0, history.index);
    const redoCount = Math.max(0, history.stack.length - 1 - history.index);
    if (undoBtn) {
      undoBtn.disabled = history.index <= 0;
      if (!undoBtn.dataset.baseLabel) {
        undoBtn.dataset.baseLabel = undoBtn.textContent.trim() || '戻る';
      }
      undoBtn.textContent = `${undoBtn.dataset.baseLabel} (${undoCount})`;
    }
    if (redoBtn) {
      redoBtn.disabled = history.index >= history.stack.length - 1;
      if (!redoBtn.dataset.baseLabel) {
        redoBtn.dataset.baseLabel = redoBtn.textContent.trim() || '進む';
      }
      redoBtn.textContent = `${redoBtn.dataset.baseLabel} (${redoCount})`;
    }
  };

  const pushHistory = (force = false) => {
    if (historyLocked) return;
    const snap = JSON.stringify(state);
    const current = history.stack[history.index];
    if (!force && current === snap) return;
    if (history.index < history.stack.length - 1) {
      history.stack = history.stack.slice(0, history.index + 1);
    }
    history.stack.push(snap);
    if (history.stack.length > HISTORY_LIMIT) {
      history.stack.shift();
    }
    history.index = history.stack.length - 1;
    updateHistoryButtons();
  };

  const scheduleHistoryPush = () => {
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => pushHistory(), 300);
  };

  const restoreHistory = (nextIndex) => {
    if (nextIndex < 0 || nextIndex >= history.stack.length) return;
    historyLocked = true;
    state = normalizeState(JSON.parse(history.stack[nextIndex]));
    history.index = nextIndex;
    historyLocked = false;
    renderAll();
    typesetAllMath();
    scheduleSave();
    updateHistoryButtons();
  };

  const undo = () => {
    if (history.index <= 0) return;
    restoreHistory(history.index - 1);
  };

  const redo = () => {
    if (history.index >= history.stack.length - 1) return;
    restoreHistory(history.index + 1);
  };

  const resetHistory = () => {
    history.stack = [];
    history.index = -1;
    pushHistory(true);
  };

  const createPage = (index = 1) => ({
    id: uid('page'),
    name: `ページ ${index}`,
    items: []
  });

  const createTextItem = (text, style, kind = 'text') => ({
    id: uid('item'),
    type: 'text',
    kind,
    text,
    x: 40,
    y: 60,
    w: 320,
    h: 140,
    rotation: 0,
    opacity: 1,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    bold: style.bold,
    underline: style.underline,
    italic: style.italic,
    vertical: !!style.vertical,
    textOrientation: style.textOrientation || 'mixed',
    textCombine: !!style.textCombine,
    textCombineDigits: normalizeCombineDigits(style.textCombineDigits),
    color: style.color,
    bgColor: style.bgColor,
    bgTransparent: !!style.bgTransparent,
    borderColor: style.borderColor,
    borderWidth: style.borderWidth,
    borderStyle: style.borderStyle || 'solid',
    textAlign: style.textAlign,
    lineHeight: style.lineHeight
  });

  const createRichTextItem = (html, style) => ({
    id: uid('item'),
    type: 'richtext',
    kind: 'richtext',
    richHtml: html,
    x: 40,
    y: 60,
    w: 360,
    h: 180,
    rotation: 0,
    opacity: 1,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    bold: style.bold,
    underline: style.underline,
    italic: style.italic,
    vertical: !!style.vertical,
    textOrientation: style.textOrientation || 'mixed',
    textCombine: !!style.textCombine,
    textCombineDigits: normalizeCombineDigits(style.textCombineDigits),
    color: style.color,
    bgColor: style.bgColor,
    bgTransparent: !!style.bgTransparent,
    borderColor: style.borderColor,
    borderWidth: style.borderWidth,
    borderStyle: style.borderStyle || 'solid',
    textAlign: style.textAlign,
    lineHeight: style.lineHeight
  });

  const createShapeItem = (shape) => ({
    id: uid('item'),
    type: 'shape',
    shape,
    x: 60,
    y: 80,
    w: 160,
    h: 120,
    rotation: 0,
    opacity: 1,
    color: '#222222',
    borderColor: '#222222',
    borderWidth: 2,
    bgColor: 'rgba(0,0,0,0.05)'
  });

  const createImageItem = (src) => ({
    id: uid('item'),
    type: 'image',
    src,
    x: 80,
    y: 100,
    w: 240,
    h: 180,
    rotation: 0,
    opacity: 1
  });

  const createSvgItem = (svg, width, height, kind = 'diagram') => ({
    id: uid('item'),
    type: 'svg',
    svg,
    svgKind: kind,
    x: 60,
    y: 80,
    w: width,
    h: height,
    rotation: 0,
    opacity: 1
  });

  const createMathItem = (latex, style = {}) => ({
    id: uid('item'),
    type: 'math',
    latex,
    mathSvg: '',
    mathColor: style.mathColor || '#1b1b1b',
    mathBold: !!style.mathBold,
    mathItalic: !!style.mathItalic,
    mathUnderline: !!style.mathUnderline,
    mathSize: typeof style.mathSize === 'number' ? style.mathSize : 24,
    x: 60,
    y: 80,
    w: 240,
    h: 100,
    rotation: 0,
    opacity: 1
  });

  const defaultState = () => ({
    project: { title: '', subject: '', grade: '', author: '' },
    pages: [createPage(1)],
    selectedPageId: null,
    selectedItemId: null,
    selectedItemIds: [],
    view: { mode: 'continuous', showGrid: true, zoom: 1, drawMode: false, drawTool: 'curve', snap: true, pageSize: 'A4-P', pageTurn: 'ltr', kokugoMode: false },
    support: { glossary: [], citations: [], checklist: [] }
  });

  let state = defaultState();

  const normalizeState = (input) => {
    const base = defaultState();
    if (!input || typeof input !== 'object') return base;
    base.project = { ...base.project, ...(input.project || {}) };
    base.view = { ...base.view, ...(input.view || {}) };
    if (base.view.kokugoMode) {
      base.view.pageTurn = 'rtl';
    }
    base.support = { ...base.support, ...(input.support || {}) };
    base.pages = Array.isArray(input.pages) && input.pages.length
      ? input.pages.map((page, index) => ({
          id: page.id || uid('page'),
          name: page.name || `ページ ${index + 1}`,
          items: Array.isArray(page.items) ? page.items.map(item => ({
            id: item.id || uid('item'),
            type: item.type || 'text',
            kind: item.kind || 'text',
            text: item.text || '',
            richHtml: item.richHtml || '',
            x: typeof item.x === 'number' ? item.x : 40,
            y: typeof item.y === 'number' ? item.y : 60,
            w: typeof item.w === 'number' ? item.w : 200,
            h: typeof item.h === 'number' ? item.h : 120,
            rotation: typeof item.rotation === 'number' ? item.rotation : 0,
            opacity: typeof item.opacity === 'number' ? item.opacity : 1,
            fontFamily: item.fontFamily || "'Noto Serif JP'",
            fontSize: typeof item.fontSize === 'number' ? item.fontSize : 18,
            bold: !!item.bold,
            underline: !!item.underline,
            italic: !!item.italic,
            vertical: !!item.vertical,
            textOrientation: item.textOrientation || 'mixed',
            textCombine: !!item.textCombine,
            textCombineDigits: normalizeCombineDigits(item.textCombineDigits),
            color: item.color || '#1b1b1b',
            bgColor: item.bgColor && String(item.bgColor).startsWith('#') ? item.bgColor : '#ffffff',
            bgTransparent: typeof item.bgTransparent === 'boolean' ? item.bgTransparent : isTransparent(item.bgColor),
            borderColor: item.borderColor || '#111111',
            borderWidth: typeof item.borderWidth === 'number' ? item.borderWidth : 0,
            borderStyle: item.borderStyle || 'solid',
            textAlign: item.textAlign || 'left',
            lineHeight: typeof item.lineHeight === 'number' ? item.lineHeight : 1.5,
            shape: item.shape || 'rect',
            src: item.src || '',
            latex: item.latex || '',
            mathSvg: '',
            mathColor: item.mathColor || '#1b1b1b',
            mathBold: !!item.mathBold,
            mathItalic: !!item.mathItalic,
            mathUnderline: !!item.mathUnderline,
            mathSize: typeof item.mathSize === 'number' ? item.mathSize : 24,
            svg: sanitizeSvgMarkup(item.svg || ''),
            svgKind: item.svgKind || (GRID_KINDS.has(item.gridKind) ? item.gridKind : 'diagram'),
            points: Array.isArray(item.points) ? item.points.map(pt => ({
              x: typeof pt.x === 'number' ? pt.x : 0,
              y: typeof pt.y === 'number' ? pt.y : 0
            })) : [],
            gridKind: GRID_KINDS.has(item.gridKind) ? item.gridKind : (GRID_KINDS.has(item.svgKind) ? item.svgKind : null),
            gridRows: Number.isFinite(parseInt(item.gridRows, 10)) ? parseInt(item.gridRows, 10) : 1,
            gridCols: Number.isFinite(parseInt(item.gridCols, 10)) ? parseInt(item.gridCols, 10) : 1,
            gridCell: typeof item.gridCell === 'number' ? item.gridCell : 28,
            gridGap: typeof item.gridGap === 'number' ? item.gridGap : 6,
            gridFill: item.gridFill || (item.svgKind === 'array' ? '#111111' : '#8ecae6'),
            gridStroke: item.gridStroke || '#1b1b1b',
            drawKind: item.drawKind || 'free',
            strokeColor: item.strokeColor || '#1b1b1b',
            strokeWidth: typeof item.strokeWidth === 'number' ? item.strokeWidth : 3,
            fillColor: item.fillColor || item.strokeColor || '#1b1b1b',
            fillOpacity: typeof item.fillOpacity === 'number'
              ? item.fillOpacity
              : (item.drawKind === 'bar' ? 0.25 : 1),
            fillEnabled: typeof item.fillEnabled === 'boolean'
              ? item.fillEnabled
              : (item.drawKind === 'bar')
          })) : []
        }))
      : base.pages;
    base.selectedPageId = input.selectedPageId || base.pages[0].id;
    const incomingIds = Array.isArray(input.selectedItemIds)
      ? input.selectedItemIds.filter(Boolean)
      : (input.selectedItemId ? [input.selectedItemId] : []);
    base.selectedItemIds = incomingIds;
    base.selectedItemId = incomingIds[incomingIds.length - 1] || null;
    return base;
  };

  const saveLocal = (options = {}) => {
    const { force = false, silentBackup = true } = options;
    if (!force && saveRetryAt && Date.now() < saveRetryAt) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveFailNotified = false;
      saveRetryAt = 0;
      return true;
    } catch (err) {
      console.warn('保存に失敗しました。', err);
      saveRetryAt = Date.now() + 3000;
      if (!saveFailNotified) {
        showToast('保存に失敗しました。容量超過の可能性があります。JSON書き出しをおすすめします。', 'danger');
        saveFailNotified = true;
        if (!silentBackup) {
          downloadBackup('backup');
          showToast('バックアップJSONを保存しました。', 'success');
        }
      }
      return false;
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveLocal({ silentBackup: true }), 300);
  };

  const loadLocal = (options = {}) => {
    const { silent = false } = options;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      state = normalizeState(JSON.parse(raw));
      if (!state.selectedPageId && state.pages.length) {
        state.selectedPageId = state.pages[0].id;
      }
      migrateGridItems();
      return true;
    } catch (err) {
      console.error('読み込みに失敗しました。', err);
      if (!silent) {
        showToast('読み込みに失敗しました。', 'danger');
      }
      return false;
    }
  };

  const getSelectedPage = () => state.pages.find(p => p.id === state.selectedPageId) || state.pages[0];
  const getSelectedItemIds = () => {
    if (Array.isArray(state.selectedItemIds) && state.selectedItemIds.length) {
      return state.selectedItemIds;
    }
    return state.selectedItemId ? [state.selectedItemId] : [];
  };

  const getSelectedItems = () => {
    const ids = new Set(getSelectedItemIds());
    const items = [];
    for (const page of state.pages) {
      for (const item of page.items) {
        if (ids.has(item.id)) items.push(item);
      }
    }
    return items;
  };

  const getSelectedItem = () => {
    const ids = getSelectedItemIds();
    const primaryId = ids[ids.length - 1] || null;
    if (!primaryId) return null;
    for (const page of state.pages) {
      const found = page.items.find(item => item.id === primaryId);
      if (found) return found;
    }
    return null;
  };

  const getSelectedItemsOnPage = () => {
    const page = getSelectedPage();
    if (!page) return [];
    const ids = new Set(getSelectedItemIds());
    return page.items.filter(item => ids.has(item.id));
  };

  const updateProjectFields = () => {
    $('#book-title').value = state.project.title;
    $('#book-subject').value = state.project.subject;
    $('#book-grade').value = state.project.grade;
    $('#book-author').value = state.project.author;
  };

  const updateFullscreenButton = () => {
    const btn = $('#toggle-fullscreen');
    if (!btn) return;
    btn.textContent = previewFullscreen ? '全画面を終了' : '全画面プレビュー';
  };

  const setPreviewFullscreen = (enabled) => {
    previewFullscreen = !!enabled;
    document.body.classList.toggle(FULLSCREEN_CLASS, previewFullscreen);
    updateFullscreenButton();
  };

  const togglePreviewFullscreen = () => {
    const next = !previewFullscreen;
    setPreviewFullscreen(next);
    if (next) {
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        const result = document.documentElement.requestFullscreen();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      }
    } else if (document.fullscreenElement && document.exitFullscreen) {
      const result = document.exitFullscreen();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    }
  };

  const updateView = () => {
    const container = $('#page-container');
    container.classList.toggle('spread', state.view.mode === 'spread');
    container.classList.toggle('draw-mode', !!state.view.drawMode);
    container.classList.toggle('kokugo', !!state.view.kokugoMode);
    container.style.setProperty('--zoom', state.view.zoom);
    $('#toggle-view').textContent = `見開き: ${state.view.mode === 'spread' ? 'ON' : 'OFF'}`;
    $('#toggle-grid').textContent = `グリッド: ${state.view.showGrid ? 'ON' : 'OFF'}`;
    const pageTurnBtn = $('#toggle-page-turn');
    if (pageTurnBtn) {
      if (state.view.kokugoMode) {
        state.view.pageTurn = 'rtl';
      }
      pageTurnBtn.disabled = !!state.view.kokugoMode;
      pageTurnBtn.textContent = state.view.kokugoMode
        ? 'ページ送り: 国語'
        : `ページ送り: ${state.view.pageTurn === 'rtl' ? '左' : '右'}`;
    }
    const kokugoBtn = $('#toggle-kokugo');
    if (kokugoBtn) {
      kokugoBtn.textContent = `国語モード: ${state.view.kokugoMode ? 'ON' : 'OFF'}`;
    }
    const snapBtn = $('#toggle-snap');
    if (snapBtn) {
      snapBtn.textContent = `スナップ: ${state.view.snap ? 'ON' : 'OFF'}`;
    }
    $('#zoom-range').value = state.view.zoom;
    const drawToggle = $('#draw-toggle');
    if (drawToggle) {
      drawToggle.textContent = `描画: ${state.view.drawMode ? 'ON' : 'OFF'}`;
    }
    $$('.draw-tool').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === state.view.drawTool);
    });
    updateFullscreenButton();
  };

  const PAGE_SIZES = {
    'A4-P': { w: 210, h: 297, unit: 'mm' },
    'A4-L': { w: 297, h: 210, unit: 'mm' },
    'A3-P': { w: 297, h: 420, unit: 'mm' },
    'A3-L': { w: 420, h: 297, unit: 'mm' },
    'A5-P': { w: 148, h: 210, unit: 'mm' },
    'A5-L': { w: 210, h: 148, unit: 'mm' },
    'B5-P': { w: 182, h: 257, unit: 'mm' },
    'B5-L': { w: 257, h: 182, unit: 'mm' },
    'Letter-P': { w: 8.5, h: 11, unit: 'in' },
    'Letter-L': { w: 11, h: 8.5, unit: 'in' },
    'Legal-P': { w: 8.5, h: 14, unit: 'in' },
    'Legal-L': { w: 14, h: 8.5, unit: 'in' },
    'Tabloid-P': { w: 11, h: 17, unit: 'in' },
    'Tabloid-L': { w: 17, h: 11, unit: 'in' }
  };

  const applyPageSize = (key) => {
    const size = PAGE_SIZES[key] || PAGE_SIZES['A4-P'];
    const w = `${size.w}${size.unit}`;
    const h = `${size.h}${size.unit}`;
    document.documentElement.style.setProperty('--page-w', w);
    document.documentElement.style.setProperty('--page-h', h);
  };

  const renderPageSelect = () => {
    const select = $('#page-select');
    select.innerHTML = '';
    state.pages.forEach((page, index) => {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = `ページ ${index + 1}`;
      select.appendChild(option);
    });
    select.value = state.selectedPageId || (state.pages[0] && state.pages[0].id) || '';
  };

  const escapeHtml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const htmlToPlainText = (html) => {
    if (!html) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || '').trim();
  };

  const isSafeColor = (value) => {
    const v = String(value || '').trim();
    if (!v) return false;
    if (/^#[0-9a-f]{3}$/i.test(v)) return true;
    if (/^#[0-9a-f]{6}$/i.test(v)) return true;
    if (/^rgb(a)?\([0-9\s.,%]+\)$/i.test(v)) return true;
    if (/^hsl(a)?\([0-9\s.,%]+\)$/i.test(v)) return true;
    if (/^[a-z]+$/i.test(v)) return true;
    return false;
  };

  const normalizeFontSize = (value) => {
    const v = String(value || '').trim();
    if (!v) return '';
    const match = v.match(/^([0-9.]+)(px|pt|em|rem|%)$/i);
    if (!match) return '';
    const num = parseFloat(match[1]);
    if (!Number.isFinite(num) || num <= 0) return '';
    const unit = match[2].toLowerCase();
    if (unit === 'pt') {
      const px = Math.round(num * 1.333 * 10) / 10;
      return `${px}px`;
    }
    return `${num}${unit}`;
  };

  const sanitizeStyleText = (styleText) => {
    if (!styleText) return '';
    const allowed = [];
    styleText.split(';').forEach((raw) => {
      const [propRaw, ...rest] = raw.split(':');
      if (!propRaw || !rest.length) return;
      const prop = propRaw.trim().toLowerCase();
      const value = rest.join(':').trim();
      if (!value) return;
      if (prop === 'color' || prop === 'background-color') {
        if (isSafeColor(value)) allowed.push(`${prop}: ${value}`);
        return;
      }
      if (prop === 'font-size') {
        const size = normalizeFontSize(value);
        if (size) allowed.push(`${prop}: ${size}`);
        return;
      }
      if (prop === 'font-weight') {
        if (/^(normal|bold|[1-9]00)$/i.test(value)) {
          allowed.push(`${prop}: ${value}`);
        }
        return;
      }
      if (prop === 'font-style') {
        if (/^(normal|italic|oblique)$/i.test(value)) {
          allowed.push(`${prop}: ${value}`);
        }
        return;
      }
      if (prop === 'text-decoration' || prop === 'text-decoration-line') {
        const tokens = value.split(/\s+/).filter(Boolean);
        const allowedTokens = tokens.filter(tok => ['underline','line-through','overline','none'].includes(tok.toLowerCase()));
        if (allowedTokens.length) {
          allowed.push(`text-decoration: ${allowedTokens.join(' ')}`);
        }
      }
    });
    return allowed.join('; ');
  };

  const sanitizeRichHtml = (html) => {
    if (!html) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstChild;
    const container = document.createElement('div');
    const allowedTags = new Set(['SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'SUP', 'SUB']);

    const sanitizeNode = (node, parent) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(node.textContent));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();
      if (!allowedTags.has(tag)) {
        node.childNodes.forEach(child => sanitizeNode(child, parent));
        return;
      }
      const el = document.createElement(tag.toLowerCase());
      if (tag !== 'BR') {
        const style = sanitizeStyleText(node.getAttribute('style'));
        if (style) el.setAttribute('style', style);
        node.childNodes.forEach(child => sanitizeNode(child, el));
      }
      parent.appendChild(el);
    };

    if (root) {
      root.childNodes.forEach(child => sanitizeNode(child, container));
    }
    return container.innerHTML;
  };

  const sanitizeSvgMarkup = (svgText) => {
    if (!svgText) return '';
    const raw = String(svgText).trim();
    if (!raw) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return '';
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') return '';

    const allowedTags = new Set([
      'svg','g','path','line','rect','circle','ellipse','polyline','polygon','text','tspan','image','defs','mask'
    ]);
    const allowedAttrs = new Set([
      'viewbox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','fill','stroke',
      'stroke-width','stroke-linecap','stroke-linejoin','font-size','text-anchor','transform','opacity','points',
      'xmlns','id','mask','maskunits','maskcontentunits','mask-type','preserveaspectratio','href'
    ]);

    const isSafeHref = (value) => {
      const v = String(value || '').trim();
      if (!v) return false;
      if (/^data:image\/(png|jpe?g|webp|gif);/i.test(v)) return true;
      if (v.startsWith('assets/sprites/')) return true;
      if (v.startsWith('./assets/sprites/')) return true;
      return false;
    };

    const cleanDoc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null);
    const cleanRoot = cleanDoc.documentElement;
    cleanRoot.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const isSafeAttr = (name, value) => {
      const key = String(name || '').toLowerCase();
      const val = String(value || '');
      if (!key) return false;
      if (key.startsWith('on')) return false;
      if (key === 'href' || key === 'xlink:href') return isSafeHref(val);
      if (key === 'mask') {
        return /^url\(#[-_a-z0-9]+\)$/i.test(val);
      }
      if (key === 'id') {
        return /^[-_a-z0-9]+$/i.test(val);
      }
      if (!allowedAttrs.has(key)) return false;
      if (/url\s*\(/i.test(val)) return false;
      if (/javascript:/i.test(val)) return false;
      return true;
    };

    const copyAttrs = (src, dest) => {
      if (!src?.attributes) return;
      Array.from(src.attributes).forEach((attr) => {
        if (isSafeAttr(attr.name, attr.value)) {
          dest.setAttribute(attr.name, attr.value);
        }
      });
    };

    const sanitizeNode = (node, parent) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        parent.appendChild(cleanDoc.createTextNode(node.textContent || ''));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (!allowedTags.has(tag)) {
        node.childNodes.forEach(child => sanitizeNode(child, parent));
        return;
      }
      const el = cleanDoc.createElementNS('http://www.w3.org/2000/svg', tag);
      copyAttrs(node, el);
      node.childNodes.forEach(child => sanitizeNode(child, el));
      parent.appendChild(el);
    };

    copyAttrs(root, cleanRoot);
    root.childNodes.forEach(child => sanitizeNode(child, cleanRoot));
    return cleanRoot.outerHTML;
  };

  const isRichTextEmpty = (html) => {
    if (!html) return true;
    const stripped = html
      .replace(/<br\s*\/?>/gi, '')
      .replace(/&nbsp;|&#160;/gi, '')
      .replace(/\s+/g, '');
    return stripped.length === 0;
  };

  const applyTextStyles = (item, el) => {
    el.style.fontFamily = item.fontFamily;
    el.style.fontSize = `${item.fontSize}px`;
    el.style.fontWeight = item.bold ? '700' : '400';
    el.style.textDecoration = item.underline ? 'underline' : 'none';
    el.style.fontStyle = item.italic ? 'italic' : 'normal';
    el.style.writingMode = item.vertical ? 'vertical-rl' : 'horizontal-tb';
    el.style.textOrientation = item.vertical ? (item.textOrientation || 'mixed') : 'mixed';
    const combineDigits = normalizeCombineDigits(item.textCombineDigits);
    el.style.textCombineUpright = item.vertical && item.textCombine ? `digits ${combineDigits}` : 'none';
    el.style.color = item.color;
    el.style.background = item.bgTransparent ? 'transparent' : (item.bgColor || 'transparent');
    const borderStyle = item.borderStyle || 'solid';
    el.style.border = item.borderWidth > 0 ? `${item.borderWidth}px ${borderStyle} ${item.borderColor}` : 'none';
    el.style.textAlign = item.textAlign;
    el.style.lineHeight = item.lineHeight;
  };

  const buildDrawPath = (points) => {
    if (!points || !points.length) return '';
    const [first, ...rest] = points;
    let d = `M ${first.x} ${first.y}`;
    for (const pt of rest) {
      d += ` L ${pt.x} ${pt.y}`;
    }
    if (points.length === 1) {
      d += ` L ${first.x} ${first.y}`;
    }
    return d;
  };

  const renderPages = () => {
    const container = $('#page-container');
    container.innerHTML = '';
    const selectedIds = new Set(getSelectedItemIds());

    state.pages.forEach((page, index) => {
      const pageEl = document.createElement('div');
      pageEl.className = `page ${state.selectedPageId === page.id ? 'active' : ''} ${state.view.showGrid ? 'show-grid' : ''}`;
      pageEl.dataset.pageId = page.id;

      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = `ページ ${index + 1}`;

      const grid = document.createElement('div');
      grid.className = 'grid';

      pageEl.appendChild(label);
      pageEl.appendChild(grid);

      page.items.forEach((item) => {
        const itemEl = document.createElement('div');
        itemEl.className = `item ${item.type} ${selectedIds.has(item.id) ? 'selected' : ''}`;
        itemEl.dataset.itemId = item.id;
        itemEl.style.left = `${item.x}px`;
        itemEl.style.top = `${item.y}px`;
        itemEl.style.width = `${item.w}px`;
        itemEl.style.height = `${item.h}px`;
        itemEl.style.transform = `rotate(${item.rotation}deg)`;
        itemEl.style.opacity = item.opacity;

        if (item.type === 'text') {
          itemEl.classList.add('text');
          const content = document.createElement('div');
          content.className = 'item-content';
          content.innerHTML = escapeHtml(item.text).replace(/\n/g, '<br>');
          applyTextStyles(item, content);
          itemEl.appendChild(content);
          itemEl.addEventListener('dblclick', () => enableInlineEdit(item, content));
        }

        if (item.type === 'richtext') {
          itemEl.classList.add('text', 'richtext');
          const content = document.createElement('div');
          content.className = 'item-content richtext-content';
          content.innerHTML = sanitizeRichHtml(item.richHtml || '');
          applyTextStyles(item, content);
          itemEl.appendChild(content);
          itemEl.addEventListener('dblclick', () => enableInlineRichEdit(item, content));
        }

        if (item.type === 'shape') {
          itemEl.style.background = item.bgColor;
          itemEl.style.border = `${item.borderWidth}px solid ${item.borderColor}`;
          if (item.shape === 'circle') {
            itemEl.style.borderRadius = '50%';
          } else {
            itemEl.style.borderRadius = '8px';
          }
        }

        if (item.type === 'draw') {
          itemEl.classList.add('draw');
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', `0 0 ${Math.max(1, item.w)} ${Math.max(1, item.h)}`);
          svg.setAttribute('width', '100%');
          svg.setAttribute('height', '100%');
          svg.setAttribute('preserveAspectRatio', 'none');
          const stroke = item.strokeColor || '#1b1b1b';
          const strokeWidth = item.strokeWidth || 3;
          const kind = item.drawKind || 'free';
          const fillEnabled = typeof item.fillEnabled === 'boolean' ? item.fillEnabled : (kind === 'bar');
          const fillOpacity = clamp(
            typeof item.fillOpacity === 'number'
              ? item.fillOpacity
              : (kind === 'bar' ? 0.25 : 1),
            0,
            1
          );
          const fillColor = item.fillColor || stroke;
          const fillValue = fillEnabled
            ? (fillOpacity >= 1 ? fillColor : hexToRgba(fillColor, fillOpacity))
            : 'none';

          if (kind === 'line' || kind === 'segment') {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            const p0 = item.points && item.points[0] ? item.points[0] : { x: 0, y: 0 };
            const p1 = item.points && item.points[1] ? item.points[1] : { x: item.w, y: item.h };
            line.setAttribute('x1', p0.x);
            line.setAttribute('y1', p0.y);
            line.setAttribute('x2', p1.x);
            line.setAttribute('y2', p1.y);
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', stroke);
            line.setAttribute('stroke-width', strokeWidth);
            line.setAttribute('stroke-linecap', 'round');
            svg.appendChild(line);
            if (kind === 'segment') {
              const capRadius = Math.max(2, strokeWidth * 1.2);
              const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
              c1.setAttribute('cx', p0.x);
              c1.setAttribute('cy', p0.y);
              c1.setAttribute('r', capRadius);
              c1.setAttribute('fill', stroke);
              svg.appendChild(c1);
              const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
              c2.setAttribute('cx', p1.x);
              c2.setAttribute('cy', p1.y);
              c2.setAttribute('r', capRadius);
              c2.setAttribute('fill', stroke);
              svg.appendChild(c2);
            }
          } else if (kind === 'arc') {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const p0 = item.points && item.points[0] ? item.points[0] : { x: 0, y: 0 };
            const p1 = item.points && item.points[1] ? item.points[1] : { x: item.w, y: item.h };
            const pc = item.points && item.points[2]
              ? item.points[2]
              : { x: (p0.x + p1.x) / 2, y: Math.min(p0.y, p1.y) - 20 };
            path.setAttribute('d', `M ${p0.x} ${p0.y} Q ${pc.x} ${pc.y} ${p1.x} ${p1.y}`);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', stroke);
            path.setAttribute('stroke-width', strokeWidth);
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(path);
          } else if (kind === 'rect') {
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', 0);
            rect.setAttribute('y', 0);
            rect.setAttribute('width', Math.max(1, item.w));
            rect.setAttribute('height', Math.max(1, item.h));
            rect.setAttribute('fill', fillValue);
            rect.setAttribute('stroke', stroke);
            rect.setAttribute('stroke-width', strokeWidth);
            svg.appendChild(rect);
          } else if (kind === 'bar') {
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', 0);
            rect.setAttribute('y', 0);
            rect.setAttribute('width', Math.max(1, item.w));
            rect.setAttribute('height', Math.max(1, item.h));
            rect.setAttribute('fill', fillValue);
            rect.setAttribute('stroke', stroke);
            rect.setAttribute('stroke-width', strokeWidth);
            svg.appendChild(rect);
          } else if (kind === 'ellipse') {
            const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
            ellipse.setAttribute('cx', Math.max(1, item.w) / 2);
            ellipse.setAttribute('cy', Math.max(1, item.h) / 2);
            ellipse.setAttribute('rx', Math.max(1, item.w) / 2);
            ellipse.setAttribute('ry', Math.max(1, item.h) / 2);
            ellipse.setAttribute('fill', fillValue);
            ellipse.setAttribute('stroke', stroke);
            ellipse.setAttribute('stroke-width', strokeWidth);
            svg.appendChild(ellipse);
          } else {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', buildDrawPath(item.points));
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', stroke);
            path.setAttribute('stroke-width', strokeWidth);
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(path);
          }

          itemEl.appendChild(svg);
        }

        if (item.type === 'image') {
          const img = document.createElement('img');
          img.src = item.src;
          itemEl.appendChild(img);
        }

        if (item.type === 'math') {
          const content = document.createElement('div');
          content.className = 'math-content';
          content.style.color = item.mathColor || '#1b1b1b';
          const size = item.mathSize || 24;
          const scale = size / 24;
          if (scale !== 1) {
            content.style.transform = `scale(${scale})`;
            content.style.transformOrigin = 'center';
          }
          if (item.mathSvg) {
            content.innerHTML = item.mathSvg;
          } else if (item.latex) {
            content.textContent = item.latex;
            content.classList.add('muted');
          } else {
            content.textContent = '数式';
            content.classList.add('muted');
          }
          itemEl.appendChild(content);
        }

        if (item.type === 'svg') {
          const content = document.createElement('div');
          content.className = 'svg-content';
          content.innerHTML = item.svg || '';
          itemEl.appendChild(content);
        }

        if (selectedIds.has(item.id) && item.id === state.selectedItemId) {
          ['nw','n','ne','e','se','s','sw','w'].forEach(dir => {
            const handle = document.createElement('div');
            handle.className = `resize-handle ${dir}`;
            handle.dataset.dir = dir;
            handle.addEventListener('pointerdown', (e) => startResize(e, item, pageEl, dir));
            itemEl.appendChild(handle);
          });
          const rotateHandle = document.createElement('div');
          rotateHandle.className = 'rotate-handle';
          rotateHandle.addEventListener('pointerdown', (e) => startRotate(e, item, pageEl));
          itemEl.appendChild(rotateHandle);
        }

        itemEl.addEventListener('pointerdown', (e) => startDrag(e, item, pageEl));
        itemEl.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (state.view.drawMode) return;
          const ids = getSelectedItemIds();
          if (!ids.includes(item.id)) {
            selectItem(item.id);
          }
          showContextMenu(e.clientX, e.clientY);
        });
        pageEl.appendChild(itemEl);
      });

      pageEl.addEventListener('pointerdown', (e) => {
        state.selectedPageId = page.id;
        if (state.view.drawMode) {
          startDraw(e, pageEl);
          renderPageSelect();
          renderLayers();
          return;
        }
        if (e.target === pageEl || e.target === grid) {
          selectItem(null);
        }
        renderPageSelect();
        renderLayers();
      });

      container.appendChild(pageEl);
    });
  };

  const renderLayers = () => {
    const list = $('#layer-list');
    list.innerHTML = '';
    const page = getSelectedPage();
    if (!page) return;
    const selectedIds = new Set(getSelectedItemIds());

    [...page.items].reverse().forEach((item, reverseIndex) => {
      const index = page.items.length - 1 - reverseIndex;
      const row = document.createElement('div');
      row.className = `layer-item ${selectedIds.has(item.id) ? 'active' : ''}`;
      const label = document.createElement('div');
      const title = item.type === 'text'
        ? (item.text.slice(0, 14) || 'テキスト')
        : (item.type === 'richtext'
          ? (htmlToPlainText(item.richHtml).slice(0, 14) || 'リッチテキスト')
          : (item.type === 'image'
            ? '画像'
            : (item.type === 'math'
              ? '数式'
              : (item.type === 'svg'
                ? '図'
                : (item.type === 'draw'
                  ? '描画'
                  : (item.shape === 'circle' ? '円形' : '長方形'))))));
      label.textContent = title;
      const controls = document.createElement('div');
      controls.className = 'layer-controls';
      const up = document.createElement('button');
      up.textContent = '↑';
      up.addEventListener('click', (e) => {
        e.stopPropagation();
        moveLayer(index, 1);
      });
      const down = document.createElement('button');
      down.textContent = '↓';
      down.addEventListener('click', (e) => {
        e.stopPropagation();
        moveLayer(index, -1);
      });
      controls.appendChild(up);
      controls.appendChild(down);
      row.appendChild(label);
      row.appendChild(controls);
      row.addEventListener('click', (e) => {
        const multi = e.shiftKey || e.ctrlKey || e.metaKey;
        if (multi) {
          selectItem(item.id, { toggle: true });
        } else {
          const ids = getSelectedItemIds();
          if (ids.includes(item.id) && ids.length > 1) {
            selectItem(item.id, { preserve: true });
          } else {
            selectItem(item.id);
          }
        }
      });
      list.appendChild(row);
    });
  };

  const renderInspector = () => {
    const item = getSelectedItem();
    const inspector = $('#inspector');
    const noSel = $('#no-selection');
    if (!item) {
      inspector.style.display = 'none';
      noSel.style.display = 'block';
      return;
    }
    inspector.style.display = 'flex';
    inspector.style.flexDirection = 'column';
    inspector.style.gap = '10px';
    noSel.style.display = 'none';

    $('#ins-x').value = Math.round(item.x);
    $('#ins-y').value = Math.round(item.y);
    $('#ins-w').value = Math.round(item.w);
    $('#ins-h').value = Math.round(item.h);
    $('#ins-rot').value = Math.round(item.rotation);
    $('#ins-op').value = item.opacity;

    const textTools = $('#inspector-text-tools');
    const isTextLike = item.type === 'text' || item.type === 'richtext';
    if (isTextLike) {
      textTools.style.display = 'block';
      const insText = $('#ins-text');
      const richNote = $('#ins-richtext-note');
      if (item.type === 'text') {
        insText.disabled = false;
        insText.value = item.text;
        if (richNote) richNote.style.display = 'none';
      } else {
        insText.disabled = true;
        insText.value = 'リッチテキストはプレビューで編集してください。';
        if (richNote) richNote.style.display = 'block';
      }
      $('#ins-font').value = item.fontFamily;
      $('#ins-font-size').value = item.fontSize;
      $('#ins-bold').checked = item.bold;
      $('#ins-underline').checked = item.underline;
      $('#ins-italic').checked = item.italic;
      $('#ins-vertical').checked = !!item.vertical;
      $('#ins-orientation').value = item.textOrientation || 'mixed';
      $('#ins-combine').checked = !!item.textCombine;
      const combineDigits = normalizeCombineDigits(item.textCombineDigits);
      const insCombineDigits = $('#ins-combine-digits');
      if (insCombineDigits) {
        insCombineDigits.value = String(combineDigits);
        insCombineDigits.disabled = !item.textCombine || !item.vertical;
      }
      $('#ins-color').value = item.color || '#1b1b1b';
      $('#ins-bg').value = item.bgColor || '#ffffff';
      $('#ins-bg-transparent').checked = !!item.bgTransparent;
      $('#ins-border-color').value = item.borderColor || '#111111';
      $('#ins-border-width').value = item.borderWidth || 0;
      $('#ins-align').value = item.textAlign || 'left';
      $('#ins-line').value = item.lineHeight || 1.5;
    } else {
      textTools.style.display = 'none';
    }

    const drawTools = $('#inspector-draw-tools');
    if (item.type === 'draw') {
      drawTools.style.display = 'block';
      $('#ins-draw-stroke').value = item.strokeColor || '#1b1b1b';
      $('#ins-draw-width').value = item.strokeWidth || 3;
      $('#ins-draw-fill-color').value = item.fillColor || item.strokeColor || '#1b1b1b';
      $('#ins-draw-fill-opacity').value = typeof item.fillOpacity === 'number' ? item.fillOpacity : 0.2;
      $('#ins-draw-fill-enabled').checked = typeof item.fillEnabled === 'boolean' ? item.fillEnabled : (item.drawKind === 'bar');
      updateColorReadout($('#ins-draw-stroke-swatch'), $('#ins-draw-stroke-code'), $('#ins-draw-stroke').value);
      updateColorReadout($('#ins-draw-fill-swatch'), $('#ins-draw-fill-code'), $('#ins-draw-fill-color').value);
    } else {
      drawTools.style.display = 'none';
    }

    const mathTools = $('#inspector-math-tools');
    if (item.type === 'math') {
      mathTools.style.display = 'block';
      $('#ins-latex').value = item.latex || '';
      $('#ins-math-color').value = item.mathColor || '#1b1b1b';
      $('#ins-math-size').value = item.mathSize || 24;
      $('#ins-math-bold').checked = !!item.mathBold;
      $('#ins-math-underline').checked = !!item.mathUnderline;
      $('#ins-math-italic').checked = !!item.mathItalic;
    } else {
      mathTools.style.display = 'none';
    }

    const gridTools = $('#inspector-grid-tools');
    if (item.type === 'svg' && GRID_KINDS.has(item.svgKind)) {
      gridTools.style.display = 'block';
      const meta = normalizeGridMeta(item);
      $('#ins-grid-fill').value = meta.fill;
      $('#ins-grid-stroke').value = meta.stroke;
      $('#ins-grid-cell').value = meta.cell;
      const gapInput = $('#ins-grid-gap');
      gapInput.value = meta.gap;
      gapInput.disabled = item.svgKind === 'grid';
    } else if (gridTools) {
      gridTools.style.display = 'none';
    }
  };

  const renderSupport = () => {
    const glossary = $('#glossary-list');
    glossary.innerHTML = '';
    state.support.glossary.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div><strong>${escapeHtml(item.term)}</strong><br><span class="muted">${escapeHtml(item.def)}</span></div>`;
      const del = document.createElement('button');
      del.textContent = '削除';
      del.addEventListener('click', () => {
        state.support.glossary.splice(index, 1);
        renderSupport();
        scheduleSave();
        pushHistory();
      });
      row.appendChild(del);
      glossary.appendChild(row);
    });

    const citations = $('#citation-list');
    citations.innerHTML = '';
    state.support.citations.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div>${escapeHtml(item)}</div>`;
      const del = document.createElement('button');
      del.textContent = '削除';
      del.addEventListener('click', () => {
        state.support.citations.splice(index, 1);
        renderSupport();
        scheduleSave();
        pushHistory();
      });
      row.appendChild(del);
      citations.appendChild(row);
    });

    const checks = $('#check-list');
    checks.innerHTML = '';
    state.support.checklist.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      const label = document.createElement('label');
      label.className = 'inline-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.done;
      checkbox.addEventListener('change', () => {
        item.done = checkbox.checked;
        scheduleSave();
        scheduleHistoryPush();
      });
      const span = document.createElement('span');
      span.textContent = item.text;
      label.appendChild(checkbox);
      label.appendChild(span);
      const del = document.createElement('button');
      del.textContent = '削除';
      del.addEventListener('click', () => {
        state.support.checklist.splice(index, 1);
        renderSupport();
        scheduleSave();
        pushHistory();
      });
      row.appendChild(label);
      row.appendChild(del);
      checks.appendChild(row);
    });
  };

  const renderAll = () => {
    updateProjectFields();
    updateView();
    applyPageSize(state.view.pageSize);
    renderPageSelect();
    renderPages();
    renderLayers();
    renderInspector();
    renderSupport();
  };

  const getNextPageIndex = (currentIndex, direction) => {
    const delta = direction === 'next'
      ? (state.view.pageTurn === 'rtl' ? -1 : 1)
      : (state.view.pageTurn === 'rtl' ? 1 : -1);
    return currentIndex + delta;
  };

  const setSelectedItemIds = (ids) => {
    const next = Array.isArray(ids) ? ids.filter(Boolean) : [];
    state.selectedItemIds = next;
    state.selectedItemId = next[next.length - 1] || null;
    renderPages();
    renderLayers();
    renderInspector();
  };

  const selectItem = (id, options = {}) => {
    const { toggle = false, preserve = false } = options;
    if (!id) {
      setSelectedItemIds([]);
      return;
    }
    const current = getSelectedItemIds();
    let next = [...current];
    if (toggle) {
      if (next.includes(id)) {
        next = next.filter(x => x !== id);
      } else {
        next.push(id);
      }
    } else if (preserve) {
      next = next.filter(x => x !== id);
      next.push(id);
    } else {
      next = [id];
    }
    setSelectedItemIds(next);
  };

  const addPage = () => {
    const newPage = createPage(state.pages.length + 1);
    state.pages.push(newPage);
    state.selectedPageId = newPage.id;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const deletePage = () => {
    if (state.pages.length <= 1) {
      showToast('最低1ページは必要です。', 'danger');
      return;
    }
    if (!confirm('このページを削除しますか？この操作は元に戻せません。')) {
      return;
    }
    const idx = state.pages.findIndex(p => p.id === state.selectedPageId);
    if (idx === -1) return;
    state.pages.splice(idx, 1);
    state.selectedPageId = state.pages[Math.max(0, idx - 1)].id;
    state.selectedItemIds = [];
    state.selectedItemId = null;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const getInsertionStyle = () => ({
    fontFamily: $('#font-family').value,
    fontSize: parseInt($('#font-size').value, 10) || 18,
    bold: $('#font-bold').checked,
    underline: $('#font-underline').checked,
    italic: $('#font-italic').checked,
    vertical: $('#font-vertical')?.checked ?? false,
    textOrientation: $('#font-orientation')?.value || 'mixed',
    textCombine: $('#font-combine')?.checked ?? false,
    textCombineDigits: normalizeCombineDigits($('#font-combine-digits')?.value),
    color: $('#font-color').value,
    bgColor: $('#bg-color').value,
    bgTransparent: $('#bg-transparent')?.checked ?? true,
    borderColor: $('#border-color').value,
    borderWidth: parseInt($('#border-width').value, 10) || 0,
    borderStyle: 'solid',
    textAlign: $('#text-align').value,
    lineHeight: parseFloat($('#line-height').value) || 1.5
  });

  const getMathStyle = () => ({
    mathColor: $('#math-color') ? $('#math-color').value : '#1b1b1b',
    mathBold: $('#math-bold') ? $('#math-bold').checked : false,
    mathItalic: $('#math-italic') ? $('#math-italic').checked : false,
    mathUnderline: $('#math-underline') ? $('#math-underline').checked : false,
    mathSize: parseInt($('#math-size')?.value, 10) || 24
  });

  const getDrawStyle = () => ({
    strokeColor: $('#draw-color') ? $('#draw-color').value : '#1b1b1b',
    strokeWidth: parseFloat($('#draw-width')?.value) || 3,
    fillColor: $('#draw-fill-color') ? $('#draw-fill-color').value : '#1b1b1b',
    fillOpacity: clamp(parseFloat($('#draw-fill-opacity')?.value) || 0, 0, 1),
    fillEnabled: $('#draw-fill-enabled') ? $('#draw-fill-enabled').checked : false
  });

  const getEmojiTarget = () => {
    const main = $('#main-text');
    const point = $('#point-text');
    if (!main || !point) return null;
    if (document.activeElement === point) return point;
    if (document.activeElement === main) return main;
    return main;
  };

  const insertEmoji = (emojiChar) => {
    if (!emojiChar) return;
    const target = getEmojiTarget();
    if (!target) return;
    const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
    const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.value.length;
    if (typeof target.setRangeText === 'function') {
      target.setRangeText(emojiChar, start, end, 'end');
    } else {
      target.value = `${target.value}${emojiChar}`;
    }
    target.focus();
  };

  const insertTemplate = (inputEl, template) => {
    if (!inputEl) return;
    const start = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : inputEl.value.length;
    const end = typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : inputEl.value.length;
    if (typeof inputEl.setRangeText === 'function') {
      inputEl.setRangeText(template, start, end, 'end');
      const braceIndex = template.indexOf('{');
      if (braceIndex !== -1) {
        const pos = start + braceIndex + 1;
        inputEl.setSelectionRange(pos, pos);
      }
    } else {
      inputEl.value = `${inputEl.value}${template}`;
    }
    inputEl.focus();
  };

  const normalizeRichTextInput = (inputEl) => {
    if (!inputEl) return;
    const text = inputEl.innerText.replace(/\u200B/g, '').trim();
    if (!text) {
      inputEl.innerHTML = '';
    }
  };

  const updateColorReadout = (swatchEl, codeEl, color) => {
    if (swatchEl && color) swatchEl.style.background = color;
    if (codeEl && color) codeEl.textContent = color;
  };

  const mathTimers = new Map();
  const ensureMathJaxReady = () => {
    const mj = window.MathJax;
    if (!mj || !mj.startup || !mj.tex2svgPromise) {
      return Promise.reject(new Error('MathJax not available'));
    }
    return mj.startup.promise;
  };

  const buildMathLatex = (item) => {
    let latex = (item.latex || '').trim();
    if (!latex) return '';
    if (item.mathBold) latex = `\\mathbf{${latex}}`;
    if (item.mathItalic) latex = `\\mathit{${latex}}`;
    if (item.mathUnderline) latex = `\\underline{${latex}}`;
    return latex;
  };

  const typesetMathItem = async (item) => {
    if (!item || item.type !== 'math') return;
    const latex = buildMathLatex(item);
    if (!latex) {
      item.mathSvg = '';
      scheduleRender({ pages: true });
      scheduleSave();
      return;
    }
    try {
      await ensureMathJaxReady();
      const mj = window.MathJax;
      const node = await mj.tex2svgPromise(latex, { display: true });
      const svg = node.querySelector('svg');
      item.mathSvg = svg ? svg.outerHTML : '';
      scheduleRender({ pages: true });
      scheduleSave();
    } catch (err) {
      console.warn('数式の生成に失敗しました。', err);
      showToast('数式の生成に失敗しました。', 'danger');
    }
  };

  const scheduleMathTypeset = (item) => {
    if (!item || item.type !== 'math') return;
    const id = item.id;
    if (mathTimers.has(id)) {
      clearTimeout(mathTimers.get(id));
    }
    const timer = setTimeout(() => {
      mathTimers.delete(id);
      typesetMathItem(item);
    }, 350);
    mathTimers.set(id, timer);
  };

  const typesetAllMath = (force = false) => {
    state.pages.forEach(page => {
      page.items.forEach(item => {
        if (item.type !== 'math') return;
        if (!force && item.mathSvg) return;
        typesetMathItem(item);
      });
    });
  };

  const TEXT_FIELDS = new Set([
    'text','fontFamily','fontSize','bold','underline','italic','vertical','textOrientation','textCombine','textCombineDigits','color',
    'bgColor','bgTransparent','borderColor','borderWidth','textAlign','lineHeight'
  ]);
  const MATH_FIELDS = new Set(['latex','mathColor','mathBold','mathItalic','mathUnderline','mathSize']);
  const DRAW_FIELDS = new Set([
    'strokeColor','strokeWidth','fillColor','fillOpacity','fillEnabled'
  ]);
  const NUM_FIELDS = new Set([
    'x','y','w','h','rotation','opacity','fontSize','borderWidth','lineHeight','strokeWidth','fillOpacity','mathSize','textCombineDigits'
  ]);
  const CLAMP_0_1_FIELDS = new Set(['opacity','fillOpacity']);
  const addTextItem = (kind) => {
    const page = getSelectedPage();
    if (!page) return;
    const style = getInsertionStyle();
    let text = kind === 'point' ? $('#point-text').value : $('#main-text').value;
    if (!text.trim()) text = kind === 'point' ? 'ポイント' : '本文';
    if (kind === 'point') {
      style.bgColor = style.bgColor === '#ffffff' ? '#fff5cc' : style.bgColor;
      style.borderColor = style.borderWidth === 0 ? '#f4c542' : style.borderColor;
      style.borderWidth = style.borderWidth === 0 ? 2 : style.borderWidth;
      text = `ポイント: ${text}`;
    }
    const item = createTextItem(text, style, kind);
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const addRichTextItemFromInput = () => {
    const page = getSelectedPage();
    if (!page) return;
    const inputEl = $('#richtext-input');
    if (!inputEl) return;
    const rawHtml = inputEl.innerHTML || '';
    const safeHtml = sanitizeRichHtml(rawHtml);
    if (isRichTextEmpty(safeHtml)) {
      showToast('リッチテキストが空です。', 'info');
      return;
    }
    const style = getInsertionStyle();
    const item = createRichTextItem(safeHtml, style);
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
    inputEl.innerHTML = '';
  };

  const addShapeItem = (shape) => {
    const page = getSelectedPage();
    if (!page) return;
    const item = createShapeItem(shape);
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const addImageItem = (src, dropPosition) => {
    const page = dropPosition?.page || getSelectedPage();
    if (!page) return;
    const item = createImageItem(src);
    if (dropPosition) {
      item.x = dropPosition.x;
      item.y = dropPosition.y;
    }
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const addMathItem = (latex) => {
    const page = getSelectedPage();
    if (!page) return;
    const text = (latex || '').trim() || '\\frac{a}{b}';
    const style = getMathStyle();
    const item = createMathItem(text, style);
    item.w = Math.max(160, (style.mathSize || 24) * 6);
    item.h = Math.max(60, (style.mathSize || 24) * 2.6);
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
    typesetMathItem(item);
  };

  const TEMPLATE_PRESETS = {
    goal: {
      text: 'めあて\nここに学習のめあてを書く',
      w: 380,
      h: 140,
      style: {
        bgColor: '#fff5cc',
        bgTransparent: false,
        borderColor: '#f2b94b',
        borderWidth: 2,
        borderStyle: 'dashed',
        fontSize: 20,
        bold: true,
        textAlign: 'left',
        lineHeight: 1.4
      }
    },
    summary: {
      text: 'まとめ\nここにポイントを整理する',
      w: 380,
      h: 140,
      style: {
        bgColor: '#e8f4ff',
        bgTransparent: false,
        borderColor: '#4aa3ff',
        borderWidth: 2,
        borderStyle: 'solid',
        fontSize: 20,
        bold: true,
        textAlign: 'left',
        lineHeight: 1.4
      }
    },
    question: {
      text: '問い\nここに問いを書く',
      w: 380,
      h: 140,
      style: {
        bgColor: '#fff0f3',
        bgTransparent: false,
        borderColor: '#ff7aa2',
        borderWidth: 2,
        borderStyle: 'dotted',
        fontSize: 20,
        bold: true,
        textAlign: 'left',
        lineHeight: 1.4
      }
    }
  };

  const addTemplateItem = (key) => {
    const preset = TEMPLATE_PRESETS[key];
    if (!preset) return;
    const page = getSelectedPage();
    if (!page) return;
    const base = getInsertionStyle();
    const style = { ...base, ...preset.style };
    const item = createTextItem(preset.text, style, 'text');
    item.w = preset.w;
    item.h = preset.h;
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const generateNumberLineSvg = (options) => {
    const {
      kind, min, max, step, length, lineColor, textColor
    } = options;
    const padding = 24;
    const baseY = 40;
    const ticks = Math.floor((max - min) / step);
    const tickCount = Math.max(1, ticks);
    const usable = Math.max(120, length);
    const width = usable + padding * 2;
    const height = kind === 'double' ? 120 : 90;
    const lineY = baseY;
    const secondY = baseY + 36;
    const tickSize = 10;
    let parts = '';

    const drawLine = (y) => {
      parts += `<line x1="${padding}" y1="${y}" x2="${padding + usable}" y2="${y}" stroke="${lineColor}" stroke-width="2" />`;
    };

    const drawTicks = (y, showLabels, labelOffset) => {
      for (let i = 0; i <= tickCount; i += 1) {
        const x = padding + (usable * i) / tickCount;
        parts += `<line x1="${x}" y1="${y - tickSize / 2}" x2="${x}" y2="${y + tickSize / 2}" stroke="${lineColor}" stroke-width="2" />`;
        if (showLabels) {
          const value = min + step * i;
          parts += `<text x="${x}" y="${y + labelOffset}" text-anchor="middle" font-size="12" fill="${textColor}">${value}</text>`;
        }
      }
    };

    if (kind === 'segment') {
      drawLine(lineY);
      parts += `<circle cx="${padding}" cy="${lineY}" r="4" fill="${lineColor}" />`;
      parts += `<circle cx="${padding + usable}" cy="${lineY}" r="4" fill="${lineColor}" />`;
      parts += `<text x="${padding}" y="${lineY - 12}" text-anchor="middle" font-size="12" fill="${textColor}">${min}</text>`;
      parts += `<text x="${padding + usable}" y="${lineY - 12}" text-anchor="middle" font-size="12" fill="${textColor}">${max}</text>`;
      parts += `<text x="${padding + usable / 2}" y="${lineY - 16}" text-anchor="middle" font-size="12" fill="${textColor}">${max - min}</text>`;
    } else if (kind === 'double') {
      drawLine(lineY);
      drawLine(secondY);
      drawTicks(lineY, true, 18);
      drawTicks(secondY, true, 18);
    } else if (kind === 'protractor') {
      const radius = 120;
      const cx = radius + 20;
      const cy = radius + 20;
      const widthP = radius * 2 + 40;
      const heightP = radius + 40;
      parts = '';
      parts += `<path d="M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}" fill="none" stroke="${lineColor}" stroke-width="2" />`;
      for (let angle = 0; angle <= 180; angle += 10) {
        const theta = Math.PI - (angle * Math.PI / 180);
        const x1 = cx + radius * Math.cos(theta);
        const y1 = cy - radius * Math.sin(theta);
        const x2 = cx + (radius - 10) * Math.cos(theta);
        const y2 = cy - (radius - 10) * Math.sin(theta);
        parts += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lineColor}" stroke-width="2" />`;
        const tx = cx + (radius - 26) * Math.cos(theta);
        const ty = cy - (radius - 26) * Math.sin(theta);
        parts += `<text x="${tx}" y="${ty}" text-anchor="middle" font-size="10" fill="${textColor}">${angle}</text>`;
      }
      const svg = svgWrap(widthP, heightP, parts);
      return { svg, width: widthP, height: heightP };
    } else {
      drawLine(lineY);
      drawTicks(lineY, true, 18);
    }

    const svg = svgWrap(width, height, parts);
    return { svg, width, height };
  };

  const parseGridInput = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = raw.replace(/[×xX]/g, '*');
    const match = normalized.match(/(\d+)\s*[*]\s*(\d+)/);
    if (match) {
      return { rows: parseInt(match[1], 10), cols: parseInt(match[2], 10) };
    }
    const single = normalized.match(/^\d+$/);
    if (single) {
      return { rows: 1, cols: parseInt(single[0], 10) };
    }
    return null;
  };

  const SPRITES = {
    ohajiki: 'assets/sprites/ohajiki.png',
    bead: 'assets/sprites/bead.png'
  };

  const generateGridSvg = (options) => {
    const {
      rows, cols, cell, gap, kind, fill, stroke
    } = options;
    const pad = 12;
    const effectiveGap = kind === 'grid' ? 0 : gap;
    const width = cols * cell + (cols - 1) * effectiveGap + pad * 2;
    const height = rows * cell + (rows - 1) * effectiveGap + pad * 2;
    let parts = '';
    let defs = '';
    let spriteIndex = 0;

    if (kind === 'grid') {
      const gridWidth = cols * cell;
      const gridHeight = rows * cell;
      const x0 = pad;
      const y0 = pad;
      parts += `<rect x="${x0}" y="${y0}" width="${gridWidth}" height="${gridHeight}" fill="transparent" stroke="${stroke}" stroke-width="1" />`;
      for (let c = 1; c < cols; c += 1) {
        const x = x0 + c * cell;
        parts += `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + gridHeight}" stroke="${stroke}" stroke-width="1" />`;
      }
      for (let r = 1; r < rows; r += 1) {
        const y = y0 + r * cell;
        parts += `<line x1="${x0}" y1="${y}" x2="${x0 + gridWidth}" y2="${y}" stroke="${stroke}" stroke-width="1" />`;
      }
      const svg = svgWrap(width, height, parts);
      return { svg, width, height };
    }

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x = pad + c * (cell + effectiveGap);
        const y = pad + r * (cell + effectiveGap);
        if (kind === 'dot') {
          const radius = Math.max(2, cell * 0.18);
          const cx = x + cell / 2;
          const cy = y + cell / 2;
          parts += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" />`;
        } else if (kind === 'array') {
          const radius = Math.max(2, cell * 0.32);
          const cx = x + cell / 2;
          const cy = y + cell / 2;
          const ink = fill || '#111111';
          parts += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${ink}" />`;
        } else if (kind === 'ohajiki' || kind === 'bead') {
          const sprite = SPRITES[kind];
          const size = cell * 0.9;
          const offset = (cell - size) / 2;
          const imgX = x + offset;
          const imgY = y + offset;
          if (sprite) {
            if (SPRITE_MASK_ENABLED) {
              const id = `sprite_${kind}_${spriteIndex}`;
              spriteIndex += 1;
              defs += `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="alpha">` +
                `<image href="${sprite}" x="${imgX}" y="${imgY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" />` +
                `</mask>`;
              parts += `<rect x="${imgX}" y="${imgY}" width="${size}" height="${size}" fill="${fill}" mask="url(#${id})" />`;
            } else {
              parts += `<image href="${sprite}" x="${imgX}" y="${imgY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" />`;
            }
          } else {
            const radius = cell * 0.45;
            const cx = x + cell / 2;
            const cy = y + cell / 2;
            parts += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="2" />`;
          }
        } else {
          const fillColor = kind === 'array' ? 'transparent' : fill;
          parts += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fillColor}" stroke="${stroke}" stroke-width="2" rx="4" />`;
        }
      }
    }
    const content = defs ? `<defs>${defs}</defs>${parts}` : parts;
    const svg = svgWrap(width, height, content);
    return { svg, width, height };
  };

  const normalizeGridMeta = (item) => {
    const kind = GRID_KINDS.has(item.svgKind)
      ? item.svgKind
      : (GRID_KINDS.has(item.gridKind) ? item.gridKind : 'tile');
    item.gridKind = kind;
    item.gridCell = clamp(parseFloat(item.gridCell) || 28, 4, 120);
    item.gridGap = clamp(parseFloat(item.gridGap) || 6, 0, 60);
    if (kind === 'grid') {
      item.gridGap = 0;
    }
    const pad = 12;
    const inferCount = (total) => {
      const available = Math.max(0, total - pad * 2);
      const denom = item.gridCell + item.gridGap;
      if (denom <= 0) return 1;
      const value = Math.round((available + item.gridGap) / denom);
      return Math.max(1, value);
    };
    const rows = parseInt(item.gridRows, 10);
    const cols = parseInt(item.gridCols, 10);
    item.gridRows = Number.isFinite(rows) && rows > 0 ? rows : inferCount(item.h || 0);
    item.gridCols = Number.isFinite(cols) && cols > 0 ? cols : inferCount(item.w || 0);
    if (!isSafeColor(item.gridFill)) {
      item.gridFill = (kind === 'array') ? '#111111' : '#8ecae6';
    }
    if (!isSafeColor(item.gridStroke)) {
      item.gridStroke = '#1b1b1b';
    }
    return {
      kind,
      rows: item.gridRows,
      cols: item.gridCols,
      cell: item.gridCell,
      gap: item.gridGap,
      fill: item.gridFill,
      stroke: item.gridStroke
    };
  };

  const rebuildGridSvg = (item) => {
    if (!item || item.type !== 'svg' || !GRID_KINDS.has(item.svgKind)) return;
    const meta = normalizeGridMeta(item);
    const diagram = generateGridSvg({
      rows: meta.rows,
      cols: meta.cols,
      cell: meta.cell,
      gap: meta.gap,
      kind: meta.kind,
      fill: meta.fill,
      stroke: meta.stroke
    });
    item.svgKind = meta.kind;
    item.svg = diagram.svg;
    item.w = diagram.width;
    item.h = diagram.height;
  };

  const migrateGridItems = () => {
    let changed = false;
    state.pages.forEach((page) => {
      page.items.forEach((item) => {
        if (item.type !== 'svg' || !GRID_KINDS.has(item.svgKind)) return;
        const needsSpriteRebuild = !SPRITE_MASK_ENABLED && (item.svgKind === 'ohajiki' || item.svgKind === 'bead');
        if (item.svgKind === 'array' || item.svgKind === 'grid' || needsSpriteRebuild || !item.svg) {
          rebuildGridSvg(item);
          changed = true;
        }
      });
    });
    if (changed) {
      scheduleSave();
    }
  };

  const moveLayer = (index, direction) => {
    const page = getSelectedPage();
    if (!page) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= page.items.length) return;
    const temp = page.items[index];
    page.items[index] = page.items[newIndex];
    page.items[newIndex] = temp;
    renderPages();
    renderLayers();
    scheduleSave();
    pushHistory();
  };

  const alignItems = (mode) => {
    const items = getSelectedItemsOnPage();
    if (items.length < 2) {
      showToast('2つ以上選択してください。', 'info');
      return;
    }
    const minX = Math.min(...items.map(i => i.x));
    const maxX = Math.max(...items.map(i => i.x + i.w));
    const minY = Math.min(...items.map(i => i.y));
    const maxY = Math.max(...items.map(i => i.y + i.h));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    items.forEach(item => {
      if (mode === 'left') item.x = minX;
      if (mode === 'center') item.x = centerX - item.w / 2;
      if (mode === 'right') item.x = maxX - item.w;
      if (mode === 'top') item.y = minY;
      if (mode === 'middle') item.y = centerY - item.h / 2;
      if (mode === 'bottom') item.y = maxY - item.h;
    });
    renderPages();
    renderInspector();
    renderLayers();
    scheduleSave();
    pushHistory();
  };

  const distributeItems = (axis) => {
    const items = getSelectedItemsOnPage();
    if (items.length < 3) {
      showToast('3つ以上選択してください。', 'info');
      return;
    }
    const sorted = [...items].sort((a, b) => axis === 'h' ? a.x - b.x : a.y - b.y);
    const start = axis === 'h' ? sorted[0].x : sorted[0].y;
    const end = axis === 'h'
      ? Math.max(...sorted.map(i => i.x + i.w))
      : Math.max(...sorted.map(i => i.y + i.h));
    const total = sorted.reduce((sum, i) => sum + (axis === 'h' ? i.w : i.h), 0);
    const gap = (end - start - total) / (sorted.length - 1);
    let cursor = start;
    sorted.forEach(item => {
      if (axis === 'h') {
        item.x = cursor;
        cursor += item.w + gap;
      } else {
        item.y = cursor;
        cursor += item.h + gap;
      }
    });
    renderPages();
    renderInspector();
    renderLayers();
    scheduleSave();
    pushHistory();
  };

  const cloneItem = (item, offset = 16) => {
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = uid('item');
    copy.x = (item.x || 0) + offset;
    copy.y = (item.y || 0) + offset;
    return copy;
  };

  const duplicateSelectedItems = () => {
    const page = getSelectedPage();
    if (!page) return;
    const items = getSelectedItemsOnPage();
    if (!items.length) return;
    const copies = items.map(item => cloneItem(item));
    page.items.push(...copies);
    state.selectedItemIds = copies.map(item => item.id);
    state.selectedItemId = state.selectedItemIds[state.selectedItemIds.length - 1] || null;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const deleteSelectedItems = (confirmMulti = true) => {
    const ids = new Set(getSelectedItemIds());
    if (!ids.size) return;
    if (confirmMulti && ids.size > 1 && !confirm('選択中の複数アイテムを削除しますか？')) {
      return;
    }
    state.pages.forEach(p => {
      p.items = p.items.filter(i => !ids.has(i.id));
    });
    state.selectedItemIds = [];
    state.selectedItemId = null;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const bringSelectionToFront = () => {
    const page = getSelectedPage();
    if (!page) return;
    const ids = new Set(getSelectedItemIds());
    if (!ids.size) return;
    const selected = page.items.filter(i => ids.has(i.id));
    page.items = page.items.filter(i => !ids.has(i.id)).concat(selected);
    renderPages();
    renderLayers();
    scheduleSave();
    pushHistory();
  };

  const svgWrap = (width, height, inner) => (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">${inner}</svg>`
  );

  const addSvgItem = (svg, width, height, kind, meta = null) => {
    const page = getSelectedPage();
    if (!page) return;
    const item = createSvgItem(svg, width, height, kind);
    if (meta && typeof meta === 'object') {
      Object.assign(item, meta);
    }
    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderAll();
    scheduleSave();
    pushHistory();
  };

  const enableInlineEdit = (item, contentEl) => {
    if (item.type !== 'text') return;
    contentEl.contentEditable = 'true';
    contentEl.focus();
    contentEl.parentElement.classList.add('editing');

    const finish = () => {
      item.text = contentEl.innerText.replace(/\r\n/g, '\n');
      contentEl.contentEditable = 'false';
      contentEl.parentElement.classList.remove('editing');
      renderInspector();
      renderLayers();
      scheduleSave();
      pushHistory();
    };

    const onBlur = () => {
      contentEl.removeEventListener('blur', onBlur);
      finish();
    };

    contentEl.addEventListener('blur', onBlur);
  };

  const insertHtmlAtCursor = (root, html) => {
    root.focus();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      root.innerHTML += html;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      root.innerHTML += html;
      return;
    }
    range.deleteContents();
    const frag = range.createContextualFragment(html);
    range.insertNode(frag);
    selection.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(root);
    newRange.collapse(false);
    selection.addRange(newRange);
  };

  const enableInlineRichEdit = (item, contentEl) => {
    if (item.type !== 'richtext') return;
    contentEl.contentEditable = 'true';
    contentEl.focus();
    contentEl.parentElement.classList.add('editing');

    const onPaste = (e) => {
      e.preventDefault();
      const html = e.clipboardData?.getData('text/html');
      const text = e.clipboardData?.getData('text/plain');
      const safe = html
        ? sanitizeRichHtml(html)
        : escapeHtml(text || '').replace(/\n/g, '<br>');
      insertHtmlAtCursor(contentEl, safe);
    };

    const finish = () => {
      const safeHtml = sanitizeRichHtml(contentEl.innerHTML);
      item.richHtml = safeHtml;
      contentEl.innerHTML = safeHtml;
      contentEl.contentEditable = 'false';
      contentEl.parentElement.classList.remove('editing');
      renderInspector();
      renderLayers();
      scheduleSave();
      pushHistory();
    };

    const onBlur = () => {
      contentEl.removeEventListener('blur', onBlur);
      contentEl.removeEventListener('paste', onPaste);
      finish();
    };

    contentEl.addEventListener('paste', onPaste);
    contentEl.addEventListener('blur', onBlur);
  };

  const startDraw = (event, pageEl) => {
    if (event.button !== 0) return;
    if (!state.view.drawMode) return;
    event.preventDefault();

    const pageId = pageEl.dataset.pageId;
    const page = state.pages.find(p => p.id === pageId);
    if (!page) return;

    const scale = state.view.zoom || 1;
    const pageRect = pageEl.getBoundingClientRect();
    const toPoint = (e) => ({
      x: clamp((e.clientX - pageRect.left) / scale, 0, pageRect.width / scale),
      y: clamp((e.clientY - pageRect.top) / scale, 0, pageRect.height / scale)
    });

    const startPoint = toPoint(event);
    const style = getDrawStyle();
    const tool = state.view.drawTool || 'curve';

    const createBaseItem = (drawKind) => ({
      id: uid('item'),
      type: 'draw',
      drawKind,
      x: startPoint.x,
      y: startPoint.y,
      w: 1,
      h: 1,
      rotation: 0,
      opacity: 1,
      points: [],
      strokeColor: style.strokeColor,
      strokeWidth: style.strokeWidth,
      fillColor: style.fillColor,
      fillOpacity: style.fillOpacity,
      fillEnabled: style.fillEnabled
    });

    if (tool === 'curve') {
      const points = [{ x: 0, y: 0 }];
      let minX = startPoint.x;
      let minY = startPoint.y;
      let maxX = startPoint.x;
      let maxY = startPoint.y;

      const item = createBaseItem('free');
      item.points = points;
      item.x = minX;
      item.y = minY;

      page.items.push(item);
      state.selectedItemIds = [item.id];
      state.selectedItemId = item.id;
      renderPages();
      renderInspector();
      renderLayers();

      const addPoint = (pt) => {
        const prevMinX = minX;
        const prevMinY = minY;
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
        if (minX !== prevMinX || minY !== prevMinY) {
          const dx = prevMinX - minX;
          const dy = prevMinY - minY;
          points.forEach(p => {
            p.x += dx;
            p.y += dy;
          });
        }
        points.push({ x: pt.x - minX, y: pt.y - minY });
        item.x = minX;
        item.y = minY;
        item.w = Math.max(1, maxX - minX);
        item.h = Math.max(1, maxY - minY);
      };

      let last = startPoint;
      const onMove = (e) => {
        const pt = toPoint(e);
        const dx = pt.x - last.x;
        const dy = pt.y - last.y;
        if ((dx * dx + dy * dy) < 1) return;
        last = pt;
        addPoint(pt);
        scheduleRender({ pages: true, inspector: true, layers: true });
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        scheduleSave();
        pushHistory();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    const drawKind = (tool === 'line')
      ? 'line'
      : (tool === 'segment')
        ? 'segment'
        : (tool === 'arc')
          ? 'arc'
          : (tool === 'bar')
            ? 'bar'
            : (tool === 'circle' || tool === 'ellipse') ? 'ellipse' : 'rect';

    const item = createBaseItem(drawKind);
    if (drawKind === 'line' || drawKind === 'segment' || drawKind === 'arc') {
      item.points = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    }

    page.items.push(item);
    state.selectedItemIds = [item.id];
    state.selectedItemId = item.id;
    renderPages();
    renderInspector();
    renderLayers();

    const onMove = (e) => {
      const pt = toPoint(e);
      let endX = pt.x;
      let endY = pt.y;
      if (tool === 'square' || tool === 'circle') {
        const dx = pt.x - startPoint.x;
        const dy = pt.y - startPoint.y;
        const size = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
        const signX = dx >= 0 ? 1 : -1;
        const signY = dy >= 0 ? 1 : -1;
        endX = startPoint.x + signX * size;
        endY = startPoint.y + signY * size;
      }

      const minX = Math.min(startPoint.x, endX);
      const minY = Math.min(startPoint.y, endY);
      const maxX = Math.max(startPoint.x, endX);
      const maxY = Math.max(startPoint.y, endY);
      item.x = minX;
      item.y = minY;
      item.w = Math.max(1, maxX - minX);
      item.h = Math.max(1, maxY - minY);

      if (drawKind === 'line' || drawKind === 'segment') {
        item.points = [
          { x: startPoint.x - minX, y: startPoint.y - minY },
          { x: endX - minX, y: endY - minY }
        ];
      }
      if (drawKind === 'arc') {
        const dx = endX - startPoint.x;
        const dy = endY - startPoint.y;
        const dist = Math.hypot(dx, dy) || 1;
        const nx = -dy / dist;
        const ny = dx / dist;
        const curvature = dist * 0.25;
        const sign = dy >= 0 ? -1 : 1;
        const midX = (startPoint.x + endX) / 2;
        const midY = (startPoint.y + endY) / 2;
        const ctrlX = midX + nx * curvature * sign;
        const ctrlY = midY + ny * curvature * sign;
        const minCX = Math.min(minX, ctrlX);
        const minCY = Math.min(minY, ctrlY);
        const maxCX = Math.max(maxX, ctrlX);
        const maxCY = Math.max(maxY, ctrlY);
        item.x = minCX;
        item.y = minCY;
        item.w = Math.max(1, maxCX - minCX);
        item.h = Math.max(1, maxCY - minCY);
        item.points = [
          { x: startPoint.x - minCX, y: startPoint.y - minCY },
          { x: endX - minCX, y: endY - minCY },
          { x: ctrlX - minCX, y: ctrlY - minCY }
        ];
      }

      scheduleRender({ pages: true, inspector: true, layers: true });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
      pushHistory();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startDrag = (event, item, pageEl) => {
    if (state.view.drawMode) return;
    if (event.button !== 0) return;
    if (event.target.classList.contains('resize-handle') || event.target.classList.contains('rotate-handle')) return;
    if (event.target.contentEditable === 'true') return;
    event.preventDefault();
    const multi = event.shiftKey || event.ctrlKey || event.metaKey;
    if (multi) {
      selectItem(item.id, { toggle: true });
    } else {
      const ids = getSelectedItemIds();
      if (ids.includes(item.id) && ids.length > 1) {
        selectItem(item.id, { preserve: true });
      } else {
        selectItem(item.id);
      }
    }

    const start = {
      item,
      pageId: pageEl.dataset.pageId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: 0,
      offsetY: 0
    };

    const pageRect = (getPageById(start.pageId)?.rect) || pageEl.getBoundingClientRect();
    const scale = state.view.zoom || 1;
    start.offsetX = (event.clientX - pageRect.left) / scale - item.x;
    start.offsetY = (event.clientY - pageRect.top) / scale - item.y;

    const onMove = (e) => {
      let target = getPageAtPoint(e.clientX, e.clientY);
      if (state.view.mode !== 'spread') {
        if (!target || target.pageId !== start.pageId) {
          target = getPageById(start.pageId);
        }
      } else if (!target) {
        target = getPageById(start.pageId);
      }
      if (!target) return;

      if (state.view.mode === 'spread' && target.pageId !== start.pageId) {
        const prevPage = state.pages.find(p => p.id === start.pageId);
        const nextPage = state.pages.find(p => p.id === target.pageId);
        if (prevPage && nextPage) {
          prevPage.items = prevPage.items.filter(i => i.id !== item.id);
          nextPage.items.push(item);
          start.pageId = target.pageId;
          state.selectedPageId = target.pageId;
        }
      }

      const scale = state.view.zoom || 1;
      let newX = (e.clientX - target.rect.left) / scale - start.offsetX;
      let newY = (e.clientY - target.rect.top) / scale - start.offsetY;
      if (state.view.snap) {
        newX = snapValue(newX);
        newY = snapValue(newY);
      }

      const pageW = target.rect.width / scale;
      const pageH = target.rect.height / scale;
      const maxX = Math.max(0, pageW - item.w);
      const maxY = Math.max(0, pageH - item.h);
      item.x = clamp(newX, 0, maxX);
      item.y = clamp(newY, 0, maxY);

      scheduleRender({ pages: true, inspector: true, layers: true });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
      pushHistory();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startResize = (event, item, pageEl, dir) => {
    event.stopPropagation();
    event.preventDefault();
    const start = {
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      startX: event.clientX,
      startY: event.clientY
    };

    const onMove = (e) => {
      const scale = state.view.zoom || 1;
      const dx = (e.clientX - start.startX) / scale;
      const dy = (e.clientY - start.startY) / scale;
      let newX = start.x;
      let newY = start.y;
      let newW = start.w;
      let newH = start.h;

      if (dir.includes('e')) newW = start.w + dx;
      if (dir.includes('s')) newH = start.h + dy;
      if (dir.includes('w')) { newW = start.w - dx; newX = start.x + dx; }
      if (dir.includes('n')) { newH = start.h - dy; newY = start.y + dy; }

      newW = Math.max(30, newW);
      newH = Math.max(30, newH);
      if (state.view.snap) {
        newX = snapValue(newX);
        newY = snapValue(newY);
        newW = Math.max(30, snapValue(newW));
        newH = Math.max(30, snapValue(newH));
      }

      item.x = newX;
      item.y = newY;
      item.w = newW;
      item.h = newH;
      scheduleRender({ pages: true, inspector: true });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
      pushHistory();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startRotate = (event, item, pageEl) => {
    event.stopPropagation();
    event.preventDefault();
    const pageRect = (getPageById(pageEl.dataset.pageId)?.rect) || pageEl.getBoundingClientRect();
    const scale = state.view.zoom || 1;
    const centerX = pageRect.left + (item.x + item.w / 2) * scale;
    const centerY = pageRect.top + (item.y + item.h / 2) * scale;
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const startRotation = item.rotation || 0;

    const onMove = (e) => {
      const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
      let deg = startRotation + (angle - startAngle) * (180 / Math.PI);
      if (e.shiftKey) {
        const step = 15;
        deg = Math.round(deg / step) * step;
      }
      item.rotation = Math.round(deg * 10) / 10;
      scheduleRender({ pages: true, inspector: true });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
      pushHistory();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const getPageAtPoint = (x, y) => {
    const pages = $$('.page');
    for (const pageEl of pages) {
      const rect = pageEl.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return { pageId: pageEl.dataset.pageId, rect };
      }
    }
    return null;
  };

  const getPageById = (pageId) => {
    if (!pageId) return null;
    const pageEl = $(`.page[data-page-id="${pageId}"]`);
    if (!pageEl) return null;
    return { pageId, rect: pageEl.getBoundingClientRect() };
  };

  const setPanelCollapsed = (panel, collapsed) => {
    if (!panel) return;
    const isLeft = panel.id === 'left-panel';
    const toggleBtn = isLeft ? $('#left-panel-toggle') : $('#right-panel-toggle');
    if (collapsed) {
      panel.dataset.prevWidth = panel.dataset.prevWidth || panel.getBoundingClientRect().width;
      panel.classList.add('collapsed');
      panel.style.width = `${COLLAPSED_WIDTH}px`;
      if (toggleBtn) toggleBtn.textContent = '展開';
    } else {
      panel.classList.remove('collapsed');
      const fallback = isLeft ? 320 : 340;
      const prev = parseFloat(panel.dataset.prevWidth) || fallback;
      panel.style.width = `${clamp(prev, MIN_PANEL, MAX_PANEL)}px`;
      if (toggleBtn) toggleBtn.textContent = '最小化';
    }
  };

  const bindPanelResizers = () => {
    const leftPanel = $('#left-panel');
    const rightPanel = $('#right-panel');
    const leftResizer = $('#resizer-left');
    const rightResizer = $('#resizer-right');

    const applyLayout = (layout) => {
      if (!layout) return;
      if (layout.leftCollapsed) {
        leftPanel.dataset.prevWidth = layout.left || leftPanel.getBoundingClientRect().width;
        setPanelCollapsed(leftPanel, true);
      } else if (layout.left) {
        leftPanel.dataset.prevWidth = layout.left;
        setPanelCollapsed(leftPanel, false);
        leftPanel.style.width = `${layout.left}px`;
      }
      if (layout.rightCollapsed) {
        rightPanel.dataset.prevWidth = layout.right || rightPanel.getBoundingClientRect().width;
        setPanelCollapsed(rightPanel, true);
      } else if (layout.right) {
        rightPanel.dataset.prevWidth = layout.right;
        setPanelCollapsed(rightPanel, false);
        rightPanel.style.width = `${layout.right}px`;
      }
    };

    const loadLayout = () => {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        applyLayout(data);
      } catch (e) {
        console.warn('レイアウトの読み込みに失敗しました。', e);
      }
    };

    const saveLayout = () => {
      const leftCollapsed = leftPanel.classList.contains('collapsed');
      const rightCollapsed = rightPanel.classList.contains('collapsed');
      const leftWidth = leftCollapsed
        ? (parseFloat(leftPanel.dataset.prevWidth) || leftPanel.getBoundingClientRect().width)
        : leftPanel.getBoundingClientRect().width;
      const rightWidth = rightCollapsed
        ? (parseFloat(rightPanel.dataset.prevWidth) || rightPanel.getBoundingClientRect().width)
        : rightPanel.getBoundingClientRect().width;
      const layout = {
        left: leftWidth,
        right: rightWidth,
        leftCollapsed,
        rightCollapsed
      };
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    };
    persistLayout = saveLayout;

    const startResizePanel = (event, side) => {
      event.preventDefault();
      if (side === 'left' && leftPanel.classList.contains('collapsed')) {
        setPanelCollapsed(leftPanel, false);
      }
      if (side === 'right' && rightPanel.classList.contains('collapsed')) {
        setPanelCollapsed(rightPanel, false);
      }
      const startX = event.clientX;
      const startLeft = leftPanel.getBoundingClientRect().width;
      const startRight = rightPanel.getBoundingClientRect().width;

      const onMove = (e) => {
        const dx = e.clientX - startX;
        if (side === 'left') {
          const next = clamp(startLeft + dx, MIN_PANEL, MAX_PANEL);
          leftPanel.style.width = `${next}px`;
          leftPanel.dataset.prevWidth = next;
        } else {
          const next = clamp(startRight - dx, MIN_PANEL, MAX_PANEL);
          rightPanel.style.width = `${next}px`;
          rightPanel.dataset.prevWidth = next;
        }
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        saveLayout();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    leftResizer.addEventListener('pointerdown', (e) => startResizePanel(e, 'left'));
    rightResizer.addEventListener('pointerdown', (e) => startResizePanel(e, 'right'));
    loadLayout();
  };

  const bindEvents = () => {
    $('#page-add').addEventListener('click', addPage);
    $('#page-delete').addEventListener('click', deletePage);
    $('#page-prev').addEventListener('click', () => {
      const idx = state.pages.findIndex(p => p.id === state.selectedPageId);
      const next = getNextPageIndex(idx, 'prev');
      if (next >= 0 && next < state.pages.length) {
        state.selectedPageId = state.pages[next].id;
        renderAll();
      }
    });
    $('#page-next').addEventListener('click', () => {
      const idx = state.pages.findIndex(p => p.id === state.selectedPageId);
      const next = getNextPageIndex(idx, 'next');
      if (next >= 0 && next < state.pages.length) {
        state.selectedPageId = state.pages[next].id;
        renderAll();
      }
    });
    $('#page-select').addEventListener('change', (e) => {
      state.selectedPageId = e.target.value;
      renderAll();
    });

    const leftToggle = $('#left-panel-toggle');
    const rightToggle = $('#right-panel-toggle');
    if (leftToggle) {
      leftToggle.addEventListener('click', () => {
        const panel = $('#left-panel');
        const collapsed = panel.classList.contains('collapsed');
        setPanelCollapsed(panel, !collapsed);
        persistLayout();
      });
    }
    if (rightToggle) {
      rightToggle.addEventListener('click', () => {
        const panel = $('#right-panel');
        const collapsed = panel.classList.contains('collapsed');
        setPanelCollapsed(panel, !collapsed);
        persistLayout();
      });
    }

    const undoBtn = $('#undo');
    const redoBtn = $('#redo');
    if (undoBtn) undoBtn.addEventListener('click', undo);
    if (redoBtn) redoBtn.addEventListener('click', redo);
    document.addEventListener('keydown', (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const isCtrl = e.ctrlKey || e.metaKey;
      if (!isCtrl) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    });

    document.addEventListener('keydown', (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      e.preventDefault();
      deleteSelectedItems(true);
    });

    const inspector = $('#inspector');
    const deleteBtn = $('#delete-item');
    if (inspector && deleteBtn && !$('#ins-move-front')) {
      const layerControls = document.createElement('div');
      layerControls.className = 'control-row';
      layerControls.innerHTML = `
        <button id="ins-move-front">最前面へ</button>
        <button id="ins-move-back">最背面へ</button>
      `;
      inspector.insertBefore(layerControls, deleteBtn);

      $('#ins-move-front').addEventListener('click', () => {
        const id = state.selectedItemId;
        if (!id) return;
        const page = state.pages.find(p => p.items.some(i => i.id === id));
        if (!page) return;
        const idx = page.items.findIndex(i => i.id === id);
        if (idx !== -1 && idx < page.items.length - 1) {
          const item = page.items.splice(idx, 1)[0];
          page.items.push(item);
          renderAll();
          scheduleSave();
        }
      });

      $('#ins-move-back').addEventListener('click', () => {
        const id = state.selectedItemId;
        if (!id) return;
        const page = state.pages.find(p => p.items.some(i => i.id === id));
        if (!page) return;
        const idx = page.items.findIndex(i => i.id === id);
        if (idx > 0) {
          const item = page.items.splice(idx, 1)[0];
          page.items.unshift(item);
          renderAll();
          scheduleSave();
        }
      });
    }

    const fullscreenBtn = $('#toggle-fullscreen');
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', togglePreviewFullscreen);
    }

    $('#toggle-view').addEventListener('click', () => {
      state.view.mode = state.view.mode === 'spread' ? 'continuous' : 'spread';
      updateView();
      renderPages();
      scheduleSave();
    });

    $('#toggle-grid').addEventListener('click', () => {
      state.view.showGrid = !state.view.showGrid;
      updateView();
      renderPages();
      scheduleSave();
    });

    const pageTurnBtn = $('#toggle-page-turn');
    if (pageTurnBtn) {
      pageTurnBtn.addEventListener('click', () => {
        if (state.view.kokugoMode) return;
        state.view.pageTurn = state.view.pageTurn === 'rtl' ? 'ltr' : 'rtl';
        updateView();
        scheduleSave();
      });
    }
    const kokugoBtn = $('#toggle-kokugo');
    if (kokugoBtn) {
      kokugoBtn.addEventListener('click', () => {
        state.view.kokugoMode = !state.view.kokugoMode;
        state.view.pageTurn = state.view.kokugoMode ? 'rtl' : 'ltr';
        updateView();
        renderPages();
        scheduleSave();
      });
    }

    const snapBtn = $('#toggle-snap');
    if (snapBtn) {
      snapBtn.addEventListener('click', () => {
        state.view.snap = !state.view.snap;
        updateView();
        scheduleSave();
      });
    }

    const pageSizeSelect = $('#page-size');
    if (pageSizeSelect) {
      pageSizeSelect.value = state.view.pageSize || 'A4-P';
      pageSizeSelect.addEventListener('change', (e) => {
        state.view.pageSize = e.target.value;
        applyPageSize(state.view.pageSize);
        renderPages();
        scheduleSave();
      });
    }

    const alignLeft = $('#align-left');
    const alignCenter = $('#align-center');
    const alignRight = $('#align-right');
    const alignTop = $('#align-top');
    const alignMiddle = $('#align-middle');
    const alignBottom = $('#align-bottom');
    const distributeH = $('#distribute-h');
    const distributeV = $('#distribute-v');
    if (alignLeft) alignLeft.addEventListener('click', () => alignItems('left'));
    if (alignCenter) alignCenter.addEventListener('click', () => alignItems('center'));
    if (alignRight) alignRight.addEventListener('click', () => alignItems('right'));
    if (alignTop) alignTop.addEventListener('click', () => alignItems('top'));
    if (alignMiddle) alignMiddle.addEventListener('click', () => alignItems('middle'));
    if (alignBottom) alignBottom.addEventListener('click', () => alignItems('bottom'));
    if (distributeH) distributeH.addEventListener('click', () => distributeItems('h'));
    if (distributeV) distributeV.addEventListener('click', () => distributeItems('v'));

    $('#zoom-range').addEventListener('input', (e) => {
      state.view.zoom = parseFloat(e.target.value);
      updateView();
      scheduleSave();
    });

    $('#print-pdf').addEventListener('click', () => window.print());
    $('#save-local').addEventListener('click', () => {
      const ok = saveLocal({ force: true, silentBackup: false });
      if (ok) showToast('保存しました。', 'success');
    });
    $('#load-local').addEventListener('click', () => {
      const result = loadLocal();
      if (result) {
        renderAll();
        showToast('読み込みました。', 'success');
        resetHistory();
        typesetAllMath();
      } else if (result === null) {
        showToast('保存データがありません。', 'info');
      }
    });

    $('#export-json').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'textbook_project.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    $('#import-json').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          state = normalizeState(data);
          migrateGridItems();
          renderAll();
          scheduleSave();
          resetHistory();
          typesetAllMath();
        } catch (err) {
          showToast('JSONの読み込みに失敗しました。', 'danger');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('#add-text').addEventListener('click', () => addTextItem('text'));
    $('#add-point').addEventListener('click', () => addTextItem('point'));
    const richAdd = $('#add-richtext');
    if (richAdd) {
      richAdd.addEventListener('click', () => addRichTextItemFromInput());
    }
    const richInput = $('#richtext-input');
    if (richInput) {
      richInput.addEventListener('paste', (e) => {
        e.preventDefault();
        const html = e.clipboardData?.getData('text/html');
        const text = e.clipboardData?.getData('text/plain');
        const safe = html
          ? sanitizeRichHtml(html)
          : escapeHtml(text || '').replace(/\n/g, '<br>');
        insertHtmlAtCursor(richInput, safe);
        normalizeRichTextInput(richInput);
      });
      richInput.addEventListener('input', () => normalizeRichTextInput(richInput));
      richInput.addEventListener('blur', () => normalizeRichTextInput(richInput));
      normalizeRichTextInput(richInput);
    }
    const mathInput = $('#math-text');
    const addMathBtn = $('#add-math');
    const mathFrac = $('#math-insert-frac');
    const mathSqrt = $('#math-insert-sqrt');
    const mathSup = $('#math-insert-sup');
    const mathSub = $('#math-insert-sub');
    if (addMathBtn) {
      addMathBtn.addEventListener('click', () => {
        addMathItem(mathInput?.value || '');
        if (mathInput) mathInput.value = '';
      });
    }
    if (mathFrac) mathFrac.addEventListener('click', () => insertTemplate(mathInput, '\\frac{}{}'));
    if (mathSqrt) mathSqrt.addEventListener('click', () => insertTemplate(mathInput, '\\sqrt{}'));
    if (mathSup) mathSup.addEventListener('click', () => insertTemplate(mathInput, '^{}'));
    if (mathSub) mathSub.addEventListener('click', () => insertTemplate(mathInput, '_{}'));

    const templateGoal = $('#template-goal');
    const templateSummary = $('#template-summary');
    const templateQuestion = $('#template-question');
    if (templateGoal) templateGoal.addEventListener('click', () => addTemplateItem('goal'));
    if (templateSummary) templateSummary.addEventListener('click', () => addTemplateItem('summary'));
    if (templateQuestion) templateQuestion.addEventListener('click', () => addTemplateItem('question'));

    const addLineDiagram = $('#add-line-diagram');
    if (addLineDiagram) {
      addLineDiagram.addEventListener('click', () => {
        const kind = $('#line-kind')?.value || 'number';
        const min = parseFloat($('#line-min')?.value) || 0;
        const max = parseFloat($('#line-max')?.value) || 10;
        const step = parseFloat($('#line-step')?.value) || 1;
        const length = parseFloat($('#line-length')?.value) || 420;
        const lineColor = $('#line-color')?.value || '#1b1b1b';
        const textColor = $('#line-text-color')?.value || '#1b1b1b';
        if (kind !== 'protractor' && (step <= 0 || max <= min)) {
          showToast('最小・最大・刻みの値を確認してください。', 'info');
          return;
        }
        const diagram = generateNumberLineSvg({ kind, min, max, step, length, lineColor, textColor });
        addSvgItem(diagram.svg, diagram.width, diagram.height, kind);
      });
    }

    const addTileDiagram = $('#add-tile-diagram');
    if (addTileDiagram) {
      addTileDiagram.addEventListener('click', () => {
        const dim = parseGridInput($('#tile-dim')?.value);
        if (!dim || dim.rows <= 0 || dim.cols <= 0) {
          showToast('サイズは「2*3」のように入力してください。', 'info');
          return;
        }
        const kind = $('#tile-kind')?.value || 'tile';
        const cell = parseFloat($('#tile-size')?.value) || 28;
        const gap = parseFloat($('#tile-gap')?.value) || 6;
        let fill = $('#tile-fill')?.value || '#8ecae6';
        const stroke = $('#tile-stroke')?.value || '#1b1b1b';
        if (kind === 'array') {
          fill = '#111111';
        }
        const diagram = generateGridSvg({
          rows: dim.rows,
          cols: dim.cols,
          cell,
          gap,
          kind,
          fill,
          stroke
        });
        addSvgItem(diagram.svg, diagram.width, diagram.height, kind, {
          gridKind: kind,
          gridRows: dim.rows,
          gridCols: dim.cols,
          gridCell: cell,
          gridGap: gap,
          gridFill: fill,
          gridStroke: stroke
        });
      });
    }
    const drawToggle = $('#draw-toggle');
    if (drawToggle) {
      drawToggle.addEventListener('click', () => {
        state.view.drawMode = !state.view.drawMode;
        updateView();
        scheduleSave();
      });
    }
    $$('.draw-tool').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.view.drawTool = btn.dataset.tool || 'curve';
        updateView();
        scheduleSave();
      });
    });
    const drawFillColor = $('#draw-fill-color');
    const drawFillOpacity = $('#draw-fill-opacity');
    const drawFillEnabled = $('#draw-fill-enabled');
    const drawColor = $('#draw-color');
    const drawColorSwatch = $('#draw-color-swatch');
    const drawColorCode = $('#draw-color-code');
    const drawFillSwatch = $('#draw-fill-color-swatch');
    const drawFillCode = $('#draw-fill-color-code');
    if (drawColor) drawColor.addEventListener('input', () => {
      updateColorReadout(drawColorSwatch, drawColorCode, drawColor.value);
      scheduleSave();
    });
    if (drawFillColor) drawFillColor.addEventListener('input', () => {
      updateColorReadout(drawFillSwatch, drawFillCode, drawFillColor.value);
      scheduleSave();
    });
    updateColorReadout(drawColorSwatch, drawColorCode, drawColor?.value || '#1b1b1b');
    updateColorReadout(drawFillSwatch, drawFillCode, drawFillColor?.value || '#1b1b1b');
    if (drawFillOpacity) drawFillOpacity.addEventListener('input', scheduleSave);
    if (drawFillEnabled) drawFillEnabled.addEventListener('change', scheduleSave);

    $('#add-image').addEventListener('click', () => $('#image-input').click());
    $('#image-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => addImageItem(ev.target.result);
      reader.readAsDataURL(file);
      e.target.value = '';
    });

    const emojiToggle = $('#emoji-picker-toggle');
    const emojiPop = $('#emoji-picker-pop');
    let emojiPicker = null;
    let emojiDataPromise = null;

    const closeEmojiPicker = () => {
      if (!emojiPop) return;
      emojiPop.classList.remove('open');
    };

    const getEmojiData = () => {
      if (!emojiDataPromise) {
        emojiDataPromise = fetch('https://cdn.jsdelivr.net/npm/@emoji-mart/data')
          .then(res => res.json())
          .catch((err) => {
            console.warn('Emoji Mart のデータ取得に失敗しました。', err);
            return {};
          });
      }
      return emojiDataPromise;
    };

    const ensureEmojiPicker = () => {
      if (!emojiPop || emojiPicker) return;
      if (!window.EmojiMart || !EmojiMart.Picker) {
        console.warn('Emoji Mart が読み込まれていません。');
        return;
      }
      emojiPicker = new EmojiMart.Picker({
        data: getEmojiData,
        locale: 'ja',
        theme: 'dark',
        onEmojiSelect: (emoji) => {
          const symbol = emoji?.native || emoji?.skins?.[0]?.native || emoji?.emoji || '';
          insertEmoji(symbol);
          closeEmojiPicker();
        }
      });
      emojiPop.innerHTML = '';
      emojiPop.appendChild(emojiPicker);
    };

    if (emojiToggle && emojiPop) {
      emojiToggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (emojiPop.classList.contains('open')) {
          closeEmojiPicker();
          return;
        }
        ensureEmojiPicker();
        if (!emojiPicker) return;
        emojiPop.classList.add('open');
      });
    }

    if (emojiToggle && emojiPop) {
      document.addEventListener('pointerdown', (e) => {
        if (!emojiPop.classList.contains('open')) return;
        if (emojiPop.contains(e.target) || emojiToggle.contains(e.target)) return;
        closeEmojiPicker();
      });
    }

    const inputTextColor = $('#input-text-color');
    const inputBorderColor = $('#input-border-color');
    const inputTextSwatch = $('#input-text-color-swatch');
    const inputBorderSwatch = $('#input-border-color-swatch');
    const inputTextCode = $('#input-text-color-code');
    const inputBorderCode = $('#input-border-color-code');
    const applyInputStyles = () => {
      const color = inputTextColor ? inputTextColor.value : '';
      const border = inputBorderColor ? inputBorderColor.value : '';
      const targets = [$('#main-text'), $('#point-text')].filter(Boolean);
      targets.forEach((el) => {
        if (color) el.style.color = color;
        if (border) el.style.borderColor = border;
      });
      if (inputTextSwatch && color) inputTextSwatch.style.background = color;
      if (inputBorderSwatch && border) inputBorderSwatch.style.background = border;
      if (inputTextCode && color) inputTextCode.textContent = color;
      if (inputBorderCode && border) inputBorderCode.textContent = border;
    };
    if (inputTextColor) inputTextColor.addEventListener('input', applyInputStyles);
    if (inputBorderColor) inputBorderColor.addEventListener('input', applyInputStyles);
    applyInputStyles();

    const fontCombine = $('#font-combine');
    const fontCombineDigits = $('#font-combine-digits');
    const fontVertical = $('#font-vertical');
    const syncCombineDigits = () => {
      if (!fontCombineDigits) return;
      const allow = (fontCombine?.checked ?? false) && (fontVertical?.checked ?? false);
      fontCombineDigits.disabled = !allow;
    };
    if (fontCombine) fontCombine.addEventListener('change', syncCombineDigits);
    if (fontVertical) fontVertical.addEventListener('change', syncCombineDigits);
    syncCombineDigits();

    $('#book-title').addEventListener('input', (e) => { state.project.title = e.target.value; scheduleSave(); });
    $('#book-subject').addEventListener('input', (e) => { state.project.subject = e.target.value; scheduleSave(); });
    $('#book-grade').addEventListener('input', (e) => { state.project.grade = e.target.value; scheduleSave(); });
    $('#book-author').addEventListener('input', (e) => { state.project.author = e.target.value; scheduleSave(); });

    $('#inspector').addEventListener('input', (e) => {
      const items = getSelectedItems();
      if (!items.length) return;
      const gridField = e.target.dataset.gridField;
      if (gridField) {
        let value;
        if (e.target.type === 'checkbox') {
          value = e.target.checked;
        } else if (e.target.type === 'number') {
          value = parseFloat(e.target.value) || 0;
        } else {
          value = e.target.value;
        }
        items.forEach((item) => {
          if (item.type !== 'svg' || !GRID_KINDS.has(item.svgKind)) return;
          item[gridField] = value;
          rebuildGridSvg(item);
        });
        renderPages();
        renderLayers();
        renderInspector();
        scheduleSave();
        scheduleHistoryPush();
        return;
      }
      const field = e.target.dataset.field;
      if (!field) return;
      let value;
      if (e.target.type === 'checkbox') {
        value = e.target.checked;
      } else if (NUM_FIELDS.has(field)) {
        value = parseFloat(e.target.value) || 0;
      } else {
        value = e.target.value;
      }
      if (CLAMP_0_1_FIELDS.has(field)) {
        value = clamp(value, 0, 1);
      }
      if (field === 'textCombineDigits') {
        value = normalizeCombineDigits(value);
      }
      items.forEach((item) => {
        if (TEXT_FIELDS.has(field) && !(item.type === 'text' || item.type === 'richtext')) return;
        if (MATH_FIELDS.has(field) && item.type !== 'math') return;
        if (DRAW_FIELDS.has(field) && item.type !== 'draw') return;
        item[field] = value;
        if (item.type === 'math' && (
          field === 'latex' ||
          field === 'mathBold' ||
          field === 'mathItalic' ||
          field === 'mathUnderline'
        )) {
          scheduleMathTypeset(item);
        }
      });
      renderPages();
      renderLayers();
      renderInspector();
      scheduleSave();
      scheduleHistoryPush();
    });

    const mathRefresh = $('#ins-math-refresh');
    if (mathRefresh) {
      mathRefresh.addEventListener('click', () => {
        const item = getSelectedItem();
        if (!item || item.type !== 'math') return;
        typesetMathItem(item);
      });
    }

    $('#delete-item').addEventListener('click', () => deleteSelectedItems(true));

    $('#add-glossary').addEventListener('click', () => {
      const term = $('#glossary-term').value.trim();
      const def = $('#glossary-def').value.trim();
      if (!term) return;
      state.support.glossary.push({ term, def });
      $('#glossary-term').value = '';
      $('#glossary-def').value = '';
      renderSupport();
      scheduleSave();
      pushHistory();
    });

    $('#add-citation').addEventListener('click', () => {
      const text = $('#citation-input').value.trim();
      if (!text) return;
      state.support.citations.push(text);
      $('#citation-input').value = '';
      renderSupport();
      scheduleSave();
      pushHistory();
    });

    $('#add-check').addEventListener('click', () => {
      const text = $('#check-input').value.trim();
      if (!text) return;
      state.support.checklist.push({ text, done: false });
      $('#check-input').value = '';
      renderSupport();
      scheduleSave();
      pushHistory();
    });

    $('#preview').addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    $('#preview').addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const target = getPageAtPoint(e.clientX, e.clientY);
        if (!target) return addImageItem(ev.target.result);
        const page = state.pages.find(p => p.id === target.pageId);
        const scale = state.view.zoom || 1;
        const x = (e.clientX - target.rect.left) / scale - 120;
        const y = (e.clientY - target.rect.top) / scale - 90;
        addImageItem(ev.target.result, { page, x, y });
      };
      reader.readAsDataURL(file);
    });

    const contextMenu = $('#context-menu');
    if (contextMenu) {
      contextMenu.addEventListener('click', (e) => {
        const action = e.target?.dataset?.action;
        if (!action) return;
        if (action === 'front') bringSelectionToFront();
        if (action === 'copy') duplicateSelectedItems();
        if (action === 'delete') deleteSelectedItems(true);
        hideContextMenu();
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (contextMenu && contextMenu.contains(e.target)) return;
      hideContextMenu();
    });
    document.addEventListener('scroll', hideContextMenu, true);
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && previewFullscreen) {
        setPreviewFullscreen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      hideContextMenu();
      if (previewFullscreen && !document.fullscreenElement) {
        setPreviewFullscreen(false);
      }
    });
    $('#preview').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.item')) return;
      e.preventDefault();
      hideContextMenu();
    });
  };

  const init = () => {
    loadLocal({ silent: true });
    if (!state.pages.length) {
      state.pages = [createPage(1)];
    }
    if (!state.selectedPageId) {
      state.selectedPageId = state.pages[0].id;
    }
    bindPanelResizers();
    bindEvents();
    renderAll();
    resetHistory();
    typesetAllMath();
  };

    init();
})();
