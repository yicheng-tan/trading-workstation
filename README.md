# Trading Workstation

A web-based market-data workstation for professional traders running many
panels across several monitors, built against **live Binance Spot
production data** (no API key required). Market-data side only, per the
brief — order tickets, order routing, positions and Binance testnet are out
of scope.

## Running it

Requires Node 20.15+ (tested on Node 26). No API keys of any kind.

```bash
npm install
npm run dev     # http://localhost:5173
```

Other useful commands:

```bash
npm test                     # 113 unit tests (Vitest)
npm run typecheck            # strict TypeScript, app + SharedWorker configs
npm run build && npm run preview   # production build + local preview
npm run record:sample -- btcusdt 60   # record a fresh short sample of OUR OWN live data for replay
```

### Docker

```bash
docker build -t trading-workstation .
docker run -p 5173:5173 trading-workstation
```

## What's implemented

- **Panels**: depth ladder (order book), time & sales (trade tape),
  candlestick chart, watchlist. Any panel can show any symbol; many
  instances of the same panel type can be open at once.
- **Symbol linking**: panels assigned to the same link group (None / A / B
  / C / D, via each panel's header) change symbol together, including
  across pop-out windows.
- **Pop-outs**: any panel can pop out into its own OS window via the ⇗
  button on its tab. Pop-outs stay live and linked — they are not children
  of the main window, they're independent pages that happen to share the
  same data connection (see Architecture).
- **Layouts**: save, rename, delete, list, and mark-as-default named
  layouts covering every window, panel position/size, symbol, link group,
  and panel setting. Export/import as versioned JSON (schema documented in
  [`src/workspace/LAYOUT_SCHEMA.md`](src/workspace/LAYOUT_SCHEMA.md)). The
  default layout auto-restores on launch.
- **Performance overlay**: fps, p95 frame time, long-task count, p95
  message-arrival-to-render latency, JS heap (Chromium), live connection
  status — plus a one-click 60s benchmark that downloads a JSON report. See
  [`PERF.md`](PERF.md).
- **Stress testing**: replay our own recorded sample at 1×–50×, plus
  one-click "drop connection" and "inject sequence gap" fault buttons, to
  verify panels show a visible stale/reconnecting state and recover.

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
  `sessionStorage`, see the contract documented at the top of
  [`windowManager.ts`](src/workspace/windowManager.ts)) — and it gets live,
  linked data on its own.
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
(it's a zero-dependency re-export of the framework-agnostic core only), so
panel content/tabs are mounted via `react-dom/client`'s `createRoot` inside
dockview's `createComponent`/`createTabComponent` factories.

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
with Node's built-in `WebSocket`, no extra dependency). One such recording
is committed at `public/samples/sample-btcusdt.ndjson` and is what the
in-app "Replay" controls play back through `ReplayEngine`
(`src/core/replay/ReplayEngine.ts`) at an adjustable speed (1×–50×), routed
through the exact same event-dispatch path the live socket uses, so replay
is indistinguishable from "live" to any panel. The live socket stays
connected underneath while replaying (so reconnect/backoff and connection
status stay real, and stopping replay returns to live instantly) but its
frames are dropped rather than dispatched, to avoid interleaving live and
replayed sequence IDs into the same order book. "Inject Sequence Gap"
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
   a real production build, and a live dev-server smoke test after every
   change.

## Known gaps

- **Candlestick history backfill is partial.** `DataHub` fetches full
  REST kline history on first subscribe but currently only forwards the
  single latest candle to the chart, not the full history array — the
  chart starts near-empty on symbol/interval change and fills in live
  rather than showing historical context immediately.
- **Pop-out windows aren't captured by "save current as layout."** Only
  the main window's dockview panels are snapshotted; a pop-out's live
  panel/position state isn't reported back without a cross-window
  reporting channel (a natural extension of the existing
  `BroadcastChannel`-based link-group bus).
- **Non-order-book staleness is inferred, not first-class.** Trade tape,
  chart, and watchlist panels infer `stale` heuristically (no message for
  >8s while the hub reports `live`); only the order book carries a real
  per-message status field end-to-end.
- **No sharding past Binance's 1024-streams/connection cap.** Not needed
  at the 30-panel/10-symbol reference scale (~41 streams), but the next
  step for a workstation that needs hundreds of symbols.
- **`scripts/runBenchmark.ts` is guided-manual, not fully automated** — no
  headless-browser dependency (e.g. Playwright) was added per the
  "don't add new dependencies without asking" constraint. The in-app 60s
  benchmark button is the actual measurement path; see `PERF.md`.
- **Main bundle isn't code-split** (~858KB minified, ~238KB gzipped) —
  fine functionally, a candidate for `dynamic import()`/`manualChunks` if
  initial load time mattered more than build simplicity here.
- Replay mode leaves the live socket connected underneath (so reconnect
  and connection-status stay real), which means Binance's live data budget
  keeps being spent while nobody's using it — fine for a short stress
  session, not something to leave running indefinitely.

## Project layout

```
src/core/            framework-agnostic logic (order book, connection, hub protocol, layout, perf, replay, panel calc) — fully unit tested
src/worker/          the SharedWorker entry point
src/panels/          React/canvas panel components
src/workspace/        dockview shell, pop-out window management, layout UI
src/perf/            performance overlay, benchmark runner, stress controls
src/app/              app shell: main-window vs pop-out routing
scripts/             record a replay sample; guided benchmark runner
public/samples/      one committed recorded sample used by replay mode
```
