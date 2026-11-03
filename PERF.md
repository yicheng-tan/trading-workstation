# Performance

## Reference scenario

Per the brief: **30 panels across 10 symbols, all with live streams.**
A reasonable split: 10 depth ladders + 10 trade tapes + 10 candlestick
charts (one interval each) = 30 panels, 10 symbols, ~31 live Binance
streams (depth + aggTrade + kline per symbol) plus one shared
`!miniTicker@arr` stream for any watchlist panels — all multiplexed over
the **one** WebSocket connection the `SharedWorker` data hub owns (see
`README.md` → Architecture), regardless of how many browser windows those
30 panels are spread across.

## What we measure, and why

| Metric | Why | Target |
|---|---|---|
| **FPS** / **p95 frame time** | The thing a trader actually perceives — a ladder that stutters is unusable mid-trade. | p95 frame time ≤ 16.7ms (60fps) |
| **Long-task count** (frames > 50ms) | A single 50ms+ frame is a visible stutter even if the average looks fine; averages hide exactly the spikes that matter. | 0 in the reference scenario at steady state |
| **p95 message-arrival-to-render latency** | How stale what's on screen is relative to what Binance actually sent — distinct from frame rate (you can render smoothly *and* be behind). | p95 < 50ms |
| **JS heap size** (Chromium only) | A slow memory leak across a multi-hour trading session is worse than a fast one — this is a trend-watch metric, not a single-number pass/fail. | Flat over a 10+ minute run, not monotonically climbing |
| **Stress multiplier** | Headroom above the reference scenario, via replay at up to 50× speed. | Stays above 50fps at 10× replay |

These are deliberately the metrics a trader-facing perf budget should care
about (frame smoothness + data freshness), not proxy metrics like CPU% or
bundle size — those matter too (see `README.md` → Known gaps re: bundle
size) but aren't the primary signal for "does this feel smooth under load."

## How it's measured

All four metrics are computed by `PerfMetrics`
(`src/core/perf/PerfMetrics.ts`) from two rolling, time-decaying sample
windows (frame durations, message latencies), each exposed via
`percentile()` (nearest-rank). The **measurement code itself is unit
tested** — 11 tests in `PerfMetrics.test.ts`, including exact expected
percentile values on known inputs (e.g. p95 of `[1..100]` must equal
exactly `95`) and rolling-window eviction — so the numbers the overlay
reports aren't just "trust me," the arithmetic is pinned down.

At runtime, `PerfOverlay` (`src/perf/PerfOverlay.tsx`) drives its own
`requestAnimationFrame` loop that feeds real frame-to-frame deltas into
`PerfMetrics.recordFrame()`, and samples `Date.now() - row.updatedAt` off
the shared watchlist stream into `recordMessageLatency()` — a real,
always-available live-data timestamp regardless of which panels happen to
be open. The overlay's own on-screen text is throttled to a 2×/second
`setInterval`, decoupled from the measurement loop, so *watching* the
overlay never itself perturbs the thing it's measuring.

## Reproducing a benchmark run

1. `npm install && npm run dev`, open `http://localhost:5173`.
2. Build the reference scenario: add 10 depth-ladder panels, 10 trade-tape
   panels, and 10 candlestick-chart panels, one of each per symbol across
   `BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, ADAUSDT, DOGEUSDT,
   AVAXUSDT, LINKUSDT, DOTUSDT` (the app's default watchlist symbol list,
   `DEFAULT_WATCHLIST_SYMBOLS` in `src/panels/registry.tsx`). Optionally
   pop a few out into separate windows to also exercise multi-window
   rendering.
3. Click the **"Perf · _fps_"** pill (bottom-right) to expand the overlay.
4. Click **"Run 60s Benchmark"**. It samples `PerfMetrics` every 500ms for
   60s and downloads `benchmark-<timestamp>.json`
   (`src/perf/benchmarkRunner.ts`) containing `fps`/`frameTimeMs`/
   `latencyMs` percentiles, `longTaskCount`, and `sampleCount` — attach
   that file as your evidence.
5. For stress headroom: open the **"Stress testing"** panel (bottom-left),
   start replay at **10×**, and re-run the benchmark. "Drop Connection"
   and "Inject Sequence Gap" exercise the resilience requirements in
   §5 of the brief — every affected panel's status badge should visibly
   flip to `reconnecting`/`stale` and recover on its own.

`scripts/runBenchmark.ts` (`npm run bench`) is a lightweight guide script —
it checks the dev server is reachable and prints these same steps. It's
intentionally **not** a headless-browser-automated benchmark: that would
need a dependency like Playwright, which wasn't added without checking in
first (see `README.md` → Known gaps).

## Results

**Honest status:** this session built and integrated the full measurement
pipeline (unit-tested percentile/rolling-window math, the live overlay, the
one-click benchmark exporter) and verified it compiles, type-checks, and
builds correctly end-to-end — but this agent's environment has no
browser-automation tool available, so no live 30-panel/10-symbol browser
session was actually driven to produce a real `benchmark-*.json` during
this build. The dev server was smoke-tested (HTTP 200 on the app shell,
the SharedWorker's own bundle chunk, and the bundled replay sample; see the
build log in the git history) but that only confirms the app *loads* — not
its steady-state frame timing under load.

**Action for whoever runs this next:** follow "Reproducing a benchmark
run" above once, and paste/attach the downloaded JSON here (or commit it
under `perf-results/`). Until then, treat the targets in the table above
as the committed bar, not yet a verified result.
