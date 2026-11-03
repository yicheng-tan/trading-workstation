/**
 * Lightweight benchmark launcher/guide.
 *
 * True end-to-end automated benchmarking - launch a headless browser, open
 * the 30-panel/10-symbol reference layout, click the Perf overlay's
 * "Run 60s Benchmark" button, and scrape the downloaded JSON - would use
 * Playwright. That dependency was intentionally NOT added per this
 * workstream's "don't add dependencies, report what you'd need" constraint;
 * it's flagged in the final report as a "would add" dependency instead.
 *
 * Until then, this script does the two things it *can* do without a
 * browser driver: confirm the dev server is actually up, and print exact,
 * copy-pasteable manual steps to run the same benchmark by hand through the
 * real UI (which is also a perfectly valid way to reproduce PERF.md's
 * numbers per the PRD's "give reviewers a way to reproduce your
 * measurements" requirement).
 *
 * Usage:
 *   npx tsx scripts/runBenchmark.ts
 *   npm run bench
 */

import http from 'node:http';

const DEV_SERVER_URL = 'http://localhost:5173';
const CHECK_TIMEOUT_MS = 2000;

// Mirrors DEFAULT_WATCHLIST_SYMBOLS in src/panels/registry.tsx (not
// imported directly - that file pulls in React/CSS-module imports that
// don't resolve from a plain Node script run via tsx).
const REFERENCE_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'DOTUSDT',
];

function checkDevServer(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function main(): Promise<void> {
  const reachable = await checkDevServer(DEV_SERVER_URL, CHECK_TIMEOUT_MS);

  console.log('=== Trading Workstation - Benchmark Runner ===\n');

  if (reachable) {
    console.log(`[ok]  Dev server is reachable at ${DEV_SERVER_URL}`);
  } else {
    console.log(`[!!]  Dev server is NOT reachable at ${DEV_SERVER_URL}`);
    console.log('      Start it first, in another terminal:  npm run dev');
  }

  console.log('\n--- Reference scenario (PRD section 4) ---');
  console.log('30 panels across 10 symbols, all with live streams:');
  console.log(`  ${REFERENCE_SYMBOLS.join(', ')}`);
  console.log('(e.g. 3 panels per symbol - any mix of order book / trade tape / chart / watchlist)');

  console.log('\n--- Manual benchmark steps ---');
  console.log(`1. Open ${DEV_SERVER_URL} in a Chromium-based browser (needed for the`);
  console.log('   performance.memory JS-heap reading in the Perf overlay; other engines still');
  console.log('   work for everything else, heap just shows "n/a").');
  console.log('2. Load the 30-panel reference layout if one has been saved, or manually open');
  console.log('   panels until you have ~30 total spread across the 10 symbols above.');
  console.log('3. Let it run live for ~10s so every panel has an active stream and the Perf');
  console.log('   overlay (bottom-right "Perf" pill) has warmed up.');
  console.log('4. Click the "Perf" pill to expand the overlay.');
  console.log('5. Optional - for the stress scenario: open the replay/fault controls and start');
  console.log('   a 10x replay before benchmarking, to validate the "stress mode stays above');
  console.log('   50fps" target instead of (or in addition to) the live-data baseline.');
  console.log('6. Click "Run 60s Benchmark" in the Perf overlay and keep the tab focused/visible');
  console.log('   for the full 60 seconds (backgrounded tabs throttle rAF and will skew results).');
  console.log('7. A `benchmark-<timestamp>.json` file downloads automatically when it finishes.');
  console.log('8. Move that file into the repo (e.g. a `PERF/` folder) and cite it from PERF.md.');

  console.log('\n--- Why this script doesn\'t drive the browser itself ---');
  console.log('Automating steps 1-7 would use Playwright (chromium.launch() -> page.goto() ->');
  console.log('load layout -> click "Run 60s Benchmark" -> listen for the download). That');
  console.log('package was intentionally not installed - see the final report\'s "new npm');
  console.log('dependency" note - so for now this is a guided-manual flow instead.');
}

main().catch((err) => {
  console.error('runBenchmark.ts failed:', err);
  process.exit(1);
});
