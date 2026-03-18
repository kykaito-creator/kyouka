(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const STORAGE_KEY = 'textbook_maker_state_v3';
  const LAYOUT_KEY = 'textbook_maker_layout_v3';
  const MIN_PANEL = 240;
  const MAX_PANEL = 520;
  let saveTimer = null;

  const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
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
    color: style.color,
    bgColor: style.bgColor,
    bgTransparent: !!style.bgTransparent,
    borderColor: style.borderColor,
    borderWidth: style.borderWidth,
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

  const defaultState = () => ({
    project: { title: '', subject: '', grade: '', author: '' },
    pages: [createPage(1)],
    selectedPageId: null,
    selectedItemId: null,
    selectedItemIds: [],
    view: { mode: 'continuous', showGrid: true, zoom: 1, drawMode: false, drawTool: 'curve' },
    support: { glossary: [], citations: [], checklist: [] }
  });

  let state = defaultState();

  const normalizeState = (input) => {
    const base = defaultState();
    if (!input || typeof input !== 'object') return base;
    base.project = { ...base.project, ...(input.project || {}) };
    base.view = { ...base.view, ...(input.view || {}) };
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
            color: item.color || '#1b1b1b',
            bgColor: item.bgColor && String(item.bgColor).startsWith('#') ? item.bgColor : '#ffffff',
            bgTransparent: typeof item.bgTransparent === 'boolean' ? item.bgTransparent : isTransparent(item.bgColor),
            borderColor: item.borderColor || '#111111',
            borderWidth: typeof item.borderWidth === 'number' ? item.borderWidth : 0,
            textAlign: item.textAlign || 'left',
            lineHeight: typeof item.lineHeight === 'number' ? item.lineHeight : 1.5,
            shape: item.shape || 'rect',
            src: item.src || '',
            points: Array.isArray(item.points) ? item.points.map(pt => ({
              x: typeof pt.x === 'number' ? pt.x : 0,
              y: typeof pt.y === 'number' ? pt.y : 0
            })) : [],
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

  const saveLocal = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 300);
  };

  const loadLocal = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
      state = normalizeState(JSON.parse(raw));
      if (!state.selectedPageId && state.pages.length) {
        state.selectedPageId = state.pages[0].id;
      }
      return true;
    } catch (err) {
      console.error('読み込みに失敗しました。', err);
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

  const updateProjectFields = () => {
    $('#book-title').value = state.project.title;
    $('#book-subject').value = state.project.subject;
    $('#book-grade').value = state.project.grade;
    $('#book-author').value = state.project.author;
  };

  const updateView = () => {
    const container = $('#page-container');
    container.classList.toggle('spread', state.view.mode === 'spread');
    container.classList.toggle('draw-mode', !!state.view.drawMode);
    container.style.setProperty('--zoom', state.view.zoom);
    $('#toggle-view').textContent = `見開き: ${state.view.mode === 'spread' ? 'ON' : 'OFF'}`;
    $('#toggle-grid').textContent = `グリッド: ${state.view.showGrid ? 'ON' : 'OFF'}`;
    $('#zoom-range').value = state.view.zoom;
    const drawToggle = $('#draw-toggle');
    if (drawToggle) {
      drawToggle.textContent = `描画: ${state.view.drawMode ? 'ON' : 'OFF'}`;
    }
    $$('.draw-tool').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === state.view.drawTool);
    });
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

  const applyTextStyles = (item, el) => {
    el.style.fontFamily = item.fontFamily;
    el.style.fontSize = `${item.fontSize}px`;
    el.style.fontWeight = item.bold ? '700' : '400';
    el.style.textDecoration = item.underline ? 'underline' : 'none';
    el.style.fontStyle = item.italic ? 'italic' : 'normal';
    el.style.color = item.color;
    el.style.background = item.bgTransparent ? 'transparent' : (item.bgColor || 'transparent');
    el.style.border = item.borderWidth > 0 ? `${item.borderWidth}px solid ${item.borderColor}` : 'none';
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

        if (selectedIds.has(item.id) && item.type !== 'draw' && item.id === state.selectedItemId) {
          ['nw','n','ne','e','se','s','sw','w'].forEach(dir => {
            const handle = document.createElement('div');
            handle.className = `resize-handle ${dir}`;
            handle.dataset.dir = dir;
            handle.addEventListener('pointerdown', (e) => startResize(e, item, pageEl, dir));
            itemEl.appendChild(handle);
          });
        }

        itemEl.addEventListener('pointerdown', (e) => startDrag(e, item, pageEl));
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
        : (item.type === 'image'
          ? '画像'
          : (item.type === 'draw'
            ? '描画'
            : (item.shape === 'circle' ? '円形' : '長方形')));
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
    if (item.type === 'text') {
      textTools.style.display = 'block';
      $('#ins-text').value = item.text;
      $('#ins-font').value = item.fontFamily;
      $('#ins-font-size').value = item.fontSize;
    $('#ins-bold').checked = item.bold;
    $('#ins-underline').checked = item.underline;
    $('#ins-italic').checked = item.italic;
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
  };

  const renderSupport = () => {
    const glossary = $('#glossary-list');
    glossary.innerHTML = '';
    state.support.glossary.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div><strong>${escapeHtml(item.term)}</strong><br><span class="muted">${escapeHtml(item.def)}</span></div>`;
      const del = document.createElement('button');
      del.textContent = '蜑企勁';
      del.addEventListener('click', () => {
        state.support.glossary.splice(index, 1);
        renderSupport();
        scheduleSave();
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
      del.textContent = '蜑企勁';
      del.addEventListener('click', () => {
        state.support.citations.splice(index, 1);
        renderSupport();
        scheduleSave();
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
      });
      const span = document.createElement('span');
      span.textContent = item.text;
      label.appendChild(checkbox);
      label.appendChild(span);
      const del = document.createElement('button');
      del.textContent = '蜑企勁';
      del.addEventListener('click', () => {
        state.support.checklist.splice(index, 1);
        renderSupport();
        scheduleSave();
      });
      row.appendChild(label);
      row.appendChild(del);
      checks.appendChild(row);
    });
  };

  const renderAll = () => {
    updateProjectFields();
    updateView();
    renderPageSelect();
    renderPages();
    renderLayers();
    renderInspector();
    renderSupport();
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
  };

  const deletePage = () => {
    if (state.pages.length <= 1) {
      alert('最低1ページは必要です。');
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
  };

  const getInsertionStyle = () => ({
    fontFamily: $('#font-family').value,
    fontSize: parseInt($('#font-size').value, 10) || 18,
    bold: $('#font-bold').checked,
    underline: $('#font-underline').checked,
    italic: $('#font-italic').checked,
    color: $('#font-color').value,
    bgColor: $('#bg-color').value,
    bgTransparent: $('#bg-transparent')?.checked ?? true,
    borderColor: $('#border-color').value,
    borderWidth: parseInt($('#border-width').value, 10) || 0,
    textAlign: $('#text-align').value,
    lineHeight: parseFloat($('#line-height').value) || 1.5
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

  const updateColorReadout = (swatchEl, codeEl, color) => {
    if (swatchEl && color) swatchEl.style.background = color;
    if (codeEl && color) codeEl.textContent = color;
  };

  const TEXT_FIELDS = new Set([
    'text','fontFamily','fontSize','bold','underline','italic','color',
    'bgColor','bgTransparent','borderColor','borderWidth','textAlign','lineHeight'
  ]);
  const DRAW_FIELDS = new Set([
    'strokeColor','strokeWidth','fillColor','fillOpacity','fillEnabled'
  ]);
  const NUM_FIELDS = new Set([
    'x','y','w','h','rotation','opacity','fontSize','borderWidth','lineHeight','strokeWidth','fillOpacity'
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
    };

    const onBlur = () => {
      contentEl.removeEventListener('blur', onBlur);
      finish();
    };

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
        renderPages();
        renderInspector();
        renderLayers();
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        scheduleSave();
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

      renderPages();
      renderInspector();
      renderLayers();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startDrag = (event, item, pageEl) => {
    if (state.view.drawMode) return;
    if (event.button !== 0) return;
    if (event.target.classList.contains('resize-handle')) return;
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

      const pageW = target.rect.width / scale;
      const pageH = target.rect.height / scale;
      const maxX = Math.max(0, pageW - item.w);
      const maxY = Math.max(0, pageH - item.h);
      item.x = clamp(newX, 0, maxX);
      item.y = clamp(newY, 0, maxY);

      renderPages();
      renderInspector();
      renderLayers();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
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

      item.x = newX;
      item.y = newY;
      item.w = newW;
      item.h = newH;
      renderPages();
      renderInspector();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSave();
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

  const bindPanelResizers = () => {
    const leftPanel = $('#left-panel');
    const rightPanel = $('#right-panel');
    const leftResizer = $('#resizer-left');
    const rightResizer = $('#resizer-right');

    const applyLayout = (layout) => {
      if (!layout) return;
      leftPanel.style.width = `${layout.left}px`;
      rightPanel.style.width = `${layout.right}px`;
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
      const layout = {
        left: leftPanel.getBoundingClientRect().width,
        right: rightPanel.getBoundingClientRect().width
      };
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    };

    const startResizePanel = (event, side) => {
      event.preventDefault();
      const startX = event.clientX;
      const startLeft = leftPanel.getBoundingClientRect().width;
      const startRight = rightPanel.getBoundingClientRect().width;

      const onMove = (e) => {
        const dx = e.clientX - startX;
        if (side === 'left') {
          const next = clamp(startLeft + dx, MIN_PANEL, MAX_PANEL);
          leftPanel.style.width = `${next}px`;
        } else {
          const next = clamp(startRight - dx, MIN_PANEL, MAX_PANEL);
          rightPanel.style.width = `${next}px`;
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
      if (idx > 0) {
        state.selectedPageId = state.pages[idx - 1].id;
        renderAll();
      }
    });
    $('#page-next').addEventListener('click', () => {
      const idx = state.pages.findIndex(p => p.id === state.selectedPageId);
      if (idx < state.pages.length - 1) {
        state.selectedPageId = state.pages[idx + 1].id;
        renderAll();
      }
    });
    $('#page-select').addEventListener('change', (e) => {
      state.selectedPageId = e.target.value;
      renderAll();
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

    $('#zoom-range').addEventListener('input', (e) => {
      state.view.zoom = parseFloat(e.target.value);
      updateView();
      scheduleSave();
    });

    $('#print-pdf').addEventListener('click', () => window.print());
    $('#save-local').addEventListener('click', () => {
      saveLocal();
      alert('保存しました。');
    });
    $('#load-local').addEventListener('click', () => {
      if (loadLocal()) {
        renderAll();
        alert('読み込みました。');
      } else {
        alert('保存データがありません。');
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
          renderAll();
          scheduleSave();
        } catch (err) {
          alert('JSONの読み込みに失敗しました。');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('#add-text').addEventListener('click', () => addTextItem('text'));
    $('#add-point').addEventListener('click', () => addTextItem('point'));
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

    $('#book-title').addEventListener('input', (e) => { state.project.title = e.target.value; scheduleSave(); });
    $('#book-subject').addEventListener('input', (e) => { state.project.subject = e.target.value; scheduleSave(); });
    $('#book-grade').addEventListener('input', (e) => { state.project.grade = e.target.value; scheduleSave(); });
    $('#book-author').addEventListener('input', (e) => { state.project.author = e.target.value; scheduleSave(); });

    $('#inspector').addEventListener('input', (e) => {
      const items = getSelectedItems();
      if (!items.length) return;
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
      items.forEach((item) => {
        if (TEXT_FIELDS.has(field) && item.type !== 'text') return;
        if (DRAW_FIELDS.has(field) && item.type !== 'draw') return;
        item[field] = value;
      });
      renderPages();
      renderLayers();
      renderInspector();
      scheduleSave();
    });

    $('#delete-item').addEventListener('click', () => {
      const ids = new Set(getSelectedItemIds());
      if (!ids.size) return;
      state.pages.forEach(p => {
        p.items = p.items.filter(i => !ids.has(i.id));
      });
      state.selectedItemIds = [];
      state.selectedItemId = null;
      renderAll();
      scheduleSave();
    });

    $('#add-glossary').addEventListener('click', () => {
      const term = $('#glossary-term').value.trim();
      const def = $('#glossary-def').value.trim();
      if (!term) return;
      state.support.glossary.push({ term, def });
      $('#glossary-term').value = '';
      $('#glossary-def').value = '';
      renderSupport();
      scheduleSave();
    });

    $('#add-citation').addEventListener('click', () => {
      const text = $('#citation-input').value.trim();
      if (!text) return;
      state.support.citations.push(text);
      $('#citation-input').value = '';
      renderSupport();
      scheduleSave();
    });

    $('#add-check').addEventListener('click', () => {
      const text = $('#check-input').value.trim();
      if (!text) return;
      state.support.checklist.push({ text, done: false });
      $('#check-input').value = '';
      renderSupport();
      scheduleSave();
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
  };

  const init = () => {
    loadLocal();
    if (!state.pages.length) {
      state.pages = [createPage(1)];
    }
    if (!state.selectedPageId) {
      state.selectedPageId = state.pages[0].id;
    }
    bindPanelResizers();
    bindEvents();
    renderAll();
  };

  init();
})();

