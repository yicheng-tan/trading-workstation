# Trading Workstation

A browser-based market-data workstation for traders who run dozens of
panels across several monitors, on **live Binance Spot production data**
(public endpoints, no API key). This is market data only: order entry,
positions and testnet are out of scope, per the brief.

## How to run it

```bash
npm install
npm run dev     # http://localhost:5173
```

Node 20.15+ runs the app (tested on Node 26). The helper scripts
(`smoke`, `bench`, `record:sample`) need Node 22+ for its built-in
`WebSocket`. Docker works too: `docker build -t tw . && docker run -p 5173:5173 tw`.

| Command | What it does |
|---|---|
| `npm test` | 146 unit tests (Vitest) |
| `npm run typecheck` / `npm run lint` | strict TypeScript; ESLint |
| `npm run smoke` | builds, then drives real headless Chrome against live Binance (17 end-to-end checks) |
| `npm run bench` | the smoke run plus two 60s in-app benchmarks; writes `perf-results/` |
| `npm run record:sample -- btcusdt,ethusdt 30 out.ndjson` | records our own replay sample |

`smoke`/`bench` need a local Chrome, Chromium or Edge (`CHROME_PATH` if it
isn't found). To test a running dev server instead, run
`node scripts/smoke.mjs http://localhost:5173/`.

## What a trader gets

**Panels:** order book (depth ladder), time & sales, candlestick chart and
watchlist. Any panel can show any symbol, and you can open as many of each
as you like.

- **Order book:** cumulative depth bars and a spread row showing mid,
  spread and spread in bps. A selector sets price grouping from 0.1× to 100×
  the default bucket.
- **Time & sales:** newest first, coloured by aggressor side. Prints above
  $50k notional are highlighted.
- **Chart:** opens with 500 bars of history and live in-progress candles,
  with intervals from 1m to 1d.
- **Watchlist:** last price, 24h change, high, low and quote volume. You can
  add or remove symbols in place, prices flash on change, and clicking a
  row drives the watchlist's link group.

**Workspace UX choices**, and why:

- **Link groups A–D are colour-coded** on each tab and panel header. With 30
  panels on screen you need to see which ones move together without
  reading dropdowns. The colours avoid red, green and amber, which already
  mean sell, buy and stale.
- **Dense chrome.** The dock tab names the panel, so the header holds only
  the symbol, link group and status. The data-source note appears once in
  the toolbar, not on every panel, and chart intervals overlay the plot.
  Every pixel goes to data.
- **Symbol entry is forgiving but strict.** Every symbol field autocompletes
  from Binance's tradable-symbol list and accepts shorthand: `btc`,
  `eth/usdt` and `ETH-USDT` all resolve. Unknown symbols are rejected, so
  no panel is left on a stream that will never arrive. Enter commits and
  Escape cancels.
- **Every panel shows a status badge: Live, Stale, Reconnecting or
  Offline.** A trader must never mistake frozen data for a quiet market.
- **Pop-outs** (⇗ on a tab) are real OS windows that stay live and linked,
  and can be dragged to any monitor. "Return to main window" docks their
  panels back. ⧉ duplicates a panel.
- **Layouts** capture every window: the grid arrangement, pop-out bounds,
  and each panel's symbol, link group and settings. You can save, rename,
  delete, load, set a default (opened on launch) and export/import
  versioned JSON ([schema](src/workspace/LAYOUT_SCHEMA.md)). The workspace
  also autosaves, so a reload never loses work.
- **Stress tools** live behind a toggle: replay our recording at 1–50×,
  drop the connection, or inject a sequence gap. A performance overlay
  shows fps, frame time, long tasks, latency and heap, and runs a 60s
  benchmark ([PERF.md](PERF.md)).

## Data: streams and endpoints

| Need | Source | Why |
|---|---|---|
| Order book | `<sym>@depth@100ms` + `GET /api/v3/depth?limit=1000` (weight 50) | Binance's documented local-book procedure. A 100ms diff cadence is plenty for human eyes; 1000 levels leave room for coarse grouping. |
| Trades | `<sym>@aggTrade` + `GET /api/v3/aggTrades` (weight 4) for the first 200 prints | Aggregated by price and aggressor, which is the tape traders read. The backfill means a quiet symbol isn't blank. |
| Candles | `<sym>@kline_<i>` + `GET /api/v3/klines?limit=500` (weight 2) | Live in-progress bar plus history. |
| Watchlist | `!miniTicker@arr` | One stream for every symbol at about 1/s, enough for a watchlist and far fewer streams than one per symbol. |
| Symbol list | `GET /api/v3/exchangeInfo?symbolStatus=TRADING` (weight 20, cached for a day) | Autocomplete and validation. |
| Clock skew | `GET /api/v3/time` (weight 1) | Corrects the latency metric. |

Everything goes over **one** `/ws` socket, using `SUBSCRIBE`/`UNSUBSCRIBE`
frames so a symbol change never reconnects. Control messages are capped
at 5/s and streams at 1024 per connection. Depth resyncs back off
exponentially (1s to 30s) per symbol, and a 429/418 response pauses every
depth snapshot (the weight-50 calls) for `Retry-After`. The reference 30-panel restore costs about
600 of the 6,000/min weight budget. If `stream.binance.com` fails
repeatedly, the hub fails over to `data-stream.binance.vision`.

## Architecture

```
 main window ─┐                          ┌─ Binance /ws (one socket)
 pop-out 1 ───┼─ MessagePort ─ SharedWorker DataHub ─┤
 pop-out N ───┘   (per window)           └─ Binance REST (budgeted)
```

- **`SharedWorker` data hub** (`src/core/hub/DataHub.ts`). Every window is
  the same bundle and opens its own port to one hub. So 30 panels across
  any number of windows share one socket, a pop-out needs no bridge to its
  opener, and closing the main window doesn't kill pop-outs.
- **`OrderBookManager`** implements Binance's sync procedure exactly:
  1. Buffer diffs until a snapshot arrives.
  2. Require the first applied diff to straddle the snapshot's
     `lastUpdateId`.
  3. Apply only contiguous diffs after that.

  On a gap it marks the book Stale, keeps the last good state, and resyncs
  from REST.
- **`SubscriptionManager`** ref-counts streams across all panels and
  windows, and batches subscribes. **`ReconnectPolicy`** handles jittered
  backoff, host failover and the proactive reconnect before Binance's 24h
  disconnect.
- **Backpressure** (`PortBackpressureGate`). Each window has at most one
  unacknowledged update per stream, and newer state replaces it (latest
  state wins). A slow or background window can't build a backlog or slow
  the others.
- **Rendering.** The ladder and tape draw on `<canvas>` from a ref inside
  one `requestAnimationFrame` loop. Tick data never touches React state,
  so 50 updates in a frame cost one paint. Charts use lightweight-charts'
  imperative `update()`. React handles only the chrome.
- **Workspace.** dockview-core is driven imperatively, and panels render
  into its elements through React portals, so they share app context. Link
  groups cross windows over a `BroadcastChannel`. Pop-outs report their
  panels and bounds to the main window over another channel, so layouts
  can capture them.

## Key trade-offs

- **Latest state wins over exactly-once delivery.** Every stream delivers
  the current full state, so a slow consumer catches up instead of
  silently dropping deltas. The order book's `U`/`u` sequence is the one
  thing integrity-checked explicitly.
- **Canvas + rAF over a DOM row per price level**, to hold up at the
  30-panel scale. The cost is hand-written drawing and text layout.
- **A `SharedWorker` over a leader-elected socket.** It's the only browser
  primitive that gives every same-origin window one connection with no
  election logic. The cost is no mobile Safari or Chrome Android, which
  doesn't matter for a multi-monitor desktop tool.
- **Our own pop-out windows over dockview's built-in pop-out groups.**
  Those run in the opener's JavaScript context, so they die with the main
  window and share its main thread.
- **Quiet is not stale for a tape.** A trade stream has no sequence to
  check, and silence is just the market. So the tape only shows
  Reconnecting or Offline when the connection is actually down. The order
  book has real gap detection.
- **A zero-dependency CDP smoke test over Playwright.** The brief asked
  for no unrequested dependencies. The test speaks the DevTools protocol
  over Node's built-in `WebSocket`, against real Chrome, real pop-outs and
  real Binance.
- **Stack:**
  - React 19 for the chrome.
  - dockview for docking: zero dependencies, with a serializable layout.
  - lightweight-charts for candles: small and canvas-based. Its logo is
    TradingView's, not Binance's.
  - zod to validate imported layouts, which are untrusted input.
  - Vite for one-command dev and worker bundling.

## How work was split across agents

One Cursor chat acted as orchestrator. All transcripts are exported
(redacted) in [`docs/agent-sessions/`](docs/agent-sessions/).

1. **Requirements and contracts.** Read the PRD, asked clarifying
   questions up front, and fixed the shared contracts: domain types, the
   hub wire protocol, the client facade and the panel registry.
2. **TDD red phase.** Wrote 106 failing tests from the PRD before any
   implementation existed.
3. **Four parallel subagents**, each with strict, non-overlapping file
   ownership:
   - the data hub
   - the panels
   - the workspace and layouts
   - performance and replay
4. **Integration** by the orchestrator: fixed protocol gaps, wired replay
   and fault injection end to end, and built the app shell.
5. **Review against the PRD in a real browser.** The headless-Chrome smoke
   test found bugs that unit tests couldn't. Examples: panels lost React
   context, StrictMode closed ports, replay couldn't sync a book, the tape
   duplicated prints, layouts dropped pop-outs, sub-cent prices collapsed
   the ladder, and the latency metric was really measuring clock skew. All
   were fixed, with tests.
6. **QoL pass by two concurrent agents** working on disjoint files:
   - One did symbol entry, session autosave, watchlist editing and
     duplicate panels.
   - The other did link-group colours, compact chrome, order-book grouping
     and spread in bps, and this README.

   Each agent added smoke checks for its own features.

## Verification

- **Unit tests (146):** order-book sync, rate limits, reconnect and
  failover, backpressure, the layout schema and store, session autosave,
  symbol resolution, hub REST backoff and 429 handling, history backfill,
  replay isolation, and panel calculations.
- **`npm run smoke` (17 checks, real Chrome, live data):**
  - All panels go Live, and link groups propagate.
  - Layout save, set-default and reload restore identically.
  - Pop-outs stay live and linked, are captured in layouts, and return to
    the main window.
  - Replay works, an injected gap goes Stale then resyncs, and a dropped
    connection recovers.
  - A 30-panel / 10-symbol restore shows live data within 5s.
  - Autosave, symbol entry, duplicate panel, watchlist editing, link
    colours and price grouping each have a check.
  - No page or worker exceptions occur.

  It also passes against the dev server with StrictMode on.
- **Latest numbers** ([PERF.md](PERF.md), `perf-results/`):
  - The 30-panel restore shows live data in every panel 733ms after
    navigation in the latest run (0.5–2.3s across runs; target under 5s).
  - Frame time p95 is 7ms, live and at 10× replay. The latest live run had
    one frame over 50ms in 60s; the replay run had none.

## Known gaps

- **The hub posts the full book to each window on every diff**, re-sorting
  and copying up to about 1,000 levels per side. The backpressure gate
  bounds it, and the 30-panel runs stay at the display's frame rate. Sending only the top
  N levels would cut worker CPU several times over.
- **Canvases repaint every frame even when nothing changed.** That's cheap
  at 30 panels, but wasteful when markets are quiet.
- **The latency metric measures the 1s watchlist stream, not our
  pipeline** (see PERF.md).
- **Grouping uses a price-magnitude heuristic, not Binance's
  `PRICE_FILTER` tick size.**
- **No sharding past 1024 streams per connection.** The reference scenario
  uses about 41.
- **Restored pop-outs land on the browser's choice of screen** unless the
  Window Management permission is granted. Browsers also cap pop-ups per
  click, so a banner opens the rest.
- **A gap during replay stays Stale until the loop restarts**, since there
  is no REST to resync recorded data from.
- **The bundle isn't code-split:** about 870KB minified, 245KB gzipped.
- **History backfills ignore a rate-limit pause.** Only depth snapshots
  wait out `Retry-After`. Kline and aggTrade backfills are weight 2–4 and
  sent once per new stream, so the risk is small, but they should share
  the pause.

## What I'd do with another day

1. **Measure our own pipeline latency:** hub receive time to painted frame,
   per panel, on the depth stream. That would turn the 50ms target into a
   real pass/fail.
2. **Cheaper book fan-out:** send only the top N levels, and add per-panel
   dirty flags so idle canvases don't repaint.
3. **Tape integrity:** `aggTrade` ids are sequential, so a jump means missed
   prints. Mark the tape Stale and backfill with `aggTrades?fromId=`.
4. **Real tick and lot sizes** from `exchangeInfo` filters for ladder
   grouping and quantity precision.
5. **Workspace polish:** keyboard shortcuts, layout thumbnails, a built-in
   "30-panel reference" preset, and restoring pop-outs onto their saved
   monitor.
6. **CI:** run `test`, `typecheck`, `lint` and `smoke` on every push.

## Project layout

```
src/core/        framework-agnostic logic (order book, connection, hub, layout, perf, replay, symbols), unit tested
src/worker/      SharedWorker entry
src/panels/      panel components (canvas ladder/tape, chart, watchlist) and shared chrome
src/workspace/   dockview shell, pop-outs, layouts, session autosave
src/perf/        performance overlay, benchmark, stress controls
scripts/         sample recorder; headless-Chrome smoke test and benchmark
public/samples/  our committed replay recording
perf-results/    `npm run bench` output
```
