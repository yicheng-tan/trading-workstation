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
`PerfMetrics.recordFrame()`, and samples latency off the shared
`!miniTicker@arr` stream into `recordMessageLatency()` — a real,
always-available live-data timestamp regardless of which panels happen to
be open. Latency is Binance's event time `E` → main-thread receipt,
corrected for the local clock's offset from Binance's (one weight-1
`GET /api/v3/time` at startup; on the machine these results came from, the
local clock ran 4.85s ahead, which uncorrected would have swamped
everything). Only rows whose event time moved are sampled, since every
message carries all known rows but Binance only refreshes symbols that
traded. The overlay's own on-screen text is throttled to a 2×/second
`setInterval`, decoupled from the measurement loop, so *watching* the
overlay never itself perturbs the thing it's measuring.

## Reproducing a benchmark run

### Automated (headless Chrome, ~2.5 minutes)

```bash
npm run bench
```

This builds the app, serves `dist/` with `vite preview`, and drives a real
headless Chrome over the DevTools protocol (`scripts/smoke.mjs --bench`,
zero extra dependencies; set `CHROME_PATH` if Chrome isn't found). It runs
the full smoke suite and then:

1. Seeds a **30-panel / 10-symbol default layout** (10 order books, 10
   time & sales, 9 charts and 1 watchlist across `BTCUSDT ETHUSDT SOLUSDT
   XRPUSDT DOGEUSDT BNBUSDT SUIUSDT PEPEUSDT ADAUSDT LINKUSDT`) and reloads.
   It measures, in the page via `performance.now()`, when each panel first
   shows live data. The check fails if any of the 30 takes longer than 5s.
2. Clicks the overlay's **"Run 60s Benchmark"** on that live workspace.
3. Starts **10× replay** (BTC/ETH/SOL switch to the recording, the other
   seven stay live) and runs the 60s benchmark again.
4. Writes both reports plus the restore timings to
   `perf-results/bench-<timestamp>.json`.

### Manual (any browser)

1. `npm install && npm run dev`, open `http://localhost:5173`.
2. Build the reference scenario: add 10 depth-ladder panels, 10 trade-tape
   panels, and 10 candlestick-chart panels, one of each per symbol (any
   liquid USDT pairs). Optionally pop a few out into separate windows to
   also exercise multi-window rendering. Save it as a layout and mark it
   default to also time the restore on reload.
3. Click the **"Perf · _fps_"** pill (bottom-right) to expand the overlay.
4. Click **"Run 60s Benchmark"**. It samples `PerfMetrics` every 500ms for
   60s and downloads `benchmark-<timestamp>.json`
   (`src/perf/benchmarkRunner.ts`) containing `fps`/`frameTimeMs`/
   `latencyMs` percentiles, `longTaskCount`, and `sampleCount`.
5. For stress headroom: open the **"Stress testing"** panel (bottom-left),
   start replay at **10×**, and re-run the benchmark. "Drop Connection"
   and "Inject Sequence Gap" exercise the resilience requirements in
   §5 of the brief — every affected panel's status badge should visibly
   flip to `reconnecting`/`stale` and recover on its own.

`npm run bench:manual` (`scripts/runBenchmark.ts`) checks the dev server is
reachable and prints these same steps.

## Results

From `npm run bench` on 2026-11-03, committed as
[`perf-results/`](perf-results/): Chrome 156 headless, 1920×1080,
Windows 11, production build, live Binance Spot data.

Latest run (`bench-2026-11-03T10-40-17.json`, after the QoL pass):

| Scenario | First live data | Frame time p50 / p95 / worst-window p95 | Long tasks (>50ms) | Latency p50 / p95 |
|---|---|---|---|---|
| **Restore 30-panel / 10-symbol default layout** | first panel 325ms, **all 30 by 733ms** after navigation (target < 5s) | — | — | — |
| **30 panels live, 60s** | — | 7.0 / 7.1 / 13.8ms | **1** | 974 / 994ms |
| **Same + 10× replay, 60s** | — | 7.0 / 7.1 / 7.1ms | **0** | 983 / 996ms |

The previous run (`bench-2026-11-03T09-51-46.json`, before the QoL pass)
had 0 long tasks in both scenarios and all 30 panels live by 1,121ms.
Across several runs while this was being built, "all 30 live" landed
between 0.5s and 2.3s.

Frame time is sampled as a p95 over a rolling 5s window. The third number
is the worst of those windows, not the single slowest frame, and the
long-task column counts individual frames over 50ms.

How to read these honestly:

- **Frame time is pinned at the display interval.** Headless Chrome ticked
  rAF at ~144Hz here, and 7.0ms is that interval, so p95 = p50 = 7.0ms means
  no frame missed its slot. Frame time can't show how much of the 7ms
  budget was used. Long tasks are the stronger signal. The latest live run
  had one frame over 50ms in 60s; the replay run and the previous run had
  none. One isolated stall at 144Hz isn't a sustained problem, but it isn't
  zero either, against a target of 0.
- **Latency is ~1s and nearly constant, and that's the stream, not this
  app.** p50 and p95 are within ~15–30ms of each other. `!miniTicker@arr`
  pushes once per second, and its `E` timestamps sit about one push
  interval before delivery. A queueing problem in our pipeline would show
  up as a wide spread, not a fixed offset. So against the 50ms target this
  metric is inconclusive rather than failed: it bounds Binance's cadence
  for this stream, not our own overhead. Measuring our pipeline properly
  is listed under "What I'd do with another day" in the README.
- **Headless isn't a trader's GPU-composited multi-monitor desktop.** These
  numbers show relative headroom (10× replay costs nothing measurable)
  and that restore sits far under target. Repeat the manual run on real
  hardware before quoting them as production numbers.
