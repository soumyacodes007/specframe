// Try Specframe on a real website without installing it.
// Starts a headless Edge/Chrome with a throwaway profile, opens the page, injects the
// extension's own files (as the toolbar button does), performs a real Shift + drag over
// the element you pick, then tries the pinned frame: hovers a value, copies it as CSS
// (click) and as Tailwind (Alt-click), and copies a type style. Saves screenshots and
// prints what landed on the clipboard.
//
//   node tools/try-on-site.js <url> <selector | text=… | rect=x1,y1,x2,y2> [out-dir] [--width 1440] [--height 900]
//
// Needs Node 22+ (built-in WebSocket) and Edge or Chrome.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : Number(args.splice(i, 2)[1]); };
const WIDTH = flag('--width', 1440), HEIGHT = flag('--height', 900);
const [url, selector, outArg] = args;
if (!url || !selector) {
  console.error('usage: node tools/try-on-site.js <url> <css selector> [out-dir]');
  process.exit(1);
}
const OUT = path.resolve(outArg || 'screenshots');
const EXT = path.join(__dirname, '..', 'extension');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) throw new Error('No Edge or Chrome found');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'specframe-profile-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find(t => t.type === 'page');
      } catch {}
    }
    if (!target) throw new Error('Browser did not start');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map(), waiters = [];
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        for (const w of waiters.splice(0)) w.method === msg.method ? w.res(msg.params) : waiters.push(w);
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const once = method => new Promise(res => waiters.push({ method, res }));
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async name => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log('saved', file);
    };

    fs.mkdirSync(OUT, { recursive: true });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    // Same effect as chrome.scripting: the page's CSP doesn't apply to what the extension injects
    await send('Page.setBypassCSP', { enabled: true });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // clipboard needs a focused page
    // Some sites serve "HeadlessChrome" a stripped-down page; present as the regular browser
    const { userAgent } = await send('Browser.getVersion');
    await send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') });
    await send('Browser.grantPermissions', {
      origin: new URL(url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});
    const loaded = once('Page.loadEventFired');
    await send('Page.navigate', { url });
    await Promise.race([loaded, sleep(20000)]);
    await sleep(2500); // let fonts, images and client rendering settle
    // Scroll through the page once so lazily rendered sections exist, then back to the top
    await evaluate(`(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) {
        scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 800));
    })()`);

    const read = f => fs.readFileSync(path.join(EXT, f), 'utf8');
    await evaluate(`(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(read('overlay.css'))});
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    })()`);
    await evaluate(read('engine.js'));
    await evaluate(read('page.js'));
    if (!(await evaluate('window.__specframe.toggle()'))) throw new Error('Specframe did not turn on');

    // Find the element, bring it into view, frame it with a little margin
    // "text=Some words" frames the closest card-like ancestor (border, background or shadow,
    // at least 200 × 80) of the element showing that text; anything else is a CSS selector.
    // "rect=x1,y1,x2,y2" drags exactly over those viewport coordinates (page scrolled to the top).
    const rectArg = /^rect=([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(selector);
    const r = rectArg ? (([, a, b, c, d]) => ({ x1: +a - 6, y1: +b - 6, x2: +c + 6, y2: +d + 6 }))(rectArg) : await evaluate(`(async () => {
      const want = ${JSON.stringify(selector)};
      let el = null;
      if (want.startsWith('text=')) {
        const needle = want.slice(5).toLowerCase();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = walker.nextNode());) {
          if (!n.nodeValue.toLowerCase().includes(needle)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const tr = range.getBoundingClientRect();
          if (tr.width < 1 || tr.height < 1 || !n.parentElement.checkVisibility()) continue;
          for (let e = n.parentElement; e && e !== document.body; e = e.parentElement) {
            const s = getComputedStyle(e), b = e.getBoundingClientRect();
            if (b.width > innerWidth * 0.8 || b.height > innerHeight * 0.8) break;
            const surface = parseFloat(s.borderTopWidth) > 0 || !/^(transparent|rgba\\(0, 0, 0, 0\\))$/.test(s.backgroundColor) || s.boxShadow !== 'none';
            if (surface && b.width >= 200 && b.height >= 80) { el = e; break; }
          }
          if (el) break;
        }
      } else {
        el = document.querySelector(want);
      }
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 600));
      const b = el.getBoundingClientRect();
      return { x1: b.left, y1: b.top, x2: b.right, y2: b.bottom };
    })()`);
    if (!r) throw new Error(`No element matches ${selector}`);
    const clampX = v => Math.max(2, Math.min(WIDTH - 3, v)), clampY = v => Math.max(2, Math.min(HEIGHT - 40, v));
    const from = { x: clampX(r.x1 + 6), y: clampY(r.y1 + 6) };
    const to = { x: clampX(r.x2 - 6), y: clampY(r.y2 - 6) };

    const SHIFT = 8;
    const mouse = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers: SHIFT, ...extra });
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: SHIFT });
    await mouse('mouseMoved', { x: from.x - 30, y: from.y - 30 });
    await sleep(200);
    await shot('1-hint.png');
    await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await mouse('mouseMoved', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, { button: 'left', buttons: 1 });
      await sleep(16);
    }
    await sleep(900); // measurements draw themselves in
    await shot('2-measure.png');
    if (process.env.SPECFRAME_DEBUG) {
      console.log(JSON.stringify(await evaluate(`[...document.querySelectorAll('svg.sf-overlay .sf-pill')].map(g => {
        const r = g.querySelector('rect');
        return { label: g.textContent, x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'),
          hidden: getComputedStyle(g.parentNode).visibility === 'hidden' };
      })`)));
    }
    await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 });
    await sleep(500);
    await shot('3-pinned.png');

    // Copy from the pinned frame: a value (an off-grid one if there is one) and a type style
    const plain = (type, p, extra = {}) => send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, modifiers: 0, ...extra });
    const click = async (p, modifiers = 0) => {
      await plain('mouseMoved', p);
      await sleep(120);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, modifiers });
      await sleep(300);
      return evaluate('navigator.clipboard.readText().catch(e => "(clipboard unreadable: " + e.message + ")")');
    };
    const targets = await evaluate(`(() => {
      const centre = n => { const r = n.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
      const pills = [...document.querySelectorAll('svg.sf-overlay .sf-pill[data-sf-copy]')]
        .filter(g => g.style.display !== 'none' && getComputedStyle(g.parentNode).visibility !== 'hidden')
        .map(g => ({ g, at: centre(g), off: g.classList.contains('sf-off'), label: g.textContent }))
        // only labels you can actually click: drawn inside the frame, not under anything else
        .filter(p => p.at && document.elementFromPoint(p.at.x, p.at.y)?.closest('[data-sf-copy]') === p.g)
        .map(({ g, ...p }) => p);
      const pill = pills.find(p => p.off) || pills[0] || null;
      const row = document.querySelector('.sf-types.sf-show .sf-row');
      return {
        pill, row: row && centre(row),
        offGrid: pills.filter(p => p.off).map(p => p.label),
        types: [...document.querySelectorAll('.sf-types .sf-row')].map(r => r.textContent),
      };
    })()`);
    const result = { offGrid: targets.offGrid, types: targets.types };
    if (targets.pill) {
      await plain('mouseMoved', targets.pill.at);
      await sleep(250);
      await shot('4-copy-hint.png');
      result.copiedCss = await click(targets.pill.at);
      result.copiedTailwind = await click(targets.pill.at, 1); // Alt
      await shot('5-copied.png');
    }
    if (targets.row) {
      await plain('mouseMoved', targets.row);
      await sleep(250);
      await shot('6-type-hover.png');
      result.copiedType = await click(targets.row);
      result.copiedTypeTailwind = await click(targets.row, 1);
    }
    result.stillPinned = await evaluate("document.querySelector('svg.sf-overlay').classList.contains('sf-pinned')");
    // A pinned frame should move with the page when it scrolls
    result.frameMovesWithScroll = await evaluate(`(async () => {
      const frameY = () => document.querySelector('svg.sf-overlay .sf-frame').getBoundingClientRect().top;
      const before = frameY(), y0 = scrollY;
      scrollBy(0, 120);
      await new Promise(r => setTimeout(r, 250));
      const scrolled = scrollY - y0, moved = before - frameY();
      scrollBy(0, -scrolled);
      await new Promise(r => setTimeout(r, 250));
      return { scrolled, moved: Math.round(moved) };
    })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
    result.closedByEsc = await evaluate("!document.querySelector('svg.sf-overlay').classList.contains('sf-open')");
    const toggledOff = await evaluate('window.__specframe.toggle()');
    await sleep(300);
    await shot('7-off-toast.png');
    console.log(JSON.stringify({ url, selector, frame: { from, to }, ...result, turnedOff: toggledOff === false }, null, 2));
    ws.close();
  } finally {
    browser.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
