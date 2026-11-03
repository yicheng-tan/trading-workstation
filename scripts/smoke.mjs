#!/usr/bin/env node
/**
 * End-to-end smoke test in real headless Chrome against live Binance data.
 * Zero dependencies: drives Chrome over the DevTools protocol using Node's
 * built-in WebSocket/fetch (Node 22+).
 *
 *   npm run smoke                              # builds, serves dist/ with `vite preview`, runs every check
 *   node scripts/smoke.mjs http://localhost:5173/   # against an already-running dev/preview server
 *   npm run bench                              # the same, plus the in-app 60s benchmark on the
 *                                              # 30-panel scenario (live, then 10x replay) -> perf-results/
 *
 * Set CHROME_PATH if Chrome/Chromium/Edge isn't found automatically.
 *
 * Checks: every panel kind goes Live; chart history backfill; symbol linking
 * (in-window and into a pop-out); save + set default + reload restores the
 * same panels/positions/symbols/groups; pop-outs open live, are captured in
 * saved layouts and can return to the main window; replay switches the
 * recorded symbols to recorded data and back to live; an injected sequence
 * gap goes stale and recovers; a dropped connection reconnects; and no page
 * or worker exceptions along the way.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREVIEW_PORT = 4319;
const DEBUG_PORT = 9341;
const SYMBOLS_10 = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT', 'SUIUSDT', 'PEPEUSDT', 'ADAUSDT', 'LINKUSDT'];

// ---------------------------------------------------------------------------
// Chrome + server processes
// ---------------------------------------------------------------------------

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates =
    process.platform === 'win32'
      ? [
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(
            (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim(),
          );
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH.');
  return found;
}

async function startPreviewServer() {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    stdio: 'ignore',
  });
  const url = `http://localhost:${PREVIEW_PORT}/`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return { server, url };
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  server.kill();
  throw new Error('vite preview did not start (did the build run?)');
}

// ---------------------------------------------------------------------------
// Minimal CDP client over one browser-level socket (flattened sessions)
// ---------------------------------------------------------------------------

class Browser {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    };
  }

  static async connect(port) {
    let wsUrl;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      try {
        wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
      } catch {
        await sleep(250);
      }
    }
    if (!wsUrl) throw new Error('Chrome DevTools endpoint did not come up.');
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Browser(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) {
    this.listeners.push(fn);
  }
}

/** Page helpers evaluated in the page before each expression. */
const PAGE_HELPERS = `
  const $panels = () => [...document.querySelectorAll('[role=status][aria-label^="Status:"]')].map((st) => {
    const header = st.parentElement;
    const r = header.getBoundingClientRect();
    return {
      title: header.children[0].textContent,
      symbol: header.querySelector('input[aria-label=Symbol]').value,
      group: header.querySelector('select[aria-label="Link group"]').value,
      status: st.getAttribute('aria-label').replace('Status: ', ''),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    };
  });
  const $header = (title) => [...document.querySelectorAll('[role=status][aria-label^="Status:"]')]
    .map((st) => st.parentElement).find((h) => h.children[0].textContent === title);
  const $button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text));
  const $setValue = (el, value) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
`;

class Page {
  constructor(browser, sessionId, targetId, label) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.label = label;
    this.promptText = null;
    browser.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Page.javascriptDialogOpening') {
        void browser.send('Page.handleJavaScriptDialog', { accept: true, promptText: this.promptText ?? '' }, sessionId);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        problems.push(`[${label}] exception: ${d.exception?.description ?? d.text}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        problems.push(`[${label}] console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
    });
  }

  static async attach(browser, targetId, label) {
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(browser, sessionId, targetId, label);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    return page;
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${PAGE_HELPERS}\n return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(`[${this.label}] eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  async waitFor(expression, { timeoutMs = 20_000, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await sleep(250);
    }
    const panels = await this.eval('$panels()').catch(() => null);
    const probe = await this.eval('window.__probe?.state ?? null').catch(() => null);
    const workers = (await this.browser.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'shared_worker').map((t) => t.url);
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for: ${label}\n    last value: ${JSON.stringify(last)}\n    [${this.label}] panels: ${JSON.stringify(panels)}` +
        `\n    probe: ${JSON.stringify(probe)?.slice(0, 400)}\n    shared workers: ${JSON.stringify(workers)}`,
    );
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete' && !!document.querySelector('.ws-toolbar, .popout-root')`, { label: 'app shell' });
  }

  panels() {
    return this.eval('$panels()');
  }

  /** Saves a PNG to $SMOKE_SCREENSHOTS/<name>.png when that env var is set. */
  async screenshot(name) {
    const dir = process.env.SMOKE_SCREENSHOTS;
    if (!dir) return;
    await sleep(600); // let canvases paint a few frames
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
  }
}

// ---------------------------------------------------------------------------
// Test steps
// ---------------------------------------------------------------------------

const problems = [];
const results = [];
const benchReports = [];
const BENCH = process.argv.includes('--bench');

async function step(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, note });
    console.log(`  \u2713 ${name} (${Date.now() - started}ms)${note ? ` - ${note}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, note: err.message });
    console.log(`  \u2717 ${name}\n    ${err.message}`);
  }
}

const allLive = (n) => `(() => { const p = $panels(); return p.length === ${n} && p.every((x) => x.status === 'Live') && p; })()`;

/** A raw port to the same SharedWorker hub the app uses, to observe what the hub actually serves. */
const PROBE_INSTALL = (workerUrl) => `(() => {
  if (window.__probe) return true;
  const w = new SharedWorker(${JSON.stringify(workerUrl)}, { type: 'module', name: 'trading-workstation-data-hub' });
  const p = w.port;
  const clientId = 'smoke-probe-' + Math.random().toString(36).slice(2);
  const state = { conn: [], books: {}, bookStatuses: {}, trades: {}, history: {} };
  p.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'connectionStatus') state.conn.push(m.status);
    if (m.type === 'orderBook') {
      state.books[m.book.symbol] = { status: m.book.status, id: m.book.lastUpdateId, levels: m.book.bids.length + m.book.asks.length };
      (state.bookStatuses[m.book.symbol] ??= []).push(m.book.status);
    }
    if (m.type === 'trades') {
      state.trades[m.symbol] = m.trades.length
        ? { n: m.trades.length, newestAgeMs: Date.now() - Math.max(...m.trades.map((t) => t.time)) }
        : { n: 0 };
    }
    if (m.type === 'candleHistory') state.history[m.symbol + ':' + m.interval] = m.candles.length;
    if (typeof m.seq === 'number') p.postMessage({ type: 'ack', clientId, seq: m.seq });
  };
  p.start();
  p.postMessage({ type: 'hello', clientId, windowRole: 'main' });
  let n = 0;
  window.__probe = {
    state,
    sub: (ref) => p.postMessage({ type: 'subscribe', clientId, subId: 's' + ++n, ref }),
  };
  return true;
})()`;

async function main() {
  const targetUrl = process.argv.slice(2).find((a) => !a.startsWith('--'));
  let server = null;
  let appUrl = targetUrl;
  if (!appUrl) {
    ({ server, url: appUrl } = await startPreviewServer());
  }

  const profile = mkdtempSync(join(tmpdir(), 'tw-smoke-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const browser = await Browser.connect(DEBUG_PORT);
    await browser.send('Target.setDiscoverTargets', { discover: true });
    const workerTargets = new Map();
    // A DevTools session keeps a SharedWorker alive after its last client
    // leaves, but Chrome then routes no new connections to it - so detach
    // before reloading, and attach to the fresh worker when it starts.
    const workerSessions = new Set();
    const detachWorkers = async () => {
      for (const sessionId of workerSessions) await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      workerSessions.clear();
      workerTargets.clear();
    };
    browser.on(async (msg) => {
      if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'shared_worker') {
        const info = msg.params.targetInfo;
        workerTargets.set(info.targetId, info.url);
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        workerSessions.add(sessionId);
        browser.on((m) => {
          if (m.sessionId !== sessionId) return;
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            problems.push(`[worker] exception: ${d.exception?.description ?? d.text}`);
          }
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            const text = m.params.args.map((a) => a.value ?? a.description).join(' ');
            // Binance can legitimately reject a REST call; the hub retries. Anything else is a bug.
            if (!/failed to fetch depth snapshot|failed to fetch kline history/.test(text) || /Illegal invocation/.test(text)) {
              problems.push(`[worker] console.error: ${text}`);
            }
          }
        });
        await browser.send('Runtime.enable', {}, sessionId);
        await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
      }
    });

    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const main = await Page.attach(browser, targetId, 'main');
    await main.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    console.log(`Smoke test against ${appUrl}\n`);

    const installProbe = async () => {
      for (let i = 0; i < 40; i++) {
        const workerUrl = [...workerTargets.values()][0];
        if (workerUrl) return main.eval(PROBE_INSTALL(workerUrl));
        await sleep(250);
      }
      throw new Error('hub SharedWorker never started');
    };

    // --- 1. Panels ---------------------------------------------------------
    await step('every panel kind renders and goes Live on real Binance data', async () => {
      await main.navigate(appUrl);
      const started = Date.now();
      for (const kind of ['watchlist', 'depthLadder', 'tradeTape', 'candlestick']) {
        await main.eval(`(() => {
          $setValue(document.querySelector('.ws-toolbar__select'), '${kind}');
          return new Promise((r) => setTimeout(() => { $button('Add panel').click(); r(true); }, 50));
        })()`);
      }
      const panels = await main.waitFor(allLive(4), { label: '4 panels Live' });
      return `${panels.map((p) => p.title).join(', ')} live in ${Date.now() - started}ms`;
    });

    await step('chart is backfilled with REST history', async () => {
      await installProbe();
      await main.eval(`(__probe.sub({ kind: 'kline', symbol: 'BTCUSDT', interval: '1m' }), true)`);
      const n = await main.waitFor(`__probe.state.history['BTCUSDT:1m'] >= 100 && __probe.state.history['BTCUSDT:1m']`, {
        label: 'candleHistory >= 100 candles',
      });
      return `${n} candles`;
    });

    // --- 2. Linking --------------------------------------------------------
    await step('symbol change propagates through a link group (and not to unlinked panels)', async () => {
      await main.eval(`($setValue($header('Order Book').querySelector('select'), 'A'), $setValue($header('Time & Sales').querySelector('select'), 'A'), true)`);
      await main.eval(`($setValue($header('Order Book').querySelector('input'), 'ETHUSDT'), true)`);
      await main.eval(`($header('Order Book').querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true)`);
      const panels = await main.waitFor(
        `(() => { const p = $panels(); const t = p.find((x) => x.title === 'Time & Sales'); return t.symbol === 'ETHUSDT' && t.status === 'Live' && p; })()`,
        { label: 'Time & Sales follows to ETHUSDT and is Live' },
      );
      const chart = panels.find((p) => p.title === 'Chart');
      if (chart.symbol !== 'BTCUSDT') throw new Error(`unlinked chart changed to ${chart.symbol}`);
      await main.screenshot('1-four-panels-linked');
      return 'Order Book -> Time & Sales; Chart untouched';
    });

    // --- 3. Layouts --------------------------------------------------------
    let savedPanels;
    await step('save layout, set as default, reload: same panels, positions, symbols and groups', async () => {
      savedPanels = await main.panels();
      main.promptText = 'Smoke layout';
      await main.eval(`($button('Layouts').click(), true)`);
      await main.waitFor(`!!$button('Save current as new layout')`);
      await main.eval(`($button('Save current as new layout').click(), true)`);
      await main.waitFor(`[...document.querySelectorAll('.layout-panel__name')].some((n) => n.textContent === 'Smoke layout')`);
      await main.eval(`($button('Set default').click(), true)`);
      const stored = await main.eval(`localStorage.getItem('trading-workstation:layouts')`);
      const doc = JSON.parse(stored);
      const layouts = doc.layouts ?? doc;
      const layout = (Array.isArray(layouts) ? layouts : Object.values(layouts)).find((l) => l.name === 'Smoke layout');
      if (!layout?.isDefault) throw new Error('saved layout is not marked default');
      if (!layout.windows[0].arrangement) throw new Error('main window arrangement was not saved');

      await detachWorkers();
      await main.send('Page.reload');
      await sleep(500);
      await main.waitFor(`!!document.querySelector('.ws-toolbar')`);
      const restored = await main.waitFor(allLive(4), { label: 'restored 4 panels Live' });
      const key = (p) => `${p.title}|${p.symbol}|${p.group}|${p.rect.join(',')}`;
      const before = savedPanels.map(key).sort();
      const after = restored.map(key).sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`restored workspace differs\n    before: ${before.join(' ; ')}\n    after:  ${after.join(' ; ')}`);
      }
      return 'identical after reload';
    });

    // --- 4. Pop-outs -------------------------------------------------------
    let popout;
    await step('pop-out opens in its own window, goes Live, and stays linked', async () => {
      const knownTargets = new Set((await browser.send('Target.getTargets')).targetInfos.map((t) => t.targetId));
      await main.eval(`(() => {
        const tab = [...document.querySelectorAll('.ws-tab__title')].find((t) => t.textContent.startsWith('Time & Sales'));
        tab.parentElement.querySelector('button[title^="Pop out"]').click();
        return true;
      })()`);
      let info;
      for (let i = 0; i < 40 && !info; i++) {
        await sleep(250);
        info = (await browser.send('Target.getTargets')).targetInfos.find(
          (t) => t.type === 'page' && !knownTargets.has(t.targetId) && t.url.includes('popout='),
        );
      }
      if (!info) throw new Error('no pop-out window opened');
      popout = await Page.attach(browser, info.targetId, 'popout');
      const inPopout = await popout.waitFor(allLive(1), { label: 'pop-out panel Live' });
      await main.waitFor(allLive(3), { label: 'main window down to 3 panels' });
      if (inPopout[0].symbol !== 'ETHUSDT' || inPopout[0].group !== 'A') throw new Error(`pop-out panel lost its state: ${JSON.stringify(inPopout[0])}`);

      await main.eval(`($setValue($header('Order Book').querySelector('input'), 'SOLUSDT'), true)`);
      await main.eval(`($header('Order Book').querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true)`);
      await popout.waitFor(`(() => { const p = $panels()[0]; return p.symbol === 'SOLUSDT' && p.status === 'Live'; })()`, {
        label: 'pop-out follows SOLUSDT from the main window',
      });
      await popout.screenshot('2-popout');
      return 'Time & Sales popped out, followed SOLUSDT across windows';
    });

    await step('a saved layout captures the pop-out window and its panel', async () => {
      if (!popout) throw new Error('no pop-out (previous step failed)');
      await sleep(2500); // let the pop-out report its bounds
      main.promptText = 'Smoke with pop-out';
      await main.eval(`($button('Layouts').click(), true)`);
      await main.waitFor(`!!$button('Save current as new layout')`);
      await main.eval(`($button('Save current as new layout').click(), true)`);
      await main.waitFor(`[...document.querySelectorAll('.layout-panel__name')].some((n) => n.textContent === 'Smoke with pop-out')`);
      await main.eval(`($button('Layouts').click(), true)`);
      const doc = JSON.parse(await main.eval(`localStorage.getItem('trading-workstation:layouts')`));
      const layouts = doc.layouts ?? doc;
      const layout = (Array.isArray(layouts) ? layouts : Object.values(layouts)).find((l) => l.name === 'Smoke with pop-out');
      const win = layout.windows.find((w) => w.role === 'popout');
      if (!win || !win.bounds || win.panelIds.length !== 1) throw new Error(`pop-out window missing from layout: ${JSON.stringify(layout.windows)}`);
      const panel = layout.panels.find((p) => p.id === win.panelIds[0]);
      if (panel.kind !== 'tradeTape' || panel.symbols[0] !== 'SOLUSDT') throw new Error(`wrong pop-out panel saved: ${JSON.stringify(panel)}`);
      return `pop-out at ${win.bounds.width}x${win.bounds.height}, panel ${panel.kind} ${panel.symbols[0]}`;
    });

    await step('pop-out returns its panel to the main window', async () => {
      if (!popout) throw new Error('no pop-out (previous step failed)');
      await popout.eval(`($button('Return to main').click(), true)`);
      await main.waitFor(allLive(4), { label: 'main window back to 4 Live panels' });
      for (let i = 0; i < 20; i++) {
        const open = (await browser.send('Target.getTargets')).targetInfos.some((t) => t.targetId === popout.targetId);
        if (!open) return 'panel back, pop-out window closed';
        await sleep(250);
      }
      throw new Error('pop-out window did not close');
    });

    // --- 5. Replay + faults ------------------------------------------------
    await step('replay drives the recorded symbols from the recording, then returns to live', async () => {
      await installProbe(); // the reload above dropped the earlier one
      await main.eval(`(__probe.sub({ kind: 'depth', symbol: 'BTCUSDT' }), __probe.sub({ kind: 'aggTrade', symbol: 'BTCUSDT' }), true)`);
      const live = await main.waitFor(`(() => { const b = __probe.state.books.BTCUSDT; const t = __probe.state.trades.BTCUSDT; return b?.status === 'live' && t?.n > 0 && b; })()`, {
        label: 'probe BTCUSDT live',
      });
      await main.eval(`($button('Stress testing').click(), true)`);
      await main.waitFor(`!!$button('10x')`);
      await main.eval(`($button('10x').click(), true)`);
      const replayed = await main.waitFor(
        `(() => { const b = __probe.state.books.BTCUSDT; const t = __probe.state.trades.BTCUSDT; return b?.status === 'live' && b.id < ${live.id} && t?.n > 0 && t.newestAgeMs > 30000 && { book: b, trades: t }; })()`,
        { label: 'BTCUSDT book synced from the recording (older update ids) with recorded trades' },
      );
      await main.eval(`($button('Stop Replay').click(), true)`);
      await main.waitFor(
        `(() => { const b = __probe.state.books.BTCUSDT; const t = __probe.state.trades.BTCUSDT; return b?.status === 'live' && b.id > ${live.id} && t?.n > 0 && t.newestAgeMs < 15000; })()`,
        { label: 'BTCUSDT back on live data' },
      );
      return `recording book id ${replayed.book.id} < live ${live.id}; trades ${Math.round(replayed.trades.newestAgeMs / 1000)}s old`;
    });

    await step('injected sequence gap marks the book stale, then it resyncs', async () => {
      await main.eval(`(__probe.state.bookStatuses.BTCUSDT = [], $button('Inject Sequence Gap').click(), true)`);
      await main.waitFor(`(() => { const s = __probe.state.bookStatuses.BTCUSDT; const i = s.indexOf('stale'); return i >= 0 && s.slice(i).includes('live'); })()`, {
        label: 'stale then live',
      });
      return 'stale -> live';
    });

    await step('dropped connection shows Reconnecting, then every panel recovers', async () => {
      await main.eval(`(__probe.state.conn = [], $button('Drop Connection').click(), true)`);
      await main.waitFor(`(() => { const s = __probe.state.conn; const i = s.indexOf('reconnecting'); return i >= 0 && s.slice(i).includes('live'); })()`, {
        label: 'hub reconnecting then live',
      });
      await main.waitFor(allLive(4), { label: 'all panels Live after reconnect' });
      return 'reconnecting -> live';
    });

    // --- 6. PRD restore target --------------------------------------------
    await step('30-panel / 10-symbol default layout: every panel shows live data within 5s of page load', async () => {
      const now = Date.now();
      const panels = [];
      SYMBOLS_10.forEach((symbol, i) => {
        const kinds = i === SYMBOLS_10.length - 1 ? ['depthLadder', 'tradeTape', 'watchlist'] : ['depthLadder', 'tradeTape', 'candlestick'];
        for (const kind of kinds) {
          panels.push({
            id: `p30-${kind}-${symbol}`,
            kind,
            symbols: kind === 'watchlist' ? SYMBOLS_10 : [symbol],
            linkGroup: null,
            settings: {},
            position: { x: 0, y: 0, width: 400, height: 300 },
          });
        }
      });
      const layout = {
        schemaVersion: 1,
        id: 'smoke-30',
        name: 'Smoke 30 panels',
        isDefault: true,
        createdAt: now,
        updatedAt: now,
        windows: [{ id: 'main', role: 'main', panelIds: panels.map((p) => p.id) }],
        panels,
      };
      await main.eval(`(localStorage.setItem('trading-workstation:layouts', ${JSON.stringify(JSON.stringify([layout]))}), true)`);
      await detachWorkers();
      await main.navigate(appUrl);
      // Timestamps are performance.now(), i.e. ms since this navigation started.
      const t = await main.eval(`new Promise((resolve) => {
        const firstLive = {};
        const tick = () => {
          const p = $panels();
          for (const x of p) if (x.status === 'Live') firstLive[x.title + '|' + x.symbol] ??= performance.now();
          const times = Object.values(firstLive).sort((a, b) => a - b);
          if (p.length === 30 && times.length === 30) {
            const slowest = Object.entries(firstLive).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + ' ' + Math.round(v) + 'ms');
            return resolve({ first: times[0], median: times[14], last: times[29], slowest });
          }
          if (performance.now() > 30000) return resolve({ timeout: true, panels: p.length, live: times.length });
          requestAnimationFrame(tick);
        };
        tick();
      })`);
      if (t.timeout) throw new Error(`only ${t.live}/${t.panels} panels went Live within 30s`);
      await main.screenshot('3-thirty-panels');
      const summary = `first ${Math.round(t.first)}ms, median ${Math.round(t.median)}ms, all 30 ${Math.round(t.last)}ms after navigation`;
      if (t.last > 5000) throw new Error(`too slow: ${summary}; slowest: ${t.slowest.join(', ')}`);
      return summary;
    });

    // --- 7. Optional: in-app 60s benchmark on the 30-panel scenario ---------
    if (BENCH) {
      const downloadDir = mkdtempSync(join(tmpdir(), 'tw-bench-'));
      await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
      const { product } = await browser.send('Browser.getVersion');
      const runOne = async (scenario) => {
        const before = new Set(readdirSync(downloadDir));
        await main.eval(`($button('Run 60s Benchmark') || (document.querySelector('[title="Toggle performance overlay"]').click(), null), true)`);
        await main.waitFor(`!!$button('Run 60s Benchmark')`);
        await main.eval(`($button('Run 60s Benchmark').click(), true)`);
        await main.waitFor(`document.body.textContent.includes('Done - downloaded')`, { timeoutMs: 80_000, label: 'benchmark finished' });
        let file;
        for (let i = 0; i < 20 && !file; i++) {
          file = readdirSync(downloadDir).find((f) => !before.has(f) && f.endsWith('.json'));
          if (!file) await sleep(250);
        }
        if (!file) throw new Error('benchmark report was not downloaded');
        const report = JSON.parse(readFileSync(join(downloadDir, file), 'utf8'));
        await main.eval(`(document.querySelector('[title="Toggle performance overlay"]').click(), true)`); // collapse; clears the "Done" text on reopen
        return { ...report, scenario, environment: { browser: product, headless: true, viewport: '1920x1080', panels: 30, symbols: 10 } };
      };

      await step('benchmark: 30 panels, 10 symbols, live data (60s)', async () => {
        const report = await runOne('30 panels / 10 symbols, live Binance data');
        benchReports.push(report);
        return `fps p50 ${report.fps.p50.toFixed(0)}, frame p95 ${report.frameTimeMs.p95.toFixed(1)}ms, long tasks ${report.longTaskCount}, latency p95 ${report.latencyMs.p95.toFixed(0)}ms`;
      });

      await step('benchmark: same 30 panels with 10x replay on top (60s)', async () => {
        await main.eval(`($button('Stress testing').click(), true)`);
        await main.waitFor(`!!$button('10x')`);
        await main.eval(`($button('10x').click(), $button('Hide stress controls').click(), true)`);
        const report = await runOne('30 panels / 10 symbols, 10x replay of BTC/ETH/SOL + live for the rest');
        await main.eval(`($button('Stress testing').click(), true)`);
        await main.eval(`($button('Stop Replay').click(), $button('Hide stress controls').click(), true)`);
        benchReports.push(report);
        return `fps p50 ${report.fps.p50.toFixed(0)}, frame p95 ${report.frameTimeMs.p95.toFixed(1)}ms, long tasks ${report.longTaskCount}`;
      });
    }

    await step('no page or worker exceptions', async () => {
      if (problems.length > 0) throw new Error(problems.slice(0, 10).join('\n    '));
      return null;
    });
  } finally {
    chrome.kill();
    server?.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Chrome may still hold files briefly on Windows
    }
  }

  if (benchReports.length > 0) {
    mkdirSync('perf-results', { recursive: true });
    const out = join('perf-results', `bench-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`);
    writeFileSync(out, JSON.stringify({ restore: results.find((r) => r.name.startsWith('30-panel'))?.note, reports: benchReports }, null, 2) + '\n');
    console.log(`\nBenchmark reports written to ${out}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
