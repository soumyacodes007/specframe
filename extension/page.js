/*
 * Specframe: runs in the page after the toolbar button is clicked.
 * window.__specframe.toggle() turns it on or off and returns the new state.
 * Adds the hint that follows the cursor ("⇧ Shift + drag", or what a click copies while a
 * frame is pinned) and a status toast.
 */
(() => {
  'use strict';
  if (window.__specframe) return;

  const KEY_LABEL = '⇧ Shift';
  const CURSOR_GAP = 16; // px between the cursor and its hint

  const node = (tag, className, text) => {
    const n = document.createElement(tag);
    n.className = className;
    n.setAttribute('data-specframe', '');
    if (text) n.textContent = text;
    return n;
  };
  const keycap = text => node('span', 'sf-key', text);

  /* ── Hint next to the cursor ──
     "⇧ Shift + drag" while on; hidden during a drag and while a frame is pinned, except over
     a value, where it previews what a click (CSS) and an Alt-click (Tailwind) copy. */
  const hint = { el: null, pos: null, raf: 0, busy: false, copy: null, inWindow: true };

  function fillHint() {
    if (!hint.el) return;
    if (hint.copy) {
      hint.el.replaceChildren(
        keycap('Click'), node('span', 'sf-code', hint.copy.css),
        keycap('Alt'), node('span', 'sf-code', hint.copy.tw),
      );
    } else {
      hint.el.replaceChildren(keycap(KEY_LABEL), node('span', 'sf-text', '+ drag'));
    }
    if (hint.pos) placeHint();
  }

  function showHint() {
    hint.el = node('div', 'sf-glass sf-hint');
    hint.el.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(hint.el);
    fillHint();
    addEventListener('pointermove', onHintMove, true);
    document.documentElement.addEventListener('mouseleave', onHintLeave);
  }

  function onHintMove(e) {
    if (hint.copy && hint.pos) return; // a copy preview stays put while over its value
    hint.pos = { x: e.clientX, y: e.clientY };
    hint.inWindow = true;
    if (!hint.raf) hint.raf = requestAnimationFrame(placeHint);
  }

  const onHintLeave = () => {
    hint.inWindow = false;
    updateHintVisibility();
  };

  function updateHintVisibility() {
    if (!hint.el) return;
    hint.el.classList.toggle('sf-show', !!hint.pos && hint.inWindow && (hint.copy ? true : !hint.busy));
  }

  // Below-right of the cursor; flips left / up near the window edges. A copy preview sits
  // above a label (below the type panel, which is under the frame), or on the other side
  // if there's no room, so it never covers what you're choosing.
  function placeHint() {
    hint.raf = 0;
    if (!hint.el || !hint.pos) return;
    const w = hint.el.offsetWidth, h = hint.el.offsetHeight;
    let x, y;
    const r = hint.copy && hint.copy.rect;
    if (r) {
      x = Math.min(Math.max(4, (r.left + r.right) / 2 - w / 2), innerWidth - 4 - w);
      const above = r.top - 8 - h, below = r.bottom + 8;
      const roomAbove = above >= 4, roomBelow = below + h <= innerHeight - 4;
      y = hint.copy.panel ? (roomBelow || !roomAbove ? below : above) : (roomAbove || !roomBelow ? above : below);
    } else {
      x = hint.pos.x + CURSOR_GAP;
      y = hint.pos.y + CURSOR_GAP;
      if (x + w > innerWidth - 4) x = hint.pos.x - CURSOR_GAP - w;
      if (y + h > innerHeight - 4) y = hint.pos.y - CURSOR_GAP - h;
    }
    hint.el.style.setProperty('transform', `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`, 'important');
    updateHintVisibility();
  }

  function removeHint() {
    if (!hint.el) return;
    removeEventListener('pointermove', onHintMove, true);
    document.documentElement.removeEventListener('mouseleave', onHintLeave);
    cancelAnimationFrame(hint.raf);
    hint.el.remove();
    Object.assign(hint, { el: null, pos: null, raf: 0, busy: false, copy: null, inWindow: true });
  }

  /* ── Status toast at the bottom of the window ── */
  let toastEl = null, toastTimer = 0;

  function toast(parts) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = node('div', 'sf-glass sf-toast');
      toastEl.setAttribute('role', 'status');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.replaceChildren(node('span', 'sf-dot-mark'));
    for (const part of parts) {
      toastEl.appendChild(part.key ? keycap(part.key) : part.code ? node('span', 'sf-key sf-mono', part.code) : node('span', 'sf-text', part));
    }
    clearTimeout(toastTimer);
    toastEl.classList.remove('sf-show');
    void toastEl.offsetWidth; // restart the slide-in
    toastEl.classList.add('sf-show');
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('sf-show'), 2600);
  }

  /* ── On / off ── */
  let session = null, explained = false;
  const short = (text, max = 64) => text.length > max ? text.slice(0, max - 1) + '…' : text;
  const setBusy = busy => { hint.busy = busy; updateHintVisibility(); };
  const setCopy = copy => {
    const was = hint.copy;
    hint.copy = copy;
    if (!copy && was) hint.pos = null; // back to following the cursor from its next move
    fillHint();
    updateHintVisibility();
  };

  window.__specframe = {
    isOn: () => !!session,
    toggle() {
      if (session) {
        session.stop();
        session = null;
        removeHint();
        toast(['Specframe off']);
        return false;
      }
      session = window.SpecframeEngine.start({
        onDragStart: () => setBusy(true),
        onPin: () => {
          setBusy(true);
          if (explained) return;
          explained = true; // once per page: how to use a pinned frame
          toast(['Click a value to copy CSS,', { key: 'Alt' }, 'for Tailwind,', { key: 'Esc' }, 'to close']);
        },
        onClose: () => { setCopy(null); setBusy(false); },
        onHover: copy => setCopy(copy),
        onCopy: r => toast(r.ok ? ['Copied', { code: short(r.text) }] : ["Couldn't copy: this page blocks the clipboard"]),
      });
      showHint();
      toast(['Specframe on: hold', { key: KEY_LABEL }, 'and drag']);
      return true;
    },
  };
})();
