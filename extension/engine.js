/*
 * Specframe engine
 *
 * Hold Shift and drag over any part of a page. Inside the frame the region is shown
 * as a skeleton on a 4px grid, with paddings, gaps, sizes and corner radii read live
 * from the DOM on every animation frame. Spacing that is off the grid turns red, and a
 * panel lists the type styles (font, size, line height, colour) inside the frame.
 * When the drag ends the frame stays pinned: click any value to copy it as CSS,
 * Alt-click to copy it as Tailwind classes. Esc or a click elsewhere closes it.
 *
 *   const session = SpecframeEngine.start({
 *     onDragStart, onDragEnd, onPin, onClose,
 *     onHover(info | null),            // pointer over a copyable value while pinned
 *     onCopy({ text, tailwind, ok }),  // a value was copied
 *   });
 *   session.stop();
 */
(function () {
  'use strict';
  if (window.SpecframeEngine) return;

  const NS = 'http://www.w3.org/2000/svg';
  const OWN = 'data-specframe'; // marks every node Specframe adds, so it never measures itself

  const CFG = {
    grid: 4,             // CSS px; the frame snaps to it and the grid shows it
    maxElements: 2000,   // per frame, so huge regions stay smooth
    blockMaxHeight: 64,  // CSS px; filled boxes up to this height read as one block (buttons, chips)
    drawMs: 450,         // how long one measurement takes to draw itself in
    fadeMs: 160,         // overlay fade in / out
    shimmerMs: 1600,     // one skeleton shimmer pass
    dragThreshold: 4,    // px a Shift-drag must travel before it becomes ours
    tick: 6,             // end ticks on dimension lines, screen px
    textBar: 0.6,        // text skeleton bar height relative to font size
    typeRows: 6,         // type styles listed in the panel before "+N more"
  };

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'link', 'meta', 'title', 'br', 'wbr']);
  const ATOMIC = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'input', 'textarea', 'select', 'picture', 'object', 'embed']);
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  /* ── Small helpers ─────────────────────────────────────────── */

  const put = (node, attrs) => { for (const k in attrs) node.setAttribute(k, attrs[k]); return node; };
  const make = (parent, tag, attrs) => parent.appendChild(put(document.createElementNS(NS, tag), attrs || {}));

  // Boxes are { x1, y1, x2, y2 } in viewport px
  const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
  const boxOf = r => box(r.left, r.top, r.right, r.bottom);
  const span = (a, b) => box(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
  const W = b => b.x2 - b.x1;
  const H = b => b.y2 - b.y1;
  const overlap = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  const meet = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
  const encloses = (o, i) => o.x1 <= i.x1 + 0.5 && o.y1 <= i.y1 + 0.5 && o.x2 >= i.x2 - 0.5 && o.y2 >= i.y2 - 0.5;
  const inside = (b, x, y) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
  const clipTo = (a, b) => a ? box(Math.max(a.x1, b.x1), Math.max(a.y1, b.y1), Math.min(a.x2, b.x2), Math.min(a.y2, b.y2)) : b;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const easeOut = t => 1 - (1 - t) ** 3;
  const parentOf = n => n.parentElement || (n.parentNode && n.parentNode.host) || null;

  // Any computed CSS colour → [r, g, b, a] (sRGB, a in 0..1); null if it can't be read.
  // rgb()/rgba() is parsed directly; anything else (oklch, lab, color(), color-mix …, as used
  // by Tailwind v4 and modern design systems) is resolved by painting it into a 1×1 canvas.
  const colorCache = new Map();
  let colorCtx = null;
  function rgba(str) {
    if (!str) return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    const m = /^rgba?\(([^)]*)\)$/.exec(str);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      const a = p.length > 3 ? (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) : 1;
      out = [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), a];
    } else if (str === 'transparent') {
      out = [0, 0, 0, 0];
    } else {
      try {
        if (!colorCtx) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          colorCtx = canvas.getContext('2d', { willReadFrequently: true });
        }
        colorCtx.fillStyle = '#010203';
        colorCtx.fillStyle = str; // an unparseable colour leaves the sentinel in place
        if (colorCtx.fillStyle !== '#010203' || /^#010203$/i.test(str)) {
          colorCtx.clearRect(0, 0, 1, 1);
          colorCtx.fillRect(0, 0, 1, 1);
          const d = colorCtx.getImageData(0, 0, 1, 1).data;
          out = [d[0], d[1], d[2], d[3] / 255];
        }
      } catch { out = null; }
    }
    if (colorCache.size > 500) colorCache.clear();
    colorCache.set(str, out);
    return out;
  }
  const painted = cs => {
    if (cs.backgroundColor === 'transparent') return false;
    const c = rgba(cs.backgroundColor);
    return !c || c[3] > 0;
  };
  const bordered = cs => SIDES.some(s =>
    parseFloat(cs[`border${s}Width`]) > 0 && !/^(none|hidden)$/.test(cs[`border${s}Style`]));
  const hasOwnText = el => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  };

  // First mostly-opaque background at or above a node
  function backdrop(node) {
    for (let n = node; n && n.nodeType === 1; n = parentOf(n)) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (!c) return null;
      if (c[3] > 0.5) return c.slice(0, 3);
    }
    return [255, 255, 255];
  }

  // Skeleton colours: a step lighter than a dark background, or darker than a light one
  function tones(node) {
    const bg = backdrop(node) || [16, 16, 16];
    const dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.5;
    const toward = k => `rgb(${bg.map(v => Math.round(v + ((dark ? 255 : 0) - v) * k)).join(', ')})`;
    return {
      base: `rgb(${bg.map(Math.round).join(', ')})`,
      bone: toward(dark ? 0.15 : 0.12),
      shine: toward(dark ? 0.24 : 0.05),
    };
  }

  /* ── Values as CSS and as Tailwind classes (v4 names, 16px root) ── */

  // Spacing is on the grid when it's a multiple of 4; radii when they're even (the whole
  // Tailwind radius scale is), so 6 and 10 pass, 13 and 7 don't
  const offGrid = (kind, v) => kind === 'corner' ? v % 2 !== 0 : v % CFG.grid !== 0;

  const hex2 = v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  const hexOf = c => '#' + c.slice(0, 3).map(hex2).join('') + (c[3] < 0.995 ? hex2(c[3] * 255) : '');
  const num = v => String(+v.toFixed(2));

  // p-4, gap-x-2.5, w-px, h-[13px]
  const twSpace = (prefix, px) =>
    px === 0 ? `${prefix}-0` : px === 1 ? `${prefix}-px` : px % 2 === 0 ? `${prefix}-${px / 4}` : `${prefix}-[${px}px]`;

  const RADII = { 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' };
  const twRadius = (prefix, px) => RADII[px] ? `${prefix}-${RADII[px]}` : `${prefix}-[${px}px]`;
  const CORNER_NAMES = { '-1,-1': ['top-left', 'tl'], '1,-1': ['top-right', 'tr'], '1,1': ['bottom-right', 'br'], '-1,1': ['bottom-left', 'bl'] };

  // font size → [Tailwind name, its default line height]
  const TEXT = {
    12: ['xs', 16], 14: ['sm', 20], 16: ['base', 24], 18: ['lg', 28], 20: ['xl', 28], 24: ['2xl', 32],
    30: ['3xl', 36], 36: ['4xl', 40], 48: ['5xl', 48], 60: ['6xl', 60], 72: ['7xl', 72], 96: ['8xl', 96], 128: ['9xl', 128],
  };
  const WEIGHTS = {
    100: 'thin', 200: 'extralight', 300: 'light', 400: 'normal', 500: 'medium',
    600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black',
  };
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-\w+|math|emoji|-apple-system|BlinkMacSystemFont)$/i;

  // One text style as shown in the type panel, and how to copy it
  function typeOf(cs) {
    const size = +parseFloat(cs.fontSize).toFixed(1);
    const rawLh = cs.lineHeight;
    const lh = rawLh === 'normal' ? null
      : +(rawLh.endsWith('px') ? parseFloat(rawLh) : parseFloat(rawLh) * size).toFixed(1);
    const weight = Math.round(parseFloat(cs.fontWeight) || 400);
    const family = (cs.fontFamily.split(',')[0] || 'serif').trim().replace(/^["']|["']$/g, '');
    const c = rgba(cs.color) || [0, 0, 0, 1];
    const color = hexOf(c);

    const fam = GENERIC.test(family) || !/\s/.test(family) ? family : `"${family}"`;
    const css = `font-family: ${fam}; font-size: ${num(size)}px; font-weight: ${weight}; ` +
      `line-height: ${lh == null ? 'normal' : num(lh) + 'px'}; color: ${color};`;

    const named = TEXT[size];
    let tw = named ? `text-${named[0]}` : `text-[${num(size)}px]`;
    if (lh == null) tw += ' leading-[normal]'; // text-* sizes come with their own line height
    else if (!(named && named[1] === lh)) tw += lh % 4 === 0 ? `/${lh / 4}` : `/[${num(lh)}px]`;
    if (weight !== 400) tw += ` font-${WEIGHTS[weight] || `[${weight}]`}`;
    tw += ` text-[${color}]`;

    return {
      key: [family, weight, size, lh, color].join('|'),
      family, weight, size, lh, color, alpha: c[3],
      lhOff: lh != null && lh % CFG.grid !== 0,
      copy: { what: 'type', css, tw },
    };
  }

  // Copy text, falling back to execCommand where the async clipboard is blocked
  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    const ta = document.createElement('textarea');
    ta.setAttribute(OWN, '');
    ta.value = text;
    ta.style.cssText = 'position:fixed!important;top:0!important;left:0!important;opacity:0!important;pointer-events:none!important';
    const prev = document.activeElement;
    document.documentElement.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    if (prev && prev.focus) prev.focus({ preventScroll: true });
    return ok;
  }

  const html = (tag, className, text) => {
    const n = document.createElement(tag);
    n.className = className;
    n.setAttribute(OWN, '');
    if (text != null) n.textContent = text;
    return n;
  };

  /* ── Scene: the SVG overlay and everything drawn in it ─────── */

  class Scene {
    constructor() {
      const id = 'sf' + Math.random().toString(36).slice(2, 8);
      this.svg = put(document.createElementNS(NS, 'svg'), { class: 'sf-overlay', 'aria-hidden': 'true', [OWN]: '' });

      const defs = make(this.svg, 'defs');
      const hatch = make(defs, 'pattern', {
        id: `${id}-hatch`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
      });
      make(hatch, 'rect', { class: 'sf-hatch-fill', width: 6, height: 6 });
      make(hatch, 'line', { class: 'sf-hatch-line', x1: 3, y1: 0, x2: 3, y2: 6 });
      const hatchOff = make(defs, 'pattern', {
        id: `${id}-hatch-off`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
      });
      make(hatchOff, 'rect', { class: 'sf-hatch-fill sf-warn', width: 6, height: 6 });
      make(hatchOff, 'line', { class: 'sf-hatch-line sf-warn', x1: 3, y1: 0, x2: 3, y2: 6 });

      this.gridPattern = make(defs, 'pattern', { id: `${id}-grid`, patternUnits: 'userSpaceOnUse' });
      this.gridMinor = make(this.gridPattern, 'path', { class: 'sf-grid-minor' });
      this.gridMajor = make(this.gridPattern, 'path', { class: 'sf-grid-major' });

      this.shine = make(defs, 'linearGradient', { id: `${id}-shine`, gradientUnits: 'userSpaceOnUse' });
      make(this.shine, 'stop', { offset: 0, class: 'sf-stop-bone' });
      make(this.shine, 'stop', { offset: 0.5, class: 'sf-stop-shine' });
      make(this.shine, 'stop', { offset: 1, class: 'sf-stop-bone' });

      this.lensClip = make(make(defs, 'clipPath', { id: `${id}-lens` }), 'rect', { width: 0, height: 0 });
      this.shapeClip = make(make(defs, 'clipPath', { id: `${id}-shape` }), 'rect');
      const LENS = `url(#${id}-lens)`, SHAPE = `url(#${id}-shape)`;

      // Under the frame tint: skeleton + grid. Over it: measurements. Both seen only through the frame.
      const below = make(make(this.svg, 'g', { 'clip-path': LENS }), 'g', { 'clip-path': SHAPE });
      this.skeleton = make(below, 'g');
      this.gridFill = make(below, 'rect', { fill: `url(#${id}-grid)` });
      this.frame = make(this.svg, 'rect', { class: 'sf-frame' });
      const above = make(this.svg, 'g', { 'clip-path': LENS });
      this.strips = make(above, 'g', { 'clip-path': SHAPE });
      this.hotLayer = make(above, 'g', { class: 'sf-hot' });
      this.labels = make(above, 'g');
      const topLayer = make(this.svg, 'g');
      this.probe = make(this.svg, 'text', { class: 'sf-probe' });

      this.HATCH = `url(#${id}-hatch)`;
      this.HATCH_OFF = `url(#${id}-hatch-off)`;
      this.SHINE = `url(#${id}-shine)`;
      this.framePill = this.pill(topLayer);
      this.warnPill = this.pill(topLayer);
      this.warnPill.g.classList.add('sf-off');

      // Type styles in the frame: an HTML panel beside it
      this.panel = html('div', 'sf-glass sf-types');
      this.panel.setAttribute('aria-hidden', 'true');
      this.panelSig = '';
      this.panelSize = null;
      this.hot = null;   // style key whose text is outlined (panel row under the pointer)
      this.open = false;

      this.z = 1;            // screen px per CSS px for the measured root (zoom, transforms)
      this.root = null;
      this.shownRoot = null;
      this.baseFill = 'transparent';
      this.memo = new Map();
      this.widths = new Map();
      this.marks = new Map();
      this.tick = 0;
      this.ids = new WeakMap();
      this.nextId = 0;
      this.range = document.createRange();
      this.forgetWidths = () => this.widths.clear();
      if (document.fonts) document.fonts.addEventListener('loadingdone', this.forgetWidths);

      this.buildGrid();
      document.documentElement.append(this.svg, this.panel);
    }

    destroy() {
      if (document.fonts) document.fonts.removeEventListener('loadingdone', this.forgetWidths);
      this.svg.remove();
      this.panel.remove();
    }

    setOpen(on) {
      this.open = on;
      this.svg.classList.toggle('sf-open', on);
      this.panel.classList.toggle('sf-show', on && !!this.panelSig);
    }
    // Pinned: the frame stays after the drag and its values can be clicked
    setPinned(on) {
      this.svg.classList.toggle('sf-pinned', on);
      this.panel.classList.toggle('sf-pinned', on);
      if (!on) this.hot = null;
    }

    // Once fully faded out, every mark draws itself in again next time
    rewind() { for (const m of this.marks.values()) m.born = null; }

    /* layout reads, cached for one animation frame */
    beginFrame() { this.memo = new Map(); }
    look(el) {
      let v = this.memo.get(el);
      if (!v) {
        v = { b: boxOf(el.getBoundingClientRect()), cs: getComputedStyle(el), radii: {} };
        this.memo.set(el, v);
      }
      return v;
    }
    css(screenPx) { return Math.round(screenPx / this.z); }
    idOf(el) {
      let id = this.ids.get(el);
      if (id == null) this.ids.set(el, (id = ++this.nextId));
      return id;
    }
    area(el) { const b = this.look(el).b; return W(b) * H(b); }

    // Effective corner radius in screen px (sx, sy: -1 = left / top, 1 = right / bottom)
    radius(el, sx, sy) {
      const v = this.look(el), key = `${sx},${sy}`;
      if (!(key in v.radii)) {
        const raw = v.cs[`border${sy < 0 ? 'Top' : 'Bottom'}${sx < 0 ? 'Left' : 'Right'}Radius`] || '0';
        const first = raw.split(' ')[0];
        const n = first.endsWith('%') ? parseFloat(first) / 100 * W(v.b) : parseFloat(first) * this.z;
        v.radii[key] = Math.min(n || 0, W(v.b) / 2, H(v.b) / 2);
      }
      return v.radii[key];
    }
    arcCentre(el, sx, sy) {
      const b = this.look(el).b, r = this.radius(el, sx, sy);
      return [(sx < 0 ? b.x1 : b.x2) - sx * r, (sy < 0 ? b.y1 : b.y2) - sy * r];
    }

    /* labels */
    textWidth(s) {
      let w = this.widths.get(s);
      if (w == null) {
        this.probe.textContent = s;
        w = Math.ceil(this.probe.getComputedTextLength());
        this.widths.set(s, w);
      }
      return w;
    }
    pill(parent, soft = false) {
      const g = make(parent, 'g', { class: soft ? 'sf-pill sf-soft' : 'sf-pill' });
      return { g, bg: make(g, 'rect', { rx: 3, height: 16 }), text: make(g, 'text') };
    }
    // copy: { what, css, tw } makes the pill clickable while pinned; off: shown in red
    setPill(p, at, w, label, copy, off) {
      p.g.style.display = at ? '' : 'none'; // no room for this label this frame
      const sig = copy ? `${copy.css}|${copy.tw}` : '';
      if (copy !== undefined && p.copySig !== sig) {
        p.copySig = sig;
        p.g.__sfCopy = copy || null;
        copy ? p.g.setAttribute('data-sf-copy', '') : p.g.removeAttribute('data-sf-copy');
      }
      if (off !== undefined && p.off !== off) { p.off = off; p.g.classList.toggle('sf-off', off); }
      if (!at) return;
      const [cx, cy] = at;
      const x = Math.round(cx - w / 2), y = Math.round(cy - 8);
      put(p.bg, { x, y, width: w });
      put(p.text, { x: x + w / 2, y: y + 8 });
      if (p.text.textContent !== label) p.text.textContent = label;
    }

    /* ── what the frame is measuring ── */

    // The innermost element that fully contains the frame
    pickRoot(sel) {
      const x = clamp((sel.x1 + sel.x2) / 2, 0, innerWidth - 1);
      const y = clamp((sel.y1 + sel.y2) / 2, 0, innerHeight - 1);
      for (const el of document.elementsFromPoint(x, y)) {
        if (!(el instanceof HTMLElement) || el.closest(`[${OWN}]`)) continue;
        if (encloses(boxOf(el.getBoundingClientRect()), sel)) return el;
      }
      return document.body || document.documentElement;
    }

    syncRoot() {
      const root = this.root, b = this.look(root).b;
      const z = root.offsetWidth ? W(b) / root.offsetWidth : 1;
      if (z > 0 && Math.abs(z - this.z) > 1e-3) { this.z = z; this.buildGrid(); }
      if (root !== this.shownRoot) {
        this.shownRoot = root;
        const t = tones(root);
        this.baseFill = t.base;
        const st = this.svg.style;
        st.setProperty('--sf-label-bg', t.base);
        st.setProperty('--sf-bone', t.bone);
        st.setProperty('--sf-shine', t.shine);
      }
    }

    // Frame corners land on the 4px grid of the measured element
    snap(sel) {
      const o = this.look(this.root).b, s = CFG.grid * this.z;
      const fx = v => o.x1 + Math.round((v - o.x1) / s) * s;
      const fy = v => o.y1 + Math.round((v - o.y1) / s) * s;
      return box(fx(sel.x1), fy(sel.y1), fx(sel.x2), fy(sel.y2));
    }

    // Visible elements under the root that touch the frame, in document order
    collect(lens) {
      const found = [];
      const walk = (parent, clip) => {
        for (const el of parent.children) {
          if (found.length >= CFG.maxElements) return;
          const tag = el.localName;
          if (SKIP.has(tag) || el.hasAttribute(OWN)) continue;
          if (!(el instanceof HTMLElement || el instanceof SVGSVGElement)) continue;
          const { b, cs } = this.look(el);
          if (cs.display === 'none' || parseFloat(cs.opacity) < 0.01) continue;
          if (cs.display === 'contents') {
            walk(el, clip);
            if (el.shadowRoot) walk(el.shadowRoot, clip);
            continue;
          }
          // Zero-size wrappers (around floats or absolute children) can't be judged by their own box
          const empty = W(b) < 0.5 || H(b) < 0.5;
          if (!empty) {
            if (!meet(b, lens) || (clip && !overlap(b, clip))) continue;
            if (cs.visibility === 'visible') found.push(el);
          }
          if (ATOMIC.has(tag)) continue;
          const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
          const inner = clips ? clipTo(clip, b) : clip;
          walk(el, inner);
          if (el.shadowRoot) walk(el.shadowRoot, inner);
        }
      };
      const { b, cs } = this.look(this.root);
      const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' ? b : null;
      walk(this.root, clip);
      if (this.root.shadowRoot) walk(this.root.shadowRoot, clip);
      return found;
    }

    // blocks   → drawn as one shimmering placeholder with a size (buttons, chips, images, inputs)
    // visible  → everything not hidden inside a block
    // measured → gets sizes and radii; labels keep clear of these
    classify(els) {
      const containers = new Set(); // anything with a painted surface somewhere inside it
      for (const el of els) {
        const cs = this.look(el).cs;
        if (ATOMIC.has(el.localName) || !(painted(cs) || bordered(cs))) continue;
        for (let p = parentOf(el); p && !containers.has(p); p = parentOf(p)) {
          containers.add(p);
          if (p === this.root) break;
        }
      }
      const isBlock = el => {
        const { b, cs } = this.look(el);
        if (ATOMIC.has(el.localName) || cs.backgroundImage.includes('url(')) return true;
        return painted(cs) && !containers.has(el) && (H(b) / this.z <= CFG.blockMaxHeight || !el.textContent.trim());
      };
      const insideBlock = el => {
        for (let p = parentOf(el); p && p !== this.root; p = parentOf(p)) if (this.blocks.has(p)) return true;
        return false;
      };

      this.blocks = new Set();
      this.visible = [];
      for (const el of els) {
        if (insideBlock(el)) continue;
        this.visible.push(el);
        if (isBlock(el)) this.blocks.add(el);
      }
      this.measured = this.visible.filter(el => {
        const cs = this.look(el).cs;
        return this.blocks.has(el) || painted(cs) || bordered(cs) || cs.boxShadow !== 'none' || hasOwnText(el);
      });
    }

    /* ── the frame ── */

    paintFrame(sel) {
      const L = Math.round(sel.x1), T = Math.round(sel.y1), R = Math.round(sel.x2), B = Math.round(sel.y2);
      put(this.frame, { x: L + 0.5, y: T + 0.5, width: Math.max(0, R - L - 1), height: Math.max(0, B - T - 1) });
      put(this.lensClip, { x: L + 1, y: T + 1, width: Math.max(0, R - L - 2), height: Math.max(0, B - T - 2) });
      const label = `${this.css(R - L)} × ${this.css(B - T)}`;
      const w = this.textWidth(label) + 8;
      this.framePillAt = { x: (L + R) / 2, y: B + 16, w };
      this.setPill(this.framePill, [(L + R) / 2, B + 16], w, label);
    }

    // Minor lines every 4px, a stronger one every 16px
    buildGrid() {
      const s = CFG.grid * this.z, tile = 4 * s;
      let minor = '';
      for (let i = 1; i < 4; i++) minor += `M${i * s + 0.5} 0V${tile}M0 ${i * s + 0.5}H${tile}`;
      put(this.gridPattern, { width: tile, height: tile });
      put(this.gridMinor, { d: minor });
      put(this.gridMajor, { d: `M0.5 0V${tile}M0 0.5H${tile}` });
    }

    render(lens, now) {
      this.lens = lens;
      const c = this.look(this.root).b;
      this.paintFrame(lens);
      this.classify(this.collect(lens));
      this.drawSkeleton(c, now);
      this.drawSpecs(c, now);
      this.placePanel(lens);
    }

    /* ── skeleton: surfaces keep their colour, blocks shimmer, text becomes bars ── */

    drawSkeleton(c, now) {
      put(this.shapeClip, { x: c.x1, y: c.y1, width: W(c), height: H(c), rx: this.radius(this.root, -1, -1) });
      put(this.gridPattern, { x: Math.round(c.x1), y: Math.round(c.y1) });
      put(this.gridFill, { x: c.x1, y: c.y1, width: W(c), height: H(c) });

      const band = 120 * this.z, t = (now % CFG.shimmerMs) / CFG.shimmerMs;
      const mid = c.x1 - band + (W(c) + 2 * band) * t;
      put(this.shine, { x1: mid - band, y1: 0, x2: mid + band, y2: 0 });

      const g = this.skeleton;
      g.replaceChildren();
      make(g, 'rect', { x: c.x1, y: c.y1, width: W(c), height: H(c), fill: this.baseFill });

      const bars = [];
      const styles = new Map(); // type style key → { ...typeOf, count, lines }
      const textBars = (el, cs) => {
        const h = Math.max(2, Math.round(parseFloat(cs.fontSize) * CFG.textBar * this.z));
        let style = null;
        for (const n of el.childNodes) {
          if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
          this.range.selectNodeContents(n);
          for (const line of this.range.getClientRects()) {
            if (line.width < 1) continue;
            bars.push({
              x: line.left, y: (line.top + line.bottom - h) / 2, width: line.width, height: h,
              rx: Math.min(h / 2, 4 * this.z), fill: this.SHINE, opacity: parseFloat(cs.opacity),
            });
            if (!overlap(boxOf(line), this.lens)) continue;
            if (!style) {
              const t = typeOf(cs);
              style = styles.get(t.key);
              if (!style) styles.set(t.key, (style = { ...t, count: 0, lines: [] }));
              style.count++;
            }
            style.lines.push(line);
          }
        }
      };

      textBars(this.root, this.look(this.root).cs);
      for (const el of this.visible) {
        const { b, cs } = this.look(el);
        const rx = this.radius(el, -1, -1);
        if (this.blocks.has(el)) {
          make(g, 'rect', { x: b.x1, y: b.y1, width: W(b), height: H(b), rx, fill: this.SHINE });
          continue;
        }
        if (painted(cs)) make(g, 'rect', { x: b.x1, y: b.y1, width: W(b), height: H(b), rx, fill: cs.backgroundColor });
        for (const [side, dx, dy] of [['Top', 0, -1], ['Bottom', 0, 1], ['Left', -1, 0], ['Right', 1, 0]]) {
          const bw = parseFloat(cs[`border${side}Width`]) * this.z;
          if (!bw || /^(none|hidden)$/.test(cs[`border${side}Style`])) continue;
          make(g, 'rect', {
            x: dx > 0 ? b.x2 - bw : b.x1, y: dy > 0 ? b.y2 - bw : b.y1,
            width: dx ? bw : W(b), height: dy ? bw : H(b), fill: cs[`border${side}Color`],
          });
        }
        textBars(el, cs);
      }
      for (const bar of bars) make(g, 'rect', bar);

      this.updatePanel(styles);
      // Outline the text of the style under the pointer in the panel
      this.hotLayer.replaceChildren();
      const hot = this.hot && styles.get(this.hot);
      if (hot) {
        for (const r of hot.lines) {
          make(this.hotLayer, 'rect', { x: r.left - 1.5, y: r.top - 0.5, width: r.width + 3, height: r.height + 1, rx: 2 });
        }
      }
    }

    /* ── type panel ── */

    updatePanel(styles) {
      const list = [...styles.values()].sort((a, b) => b.size - a.size || b.weight - a.weight || b.count - a.count);
      const sig = list.map(s => `${s.key}:${s.count}`).join(';');
      if (sig === this.panelSig) return;
      this.panelSig = sig;
      this.panelSize = null;
      const p = this.panel;
      p.replaceChildren();
      p.classList.toggle('sf-show', this.open && list.length > 0);
      if (!list.length) return;
      p.appendChild(html('div', 'sf-head', list.length === 1 ? '1 type style' : `${list.length} type styles`));
      for (const s of list.slice(0, CFG.typeRows)) {
        const row = html('div', 'sf-row');
        row.setAttribute('data-sf-copy', '');
        row.__sfCopy = s.copy;
        row.__sfStyle = s.key;
        const swatch = html('span', 'sf-swatch');
        swatch.style.setProperty('background', s.color, 'important');
        const metric = html('span', 'sf-cell sf-num', `${num(s.size)}/${s.lh == null ? 'normal' : num(s.lh)}`);
        if (s.lhOff) {
          metric.classList.add('sf-bad');
          metric.title = 'Line height is off the 4px grid';
        }
        const name = s.family.length > 22 ? s.family.slice(0, 21) + '…' : s.family;
        row.append(
          swatch,
          html('span', 'sf-cell', `${name} ${s.weight}`),
          metric,
          html('span', 'sf-cell sf-dim sf-num', s.alpha < 0.995 ? `${s.color.slice(0, 7)} ${Math.round(s.alpha * 100)}%` : s.color),
          html('span', 'sf-cell sf-dim sf-num', `×${s.count}`),
        );
        p.appendChild(row);
      }
      if (list.length > CFG.typeRows) p.appendChild(html('div', 'sf-more', `+${list.length - CFG.typeRows} more`));
    }

    // Under the frame's size label; else to the right, left, above, or inside the frame
    placePanel(lens) {
      if (!this.panelSig) return;
      if (!this.panelSize) this.panelSize = [this.panel.offsetWidth, this.panel.offsetHeight];
      const [w, h] = this.panelSize, m = 8, vw = innerWidth, vh = innerHeight;
      const { x1: L, y1: T, x2: R, y2: B } = lens;
      const spots = [[L, B + 32], [R + m, T], [L - m - w, T], [L, T - m - h], [R - m - w, B - m - h]];
      const fits = ([x, y]) => x >= m && y >= m && x + w <= vw - m && y + h <= vh - m;
      let [x, y] = spots.find(fits) || spots[spots.length - 1];
      x = clamp(x, m, Math.max(m, vw - w - m));
      y = clamp(y, m, Math.max(m, vh - h - m));
      this.panel.style.setProperty('transform', `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`, 'important');
    }

    /* ── measurements ── */

    // Spacing between neighbouring children, read from where they actually sit:
    // side by side (flex rows, grids, inline-blocks) or stacked. Leftover room from
    // space-between / space-around / space-evenly is not spacing, so it's skipped.
    gapSpecs(el, specs) {
      if (ATOMIC.has(el.localName)) return;
      const cs = this.look(el).cs;
      if (/space-|evenly/.test(cs.justifyContent)) return;
      const kids = [...el.children].filter(k => {
        if (SKIP.has(k.localName) || k.hasAttribute(OWN)) return false;
        const s = this.look(k).cs;
        return s.display !== 'none' && s.position !== 'absolute' && s.position !== 'fixed';
      });
      for (let i = 1; i < kids.length; i++) {
        const a = this.look(kids[i - 1]).b, b = this.look(kids[i]).b;
        const rowOverlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0.5;
        const colOverlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0.5;
        let s = null;
        if (rowOverlap && b.x1 - a.x2 >= 0.5) {
          s = { axis: 'x', x1: a.x2, x2: b.x1, y1: Math.min(a.y1, b.y1), y2: Math.max(a.y2, b.y2), value: b.x1 - a.x2 };
        } else if (colOverlap && b.y1 - a.y2 >= 0.5) {
          s = { axis: 'y', y1: a.y2, y2: b.y1, x1: Math.min(a.x1, b.x1), x2: Math.max(a.x2, b.x2), value: b.y1 - a.y2 };
        }
        if (!s) continue;
        const value = this.css(s.value);
        const source = this.gapSource(cs, kids[i - 1], kids[i], s.axis, s.value);
        specs.push({
          kind: 'space', key: `gap:${this.idOf(el)}:${i}`, owner: el, push: [0, 0], ...s, value,
          copy: source && source.copy(value),
          // Only spacing someone declared (gap, margin) is checked against the grid, not
          // leftovers such as the space between inline words
          checked: !!source,
        });
      }
    }

    // Where a gap between two children comes from: the parent's gap, or their margins
    gapSource(cs, a, b, axis, screenPx) {
      const x = axis === 'x', near = v => Math.abs(v * this.z - screenPx) < 1;
      const col = parseFloat(cs.columnGap) || 0, row = parseFloat(cs.rowGap) || 0;
      const g = x ? col : row;
      if (g > 0 && near(g)) {
        const both = col === row;
        return {
          copy: v => ({
            what: 'gap',
            css: `${both ? 'gap' : x ? 'column-gap' : 'row-gap'}: ${v}px;`,
            tw: twSpace(both ? 'gap' : x ? 'gap-x' : 'gap-y', v),
          }),
        };
      }
      const after = parseFloat(this.look(a).cs[x ? 'marginRight' : 'marginBottom']) || 0;
      const before = parseFloat(this.look(b).cs[x ? 'marginLeft' : 'marginTop']) || 0;
      if (after <= 0 && before <= 0) return null;
      const [prop, tw] = before >= after
        ? (x ? ['margin-left', 'ml'] : ['margin-top', 'mt'])
        : (x ? ['margin-right', 'mr'] : ['margin-bottom', 'mb']);
      return { copy: v => ({ what: 'margin', css: `${prop}: ${v}px;`, tw: twSpace(tw, v) }) };
    }

    // CSS padding on each side, plus a dashed outline of the content box
    paddingSpecs(el, specs) {
      const { b, cs } = this.look(el);
      const [t, r, btm, l] = SIDES.map(k => parseFloat(cs['padding' + k]) * this.z);
      if (!(t || r || btm || l)) return;
      const inner = box(b.x1 + l, b.y1 + t, b.x2 - r, b.y2 - btm);
      const side = (name, v, axis, push, strip) => {
        if (!(v > 0)) return;
        const value = this.css(v);
        const copy = { what: 'padding', css: `padding-${name}: ${value}px;`, tw: twSpace('p' + name[0], value) };
        specs.push({ kind: 'space', key: `pad:${this.idOf(el)}:${name}`, owner: el, axis, push, value, copy, checked: true, ...strip });
      };
      side('top', t, 'y', [0, -1], box(b.x1, b.y1, b.x2, inner.y1));
      side('bottom', btm, 'y', [0, 1], box(b.x1, inner.y2, b.x2, b.y2));
      side('left', l, 'x', [-1, 0], box(b.x1, inner.y1, inner.x1, inner.y2));
      side('right', r, 'x', [1, 0], box(inner.x2, inner.y1, b.x2, inner.y2));
      specs.push({ kind: 'content', key: `content:${this.idOf(el)}`, ...inner });
    }

    // One radius per element: preferably a corner that is concentric with another
    // rounded element's corner, else the first whose centre isn't covered. Circles and
    // pill shapes are skipped, their radius is just "half the height".
    cornerSpec(el, rounded, specs, obstacles) {
      const b = this.look(el).b;
      const options = [];
      for (const [sx, sy] of CORNERS) {
        const rad = this.radius(el, sx, sy);
        if (rad < 1 || rad >= Math.min(W(b), H(b)) / 2 - 0.5) continue;
        const [cx, cy] = this.arcCentre(el, sx, sy);
        const concentric = o => {
          if (o === el || this.radius(o, sx, sy) < 1) return false;
          const [ox, oy] = this.arcCentre(o, sx, sy);
          return Math.hypot(ox - cx, oy - cy) < 1;
        };
        if (obstacles.some(o => o.el !== el && inside(o.b, cx, cy) && !concentric(o.el))) continue;
        options.push({ sx, sy, rad, cx, cy, paired: rounded.some(concentric) });
      }
      const k = options.find(o => o.paired) || options[0];
      if (!k) return;
      const value = this.css(k.rad);
      const all = CORNERS.every(([sx, sy]) => this.css(this.radius(el, sx, sy)) === value);
      const [long, short] = CORNER_NAMES[`${k.sx},${k.sy}`];
      const copy = all
        ? { what: 'radius', css: `border-radius: ${value}px;`, tw: twRadius('rounded', value) }
        : { what: 'radius', css: `border-${long}-radius: ${value}px;`, tw: twRadius(`rounded-${short}`, value) };
      specs.push({
        kind: 'corner', key: `corner:${this.idOf(el)}`, el, ...k, value, copy,
        px: k.sx < 0 ? b.x1 : b.x2, py: k.sy < 0 ? b.y1 : b.y2,
      });
    }

    drawSpecs(c, now) {
      this.tick++;
      this.taken = [];
      this.offCount = 0;
      this.obstacles = this.measured.map(el => ({ el, b: this.look(el).b }));
      const root = this.root;
      const wholePage = root === document.body || root === document.documentElement;
      const boxes = [root, ...this.visible];

      // Order is label priority: thin gaps first, they have the fewest places to go
      const specs = [];
      for (const el of boxes) this.gapSpecs(el, specs);
      for (const el of boxes) this.paddingSpecs(el, specs);
      for (const el of this.measured) if (this.blocks.has(el)) specs.push({ kind: 'size', key: `size:${this.idOf(el)}`, el });
      if (!wholePage) specs.push({ kind: 'size', key: `size:${this.idOf(root)}`, el: root });
      const rounded = [root, ...this.measured].filter(el => CORNERS.some(([sx, sy]) => this.radius(el, sx, sy) >= 1));
      rounded.sort((a, b) => this.area(a) - this.area(b));
      for (const el of rounded) this.cornerSpec(el, rounded, specs, this.obstacles);

      for (const s of specs) this.draw[s.kind].call(this, s, now, c);
      for (const [key, m] of this.marks) {
        if (m.tick === this.tick) continue;
        m.nodes.forEach(n => n.remove());
        this.marks.delete(key);
      }

      // "N off grid" beside the frame's size
      const f = this.framePillAt, n = this.offCount;
      const label = `${n} off grid`, w = this.textWidth(label) + 8;
      this.setPill(this.warnPill, n ? [f.x + f.w / 2 + 4 + w / 2, f.y] : null, w, label);
    }

    // Counts towards "N off grid" once it's inside the frame and drawn in
    flag(s, region, p) {
      const off = !!s.checked && offGrid(s.kind, s.value);
      if (off && p > 0 && meet(region, this.lens)) this.offCount++;
      return off;
    }

    // Marks persist between frames (keyed), so each one can animate in once
    mark(key, create) {
      let m = this.marks.get(key);
      if (!m) {
        m = { born: null, slot: 0 };
        create(m);
        this.marks.set(key, m);
      }
      m.tick = this.tick;
      return m;
    }

    // 0 → 1, starting when the mark first shows up inside the frame
    progress(m, region, now, delay) {
      if (m.born == null && meet(region, this.lens)) m.born = now;
      if (m.born == null) return 0;
      return easeOut(clamp((now - m.born - delay) / CFG.drawMs, 0, 1));
    }

    // Pick a spot for a label. Labels are only visible through the frame, so in order of preference:
    // free and inside the frame → inside the frame, covering an element but no other label →
    // free anywhere. If none qualifies the label is left out (null) rather than stacked on another.
    // Last frame's spot is kept while it still qualifies, so labels don't hop around.
    place(m, w, h, spots, owner) {
      const area = ([x, y]) => box(x - w / 2 - 1, y - h / 2 - 1, x + w / 2 + 1, y + h / 2 + 1);
      const blocked = this.taken.concat(this.obstacles.filter(o => !o.el.contains(owner)).map(o => o.b));
      const free = i => !blocked.some(b => overlap(area(spots[i]), b));
      const clearOfLabels = i => !this.taken.some(b => overlap(area(spots[i]), b));
      const shown = i => encloses(this.lens, area(spots[i]));
      const cutByFrame = i => overlap(area(spots[i]), this.lens) && !shown(i); // half-visible label
      const tests = [i => free(i) && shown(i), i => shown(i) && clearOfLabels(i), i => free(i) && !cutByFrame(i)];
      let i = -1;
      for (const ok of tests) {
        i = m.slot < spots.length && ok(m.slot) ? m.slot : spots.findIndex((_, j) => ok(j));
        if (i >= 0) break;
      }
      if (i < 0) return null;
      m.slot = i;
      this.taken.push(area(spots[i]));
      return spots[i];
    }
  }

  /* Each kind of mark draws itself in: hatches wipe open, lines grow, numbers count up */
  Scene.prototype.draw = {
    space(s, now) {
      const m = this.mark(s.key, m => {
        m.hatch = make(this.strips, 'rect', { fill: this.HATCH });
        m.g = make(this.labels, 'g');
        m.lines = [make(m.g, 'line'), make(m.g, 'line'), make(m.g, 'line')];
        m.pill = this.pill(m.g, true);
        m.nodes = [m.hatch, m.g];
      });
      const p = this.progress(m, s, now, 0);
      const horiz = s.axis === 'x';
      const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;

      const hw = W(s) / 2 * (horiz ? p : 1), hh = H(s) / 2 * (horiz ? 1 : p);
      put(m.hatch, { x: cx - hw, y: cy - hh, width: 2 * hw, height: 2 * hh });

      // Dimension line along the measured axis with end ticks that travel outwards
      const t = CFG.tick / 2, across = Math.round(horiz ? cy : cx) + 0.5;
      const lo = (horiz ? s.x1 : s.y1) + 0.5, hi = (horiz ? s.x2 : s.y2) - 0.5, mid = (lo + hi) / 2;
      const a = mid - (mid - lo) * p, b = mid + (hi - mid) * p;
      const seg = (n, u1, v1, u2, v2) => put(n, horiz ? { x1: u1, y1: v1, x2: u2, y2: v2 } : { x1: v1, y1: u1, x2: v2, y2: u2 });
      seg(m.lines[0], a, across, b, across);
      seg(m.lines[1], a, across - t, a, across + t);
      seg(m.lines[2], b, across - t, b, across + t);

      const off = this.flag(s, s, p);
      if (m.off !== off) {
        m.off = off;
        m.hatch.setAttribute('fill', off ? this.HATCH_OFF : this.HATCH);
        m.g.classList.toggle('sf-off', off);
      }
      const w = this.textWidth(String(s.value)) + 8;
      const at = this.place(m, w, 16, spaceSpots(s, w, 16), s.owner);
      this.setPill(m.pill, at, w, String(Math.round(s.value * p)), s.copy || null, off);
      m.hatch.style.visibility = m.g.style.visibility = p > 0 ? '' : 'hidden';
    },

    content(s, now) {
      const m = this.mark(s.key, m => {
        m.rect = make(this.strips, 'rect', { class: 'sf-content' });
        m.nodes = [m.rect];
      });
      const L = Math.round(s.x1), T = Math.round(s.y1), R = Math.round(s.x2), B = Math.round(s.y2);
      put(m.rect, { x: L + 0.5, y: T + 0.5, width: Math.max(0, R - L - 1), height: Math.max(0, B - T - 1) });
      m.rect.style.opacity = this.progress(m, s, now, 0);
    },

    // "W × H": under the measured root; on blocks inside them if roomy, else beside, below or above
    size(s, now, c) {
      const m = this.mark(s.key, m => {
        m.g = make(this.labels, 'g');
        m.pill = this.pill(m.g);
        m.nodes = [m.g];
      });
      const b = this.look(s.el).b;
      const p = this.progress(m, b, now, 80);
      const w0 = this.css(W(b)), h0 = this.css(H(b));
      const w = this.textWidth(`${w0} × ${h0}`) + 8, h = 16;
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
      const spots = s.el === this.root ? [[cx, b.y2 + 8 + h / 2]] : [
        W(b) >= w * 3 && H(b) >= h * 3 && [cx, cy],
        b.x2 + 6 + w <= c.x2 - 4 && [b.x2 + 6 + w / 2, cy],
        [cx, b.y2 + 4 + h / 2],
        [cx, b.y1 - 4 - h / 2],
        [cx, cy],
      ].filter(Boolean);
      const at = this.place(m, w, h, spots, s.el);
      if (!m.copy || m.copy.w !== w0 || m.copy.h !== h0) {
        m.copy = {
          what: 'size', w: w0, h: h0, css: `width: ${w0}px; height: ${h0}px;`,
          tw: w0 === h0 ? twSpace('size', w0) : `${twSpace('w', w0)} ${twSpace('h', h0)}`,
        };
      }
      this.setPill(m.pill, at, w, `${Math.round(w0 * p)} × ${Math.round(h0 * p)}`, m.copy);
      m.g.style.visibility = p > 0 ? '' : 'hidden';
      m.g.style.opacity = Math.min(1, p * 4);
    },

    // The corner arc traces itself, a radius line grows out of the arc's centre
    corner(s, now) {
      const m = this.mark(s.key, m => {
        m.g = make(this.labels, 'g');
        m.arc = make(m.g, 'path', { pathLength: 1, 'stroke-dasharray': 1 });
        m.ray = make(m.g, 'line', { class: 'sf-dashed' });
        m.dot = make(m.g, 'circle', { class: 'sf-dot' });
        m.pill = this.pill(m.g);
        m.nodes = [m.g];
      });
      const { sx, sy, cx, cy, px, py, rad } = s, d = Math.SQRT1_2;
      const region = box(Math.min(px, cx), Math.min(py, cy), Math.max(px, cx), Math.max(py, cy));
      const p = this.progress(m, region, now, 140);
      put(m.arc, { d: `M${cx} ${py}A${rad} ${rad} 0 0 ${sx * sy < 0 ? 1 : 0} ${px} ${cy}`, 'stroke-dashoffset': 1 - p });
      put(m.ray, { x1: cx, y1: cy, x2: cx + sx * rad * d * p, y2: cy + sy * rad * d * p });
      put(m.dot, { cx, cy, r: 1.5 * Math.min(1, p * 4) });
      const value = s.value, w = this.textWidth(`r ${value}`) + 8, h = 16;
      const off = this.flag({ ...s, checked: true }, region, p);
      if (m.off !== off) { m.off = off; m.g.classList.toggle('sf-off', off); }
      const spots = [
        [cx - sx * (w / 2 + 4), cy - sy * (h / 2 + 4)], // inside, next to the centre
        [cx - sx * (w / 2 + 4), cy - sy * (h * 1.5 + 8)], // further in, for concentric corners
        [cx - sx * (w * 1.5 + 8), cy - sy * (h / 2 + 4)],
        [px + sx * (w / 2 + 4), py + sy * (h / 2 + 4)], // just outside the corner
        [px + sx * (w / 2 + 4), py + sy * (h * 1.5 + 8)],
        [px + sx * (w * 1.5 + 8), py + sy * (h / 2 + 4)],
      ];
      const at = this.place(m, w, h, spots, s.el);
      this.setPill(m.pill, at, w, `r ${Math.round(value * p)}`, s.copy, off);
      m.g.style.visibility = p > 0 ? '' : 'hidden';
    },
  };

  // Label inside the strip if it fits across it; otherwise pushed outwards (paddings),
  // or for gaps, just past either end
  function spaceSpots(s, w, h) {
    const wide = W(s) >= H(s), cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
    const room = wide ? H(s) : W(s), need = wide ? h : w;
    const shift = need <= room ? 0 : need / 2 + room / 2 + 2;
    const [px, py] = s.push;
    const spots = [0.5, 0.25, 0.75].map(f => wide
      ? [s.x1 + W(s) * f + px * shift, cy + py * shift]
      : [cx + px * shift, s.y1 + H(s) * f + py * shift]);
    if (shift && !px && !py) {
      spots.push(...(wide
        ? [[s.x2 + w / 2 + 2, cy], [s.x1 - w / 2 - 2, cy]]
        : [[cx, s.y2 + h / 2 + 2], [cx, s.y1 - h / 2 - 2]]));
    }
    return spots;
  }

  /* ── Session: input handling and the animation loop ─────────── */

  let session = null;

  function start(hooks = {}) {
    if (session) return session;
    const scene = new Scene();
    const call = (name, arg) => { if (hooks[name]) hooks[name](arg); };

    let anchor = null, cursor = null, lens = null, pinnedAt = null;
    let open = false, dragging = false, pinned = false, pending = null;
    let closedAt = -Infinity, raf = 0, armed = false, savedSelect = null;
    let pressedCopy = false, hovered = null;

    function loop(now) {
      raf = 0;
      if (!open && now - closedAt > CFG.fadeMs + 50) { scene.rewind(); return; }
      raf = requestAnimationFrame(loop);
      scene.beginFrame();
      if (dragging) scene.root = scene.pickRoot(span(anchor, cursor));
      if (!scene.root || !scene.root.isConnected) {
        if (pinned) close(); // the measured element went away
        return;
      }
      scene.syncRoot();
      if (dragging) {
        lens = scene.snap(span(anchor, cursor));
      } else if (pinned) {
        // A pinned frame sticks to the element it measures, so it follows scrolling
        const b = scene.look(scene.root).b;
        lens = box(b.x1 + pinnedAt.x1, b.y1 + pinnedAt.y1, b.x1 + pinnedAt.x2, b.y1 + pinnedAt.y2);
      }
      if (lens) scene.render(lens, now);
    }

    function setArmed(on) {
      if (on === armed) return;
      armed = on;
      document.documentElement.classList.toggle('sf-armed', on);
    }
    // Shift while typing is for capital letters, not for measuring
    const typing = () => {
      const a = document.activeElement;
      return !!a && (a.isContentEditable || /^(input|textarea|select)$/i.test(a.localName));
    };
    const syncArmed = e => setArmed(dragging || (!!e && !!e.shiftKey && !typing()));

    // While a drag is ours, nothing on the page gets selected under it
    function freezeSelection() {
      const sel = window.getSelection && window.getSelection();
      if (sel) sel.removeAllRanges();
      const st = document.documentElement.style;
      savedSelect = ['user-select', '-webkit-user-select'].map(p => [p, st.getPropertyValue(p), st.getPropertyPriority(p)]);
      st.setProperty('user-select', 'none', 'important');
      st.setProperty('-webkit-user-select', 'none', 'important');
    }
    function thawSelection() {
      if (!savedSelect) return;
      const st = document.documentElement.style;
      for (const [p, v, prio] of savedSelect) v ? st.setProperty(p, v, prio) : st.removeProperty(p);
      savedSelect = null;
    }

    // The click the browser fires after a drag's release (or a copy) belongs to us, not to the page
    function swallowNextClick() {
      const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
      addEventListener('click', stop, true);
      setTimeout(() => removeEventListener('click', stop, true), 0);
    }

    // A copyable value (pill or type row) under the pointer, while pinned
    const copyable = t => {
      const n = pinned && t && t.closest ? t.closest('[data-sf-copy]') : null;
      return n && n.__sfCopy ? n : null;
    };
    function setHover(n) {
      if (n === hovered) return;
      hovered = n;
      scene.hot = (n && n.__sfStyle) || null;
      // rect: what the hint should keep clear of (the label, or the whole type panel)
      const panel = n && n.closest('.sf-types');
      call('onHover', n ? { ...n.__sfCopy, rect: (panel || n).getBoundingClientRect(), panel: !!panel } : null);
    }

    function begin(point) {
      if (pinned) unpin();
      anchor = cursor = point;
      dragging = true;
      freezeSelection();
      call('onDragStart');
    }

    function moveTo(point) {
      cursor = point;
      if (!open) {
        open = true;
        scene.setOpen(true);
      }
      if (!raf) raf = requestAnimationFrame(loop);
    }

    function pin() {
      const b = scene.look(scene.root).b;
      pinnedAt = box(lens.x1 - b.x1, lens.y1 - b.y1, lens.x2 - b.x1, lens.y2 - b.y1);
      pinned = true;
      scene.setPinned(true);
      call('onPin');
    }
    function unpin() {
      pinned = false;
      scene.setPinned(false);
      setHover(null);
    }
    // Fade out where it is
    function close() {
      if (pinned) unpin();
      if (!open) return;
      open = false;
      closedAt = performance.now();
      scene.setOpen(false);
      call('onClose');
    }

    // Releasing pins the frame; cancelling (Esc, focus lost) closes it instead
    function finish(e, cancel) {
      pending = null;
      thawSelection();
      if (dragging) {
        dragging = false;
        anchor = null;
        call('onDragEnd');
        if (open) {
          swallowNextClick();
          if (cancel || !lens || !scene.root || !scene.root.isConnected) close();
          else pin();
        }
      }
      syncArmed(e);
    }

    async function copy(n, tailwind) {
      const info = n.__sfCopy, text = tailwind ? info.tw : info.css;
      const ok = await writeClipboard(text);
      call('onCopy', { text, tailwind, ok, what: info.what });
    }

    // Shift + press only arms a drag; a Shift-click that doesn't move stays the page's.
    // While pinned, a press on a value copies it, and any other press (without Shift) closes the frame.
    const onDown = e => {
      if (e.button !== 0 || !e.isPrimary) return;
      const hit = copyable(e.target);
      if (hit) {
        e.preventDefault();
        e.stopImmediatePropagation();
        pressedCopy = true;
        copy(hit, e.altKey);
        return;
      }
      if (pinned && !e.shiftKey) close();
      if (e.shiftKey) pending = { x: e.clientX, y: e.clientY };
    };
    const onMove = e => {
      if (!e.isPrimary) return;
      if (pending) {
        if (!(e.buttons & 1)) pending = null;
        else if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) >= CFG.dragThreshold) {
          begin(pending);
          pending = null;
        }
      }
      syncArmed(e); // also catches Shift pressed while the page didn't have focus
      if (!dragging) {
        if (pinned) setHover(copyable(e.target));
        return;
      }
      if (!(e.buttons & 1)) return finish(e, false); // released outside the window
      e.preventDefault();
      e.stopPropagation(); // the page never sees a drag that is ours
      moveTo({ x: e.clientX, y: e.clientY });
    };
    const onUp = e => {
      if (pressedCopy) {
        pressedCopy = false;
        e.stopImmediatePropagation();
        swallowNextClick();
        return;
      }
      finish(e, false);
    };
    const onCancel = e => finish(e, true);
    const onKeyDown = e => {
      syncArmed(e);
      if (e.key !== 'Escape') return;
      if (dragging || pending) {
        e.stopPropagation();
        finish(null, true);
      } else if (pinned) {
        e.stopPropagation();
        close();
      }
    };
    const onKeyUp = e => syncArmed(e);
    const onSelectStart = e => { if (dragging) e.preventDefault(); };
    // A Shift-drag on a link or image would otherwise become the browser's own drag-and-drop
    const onNativeDrag = e => { if (dragging || pending) e.preventDefault(); };
    // Switching to another app (say, to paste) keeps a pinned frame; it only cancels a drag
    const onBlur = () => finish(null, true);

    const listeners = [
      ['pointerdown', onDown, true], ['pointermove', onMove, true], ['pointerup', onUp, true],
      ['pointercancel', onCancel, true], ['keydown', onKeyDown, true], ['keyup', onKeyUp, true],
      ['selectstart', onSelectStart, true], ['dragstart', onNativeDrag, true], ['blur', onBlur, false],
    ];
    for (const [type, fn, capture] of listeners) addEventListener(type, fn, capture);

    session = {
      stop() {
        for (const [type, fn, capture] of listeners) removeEventListener(type, fn, capture);
        if (dragging) finish(null, true);
        cancelAnimationFrame(raf);
        setArmed(false);
        thawSelection();
        scene.destroy();
        session = null;
      },
    };
    return session;
  }

  window.SpecframeEngine = { start, config: CFG };
})();
