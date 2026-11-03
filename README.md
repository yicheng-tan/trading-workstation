# Trading Workstation

A web-based market-data workstation for professional traders running many
panels across several monitors, built against **live Binance Spot
production data** (no API key required). Market-data side only, per the
brief — order tickets, order routing, positions and Binance testnet are out
of scope.

## Running it

Requires Node 20.15+ to run the app (tested on Node 26). The helper
scripts (`smoke`, `bench`, `record:sample`) use Node's built-in
`WebSocket`, which needs Node 22+. No API keys of any kind.

```bash
npm install
npm run dev     # http://localhost:5173
```

Other useful commands:

```bash
npm test                     # 126 unit tests (Vitest)
npm run typecheck            # strict TypeScript, app + SharedWorker configs
npm run lint                 # ESLint (TypeScript + React hooks rules)
npm run smoke                # build, then drive real headless Chrome against live Binance (12 end-to-end checks)
npm run bench                # smoke + 30-panel restore timing + two 60s in-app benchmarks -> perf-results/
npm run build && npm run preview   # production build + local preview
npm run record:sample -- btcusdt,ethusdt,solusdt 30 public/samples/replay-sample.ndjson   # re-record OUR OWN replay sample
```

`smoke`/`bench` need a local Chrome, Chromium or Edge (set `CHROME_PATH`
if it isn't found) and use only Node built-ins, with no Playwright or
Puppeteer. `node scripts/smoke.mjs http://localhost:5173/` runs the same
checks against a running dev server.

### Docker

```bash
docker build -t trading-workstation .
docker run -p 5173:5173 trading-workstation
```

## What's implemented

- **Panels**: depth ladder (order book), time & sales (trade tape),
  candlestick chart, watchlist. Any panel can show any symbol; many
  instances of the same panel type can be open at once. Charts open with
  500 bars of REST history and tapes with the latest 200 prints, so a
  freshly opened or restored panel is useful immediately, even on a quiet
  symbol.
- **Symbol linking**: panels assigned to the same link group (None / A / B
  / C / D, via each panel's header) change symbol together, including
  across pop-out windows. A panel that joins a group adopts the group's
  symbol; followers' symbols are persisted, so a saved layout restores
  what was actually on screen.
- **Pop-outs**: any panel can pop out into its own OS window via the ⇗
  button on its tab. Pop-outs stay live and linked — they are not children
  of the main window, they're independent pages that happen to share the
  same data connection (see Architecture). Each pop-out reports its panels
  and screen bounds back to the main window, so saving a layout captures
  it. "⇙ Return to main window" docks its panels back.
- **Layouts**: save, rename, delete, list, and mark-as-default named
  layouts covering every window (main grid arrangement plus every pop-out's
  bounds), panel position/size, symbol, link group, and panel setting.
  Export/import as versioned JSON (schema documented in
  [`src/workspace/LAYOUT_SCHEMA.md`](src/workspace/LAYOUT_SCHEMA.md)). The
  default layout auto-restores on launch; a 30-panel / 10-symbol layout
  shows live data in every panel in about 1s (see `PERF.md`).
- **Performance overlay**: fps, p95 frame time, long-task count, p95
  message-arrival-to-render latency, JS heap (Chromium), live connection
  status — plus a one-click 60s benchmark that downloads a JSON report. See
  [`PERF.md`](PERF.md).
- **Stress testing**: replay our own recorded sample (BTC/ETH/SOL) at
  1×–50× while every other symbol stays live, plus one-click "drop
  connection" and "inject sequence gap" fault buttons, to verify panels
  show a visible stale/reconnecting state and recover.

## Architecture

### One Binance connection, shared by every window

All market data flows through a single `SharedWorker`
(`src/worker/dataHub.worker.ts` → `src/core/hub/DataHub.ts`). Every
window — the main window and every pop-out — is the same app bundle loaded
at the same origin, and each independently opens its own port to that one
`SharedWorker`. This means:

- Opening 30 panels across 10 symbols still uses **one** WebSocket
  connection, well inside Binance's per-IP connection limits.
- A pop-out window needs no bridge back to its opener for data — it's just
  `window.open()` to `?popout=<id>` (panel list handed off via
  `localStorage`, see the contract documented at the top of
  [`windowManager.ts`](src/workspace/windowManager.ts)) — and it gets live,
  linked data on its own. A separate `BroadcastChannel`
  ([`popoutRegistry.ts`](src/workspace/popoutRegistry.ts)) carries only
  workspace state: each pop-out's panels and bounds for saving, plus
  "return to main" and "close" requests.
- Closing the main window doesn't kill pop-outs' data; closing the last
  window of any kind tears down the hub naturally (the browser GCs the
  `SharedWorker` once no port remains).

Inside the hub:

- **`OrderBookManager`** implements Binance's documented local-order-book
  sync procedure exactly: buffer diffs before any snapshot, require the
  first applied diff to straddle the snapshot's `lastUpdateId`, apply
  strictly-contiguous diffs after that, and the moment a gap is detected
  (`next.U !== prev.u + 1`), mark the book **`stale`** and
  `needsResync()` — without blanking or corrupting the last known-good
  state — until a fresh REST snapshot recovers it to `live`.
- **`SubscriptionManager`** ref-counts stream ownership across every panel
  that wants a given stream, batches all newly-needed streams into a
  single `SUBSCRIBE` frame per flush, and enforces Binance's real limits
  (5 messages/sec, 1024 streams/connection).
- **REST is budgeted.** Depth snapshots (`limit=1000`, weight 50) retry
  per symbol with exponential backoff (1s → 30s), so a book that keeps
  desyncing can't hammer the endpoint. A 429/418 response pauses every
  snapshot fetch for `Retry-After`. History backfills (klines weight 2,
  aggTrades weight 4) happen once per new stream. The 30-panel / 10-symbol
  restore costs about 600 of the 6,000/min weight budget.
- **`ReconnectPolicy`** does exponential backoff with jitter, fails over
  primary (`stream.binance.com`) → fallback (`data-stream.binance.vision`)
  after repeated failures, resets backoff once a connection proves stable,
  and proactively reconnects ahead of Binance's 24h forced disconnect.
- **`PortBackpressureGate`** gates delivery to each window: at most one
  in-flight update per (window, stream); anything pushed while still
  waiting for an ack coalesces into a single "latest state wins" payload.
  A slow or backgrounded pop-out can never build backlog or block delivery
  to any other window.
- Subscribing to the control endpoint (`/ws` + `SUBSCRIBE`/`UNSUBSCRIBE`
  frames, not `/stream?streams=...`) means changing a panel's symbol never
  requires reconnecting the whole socket.

The main thread never touches the WebSocket directly — it talks to
`DataHubClient` (`src/core/hub/createDataHubClient.ts`), a typed
subscribe/callback facade over the raw port protocol
(`src/core/hub/protocol.ts`), which auto-acks every delivered update right
after invoking the panel's callback so the backpressure gate is freed
immediately; the actual canvas repaint happens later, decoupled, inside
each panel's own `requestAnimationFrame` loop.

### Rendering — canvas + ref + rAF, not DOM-per-row

The reference scenario is 30 panels across 10 symbols, several receiving
multiple order-book diffs per second each. `DepthLadderPanel` and
`TradeTapePanel` render to `<canvas>` and never call `setState` from a
data-update callback — the latest snapshot is written into a `useRef`, and
a single `requestAnimationFrame` loop (started once per mount) repaints
from whatever's currently in that ref. A burst of 50 updates inside one
frame interval still costs exactly one paint. React state is reserved for
things that actually need a React re-render (symbol text, status badge) —
never for tick-rate data. `CandlestickChartPanel` uses `lightweight-charts`
(imperative `.update()` calls, same reasoning). See the header comment in
[`DepthLadderPanel.tsx`](src/panels/DepthLadderPanel.tsx) for the full
rationale.

### Workspace & pop-outs

The docking shell (`src/workspace/WorkspaceShell.tsx`) is built on
`dockview-core`'s imperative API with a hand-written React bridge — the
installed `dockview@8.8.3` package doesn't ship a `DockviewReact` component
(it's a zero-dependency re-export of the framework-agnostic core only).
Dockview's `createComponent`/`createTabComponent` factories only hand back
an empty DOM element per panel. The shell renders each panel into that
element with a React **portal** from its own tree, rather than a separate
`createRoot` per panel. That way every panel shares the app's context
(data hub, link groups) and re-renders with fresh props when its config
changes. Saving a layout stores dockview's own `toJSON()` for the main
window, so splits, sizes and tab groups come back exactly; layouts without
one are auto-tiled four per row.

Pop-out placement uses the Window Management API (`getScreenDetails()`)
best-effort: since that API is async/permission-gated but `window.open`
must stay synchronous to survive the browser's popup blocker, a window
opens immediately at a cached/default position and gets a non-blocking
`moveTo`/`resizeTo` correction once screen details resolve. Restoring a
layout with several pop-outs opens all of them in one synchronous pass per
click; browsers cap how many `window.open` calls succeed per gesture, so a
heavy layout may come back as "opened: 6, blocked: 2" — the toolbar shows a
"N windows blocked — click to open" banner for the rest, which the PRD
explicitly allows ("a few clicks to start the restore is acceptable").

Link groups propagate across every window (main + pop-outs) via a
same-origin `BroadcastChannel` (`src/workspace/linkGroupBus.ts`) —
independent of the data hub.

### Layouts

`LayoutStore` (`src/core/layout/LayoutStore.ts`) is a small CRUD store over
a pluggable `LayoutStorageAdapter` (localStorage in the app, in-memory in
tests) with zod-validated, versioned documents
(`src/core/layout/schema.ts`). Export/import round-trips through a
`{ exportVersion, exportedAt, layout }` envelope; any document whose
version doesn't match throws a specific `UnsupportedLayoutVersionError`
rather than a generic parse error, so a future schema bump can add a
migration step ahead of the version check instead of mutating v1's shape.
Full field reference: [`LAYOUT_SCHEMA.md`](src/workspace/LAYOUT_SCHEMA.md).

### Stress testing & replay

Per the constraint against using archived Binance datasets,
[`scripts/recordSample.ts`](scripts/recordSample.ts) records a short sample
of our **own** live data (connects directly to Binance's public WebSocket
with Node's built-in `WebSocket`, no extra dependency). It records
`depth@100ms` + `aggTrade` for several symbols, plus one REST depth
snapshot per symbol taken while diffs are already buffering. That's the
same order Binance's local-book procedure uses, so replay can rebuild a
book that is actually consistent. The committed 30s recording
(`public/samples/replay-sample.ndjson`, BTC/ETH/SOL) is what the in-app
"Replay" controls loop through `ReplayEngine`
(`src/core/replay/ReplayEngine.ts`) at 1×–50×, via the same dispatch path
the live socket uses.

Only the recorded symbols switch to replay. Their books and tapes are reset
at the start of every loop and rebuilt from the recording, and their live
depth/trade frames and REST resyncs are suppressed meanwhile; live and
recorded update ids must never mix in one `OrderBookManager`. Every other
symbol, and every chart and watchlist, stays live on the same socket. So
reconnect, backoff and connection status stay real, and "Stop Replay"
resyncs the recorded symbols from live data. "Inject Sequence Gap"
(`injectSequenceGap`) shifts the next depth diff's update-id range for a
symbol to exercise `OrderBookManager`'s resync path on demand; "Drop
Connection" closes the live socket to exercise `ReconnectPolicy`.

## Key trade-offs

- **TDD-first, then parallel subagents.** Before any implementation
  existed, this build wrote 106 failing unit tests across 13 spec files
  pinning down the exact behavior of every safety-critical module (order
  book sync, rate limiting, reconnect/failover, backpressure, layout
  schema/CRUD, perf metrics, replay engine, fault injection, panel
  calculations) directly from the PRD's requirements. Four subagents then
  implemented against those fixed specs in parallel, each restricted to a
  non-overlapping set of files, which is what made true concurrent work
  safe on one working copy.
- **Ack-gated, latest-state-wins delivery** over exactly-once delivery.
  Every stream (order book, trades, candles, watchlist) delivers "here's
  the current full state" rather than a log of deltas; a slow consumer
  catches up to the latest state instead of silently missing individual
  messages with no way to notice. The one exception is the order book's
  own `U`/`u` sequence numbers, which are integrity-checked explicitly.
- **Canvas + ref + rAF** over a React/DOM tree for tick-rate panels,
  specifically to hold up at the 30-panel reference scale — see
  "Rendering" above.
- **Control-frame subscribe/unsubscribe over one long-lived `/ws`
  connection**, not reconnecting via `/stream?streams=...` on every symbol
  change — the latter would mean every panel's symbol change costs a full
  socket reconnect across every window.
- **One bundled recorded sample**, not an archived Binance dataset, per the
  constraint — `scripts/recordSample.ts` is how to make a fresh one.
- **Quiet is not stale for a tape.** The order book has true integrity
  checking (update-id gaps → Stale → resync). A trade tape has no
  sequence to check, and a symbol not printing for 30s is just the market.
  So the tape shows Reconnecting/Offline only when the connection is
  actually down, never "Stale" for silence. Charts and the watchlist keep
  an 8s no-message heuristic, since their streams push on a fixed cadence.
- **A zero-dependency CDP smoke test over Playwright.** The brief asked for
  no unrequested dependencies, so `scripts/smoke.mjs` speaks the DevTools
  protocol over Node's built-in `WebSocket`. It's about 650 lines, but it
  exercises the real thing (real Chrome, real SharedWorker, real pop-out
  windows, real Binance) instead of mocks.

## Stack choices

- **React 19 + TypeScript (strict)** for the shell and panel chrome, where
  React's strengths apply (forms, menus, status badges, portals). Tick-rate
  rendering deliberately bypasses React (canvas + refs + rAF), so React's
  reconciliation cost never scales with message rate.
- **`SharedWorker`** for the data hub, as the only browser primitive that
  gives every same-origin window one shared live connection with no
  leader election. The trade-off is no Safari-on-iOS or Chrome Android
  support, which doesn't matter for a desktop multi-monitor workstation
  (the brief targets Chromium first).
- **dockview** for docking: zero dependencies, a framework-agnostic core,
  tabs/splits/drag-to-dock, and a serializable `toJSON()`/`fromJSON()` that
  layouts can store verbatim. We use our own pop-out windows rather than
  dockview's built-in pop-out groups: those render from the opener's
  JavaScript context, so they die with the main window and share its main
  thread.
- **lightweight-charts** (TradingView, Apache-2.0) for candles: a canvas
  renderer with imperative `update()`/`setData()`, small, and built for
  exactly this kind of live financial chart. Its attribution logo is the
  library's own (TradingView), not Binance branding.
- **zod** for layout documents: an import is untrusted user input, and a
  schema gives readable validation errors plus one source of truth for the
  TypeScript types.
- **Vite** for one-command dev and a production build with first-class
  worker bundling.

## How work was split

This was built in a single Cursor chat session acting as orchestrator, in
four phases:

1. **Requirements analysis & architecture.** Read the PRD, asked
   clarifying questions up front (live-vs-replay scope, Node version
   target, pop-out architecture, frontend stack, browser target, time
   budget), then designed the shared contracts everything else would build
   against: domain types, the hub↔client wire protocol, the
   `DataHubClient` facade interface, the link-group bus, and the panel
   registry.
2. **TDD red phase.** Wrote 106 failing unit tests (plus the stub source
   files they target) covering every safety-critical module, directly from
   the PRD's requirements — before writing any real implementation.
3. **Four parallel subagents**, each given the PRD, the fixed contracts,
   and a strict, non-overlapping file ownership boundary:
   - **Data hub** — order book sync, connection/subscription management,
     reconnect policy, backpressure, the `SharedWorker` itself.
   - **Panels** — the four panel pure-logic modules and their
     canvas/chart/table React components.
   - **Workspace** — layout schema/store, the dockview-based workspace
     shell, pop-out window management, the layout management UI.
   - **Performance & replay** — perf metrics, the overlay, the benchmark
     runner, the replay engine, fault injection, and the recording script.
4. **Integration**, done by the orchestrator after reviewing each
   subagent's diff and report: fixed a real protocol gap one subagent
   flagged (`CandleUpdateMsg` was missing an `interval` field), found and
   fixed a test-fixture bug that had forced an unnecessarily convoluted
   `LayoutStore.setDefault()` implementation, wired replay mode and fault
   injection end-to-end (none of the four subagents owned both sides of
   that seam), built the missing `main.tsx`/`App.tsx` app shell (pop-out
   routing, provider wiring, mounting the perf overlay and stress
   controls), and fixed a link-group round-trip gap into saved layouts —
   verifying the whole thing with the full test suite, strict typecheck,
   and a real production build after every change. (The "smoke test" at
   that point was only HTTP checks that the app shell and worker loaded.)
5. **Review against the PRD, then fixes verified in a real browser.** A
   line-by-line code review against the brief, followed by driving the
   app in headless Chrome, found problems that unit tests and HTTP checks
   couldn't see:
   - Panels in the main window crashed, because separate `createRoot`s
     lost React context.
   - StrictMode's double effect run closed the hub port, and closed the
     link-group channel.
   - Replay called `fetch` unbound ("Illegal invocation"). Even when
     fixed, it could never sync a book, because the recording had no
     snapshot.
   - The tape duplicated prints.
   - Layouts dropped the real arrangement and every pop-out.
   - Followers' symbols weren't persisted.
   - There was no REST backoff, and chart history never reached the chart.
   - Auto-tiling nested every row into the first column.
   - Sub-cent symbols collapsed the order book.
   - The latency metric was really measuring row age plus a 4.85s clock
     skew.

   Each fix landed with unit tests where the logic is testable
   (`DataHub.test.ts` is new). `scripts/smoke.mjs` now re-checks the
   user-facing behavior end to end; see "Verification" below.

## Verification

- `npm test`: 126 unit tests. They cover the order-book sync procedure,
  rate limits, reconnect/failover, backpressure, layout schema and store,
  perf math, replay, and the hub's REST backoff, 429 handling, history
  backfills and replay isolation.
- `npm run smoke`: 12 end-to-end checks in real headless Chrome on live
  Binance data, against the production build:
  1. Every panel kind goes Live, and the chart gets history.
  2. Link groups propagate symbol changes, and unlinked panels are
     untouched.
  3. Save a layout, set it as default and reload: the same panels,
     pixel positions, symbols and groups come back.
  4. A pop-out opens Live, follows a symbol change made in the main
     window, is captured in a saved layout with its bounds, and returns
     to the main window.
  5. Replay serves the recorded book and trades, then returns to live.
  6. An injected gap goes Stale, then resyncs.
  7. A dropped connection shows Reconnecting, then every panel recovers.
  8. A 30-panel / 10-symbol default layout shows live data everywhere
     within 5s.
  9. No page or worker exceptions occur.

  It also passes against the dev server, with StrictMode on.
- `npm run bench`: the same, plus the in-app 60s benchmark. Results are
  in [`PERF.md`](PERF.md) and `perf-results/`.

## Known gaps

- **The hub posts the full book on every diff.** Each depth update
  re-sorts both sides and structured-clones every level (up to ~1,000 per
  side) to each subscribed window. The latest-state-wins gate bounds this
  to one in-flight message per window per stream, and the 30-panel run
  shows no long tasks. But sending only the visible top N levels, or
  deltas, would cut worker CPU and copy cost several times over.
- **Canvas panels repaint every animation frame**, even when nothing
  changed. That's cheap at 30 panels (0 long tasks), but a dirty flag
  would idle the GPU and battery when markets are quiet.
- **The watchlist rides `!miniTicker@arr`** (every symbol on the
  exchange, about 1/s). It's simple and one stream, but every watchlist
  window receives all rows. Per-symbol `@miniTicker` streams would be
  leaner for short lists.
- **No symbol validation.** Typing a symbol that doesn't exist leaves the
  panel on "Reconnecting" rather than saying "unknown symbol". Fix:
  validate against `exchangeInfo` once at startup.
- **The latency metric bounds the stream, not our pipeline** (see
  `PERF.md`). It's clock-corrected exchange-event → receipt on a 1s-cadence
  stream.
- **No sharding past Binance's 1024-streams/connection cap.** Not needed
  at the 30-panel/10-symbol reference scale (~41 streams), but the next
  step for a workstation that needs hundreds of symbols.
- **Pop-outs restored from a layout open at their saved bounds, but on
  the browser's choice of screen** unless the Window Management permission
  was granted. Browsers also cap pop-ups per click; the "N blocked — click
  to open" banner handles the rest.
- **A gap during replay stays Stale until the loop restarts.** There is
  no REST to resync from for recorded data; that's by design.
- **Main bundle isn't code-split** (~860KB minified, ~240KB gzipped) —
  fine functionally, a candidate for `dynamic import()`/`manualChunks` if
  initial load time mattered more than build simplicity here.

## What I'd do with another day

1. **Measure our own pipeline latency.** The hub would stamp its receive
   time on each message, and the client would record receipt → painted
   frame, per panel kind, on the depth stream rather than the 1s ticker.
   That turns the 50ms target into a real pass/fail.
2. **Cheaper order-book fan-out:** send the top N levels each panel can
   display (plus spread/mid), and track a per-panel dirty flag so canvases
   only repaint on change.
3. **Trade-tape continuity checks.** `aggTrade` ids are sequential per
   symbol, so a jump means missed prints. Mark the tape Stale and backfill
   via `aggTrades?fromId=`. That gives the tape the same integrity
   guarantee the book has.
4. **Symbol search and validation** from `exchangeInfo`: autocomplete,
   tick-size-aware ladder grouping (Binance's real `PRICE_FILTER` instead
   of a magnitude heuristic), and an explicit "unknown symbol" state.
5. **Layout UX:** an in-app "reference 30-panel" preset, layout
   thumbnails, and restoring pop-outs onto their saved monitor by default
   once Window Management permission is granted.
6. **CI:** run `npm test`, `npm run typecheck`, `npm run lint` and
   `npm run smoke` on every push (headless Chrome is available on GitHub
   runners).

## Project layout

```
src/core/            framework-agnostic logic (order book, connection, hub protocol, layout, perf, replay, panel calc) — fully unit tested
src/worker/          the SharedWorker entry point
src/panels/          React/canvas panel components
src/workspace/        dockview shell, pop-out window management, layout UI
src/perf/            performance overlay, benchmark runner, stress controls
src/app/              app shell: main-window vs pop-out routing
scripts/             record a replay sample; headless-Chrome smoke test + benchmark (smoke.mjs); guided manual benchmark
public/samples/      one committed recorded sample used by replay mode
perf-results/        benchmark output from `npm run bench`
```
