/**
 * Pure helpers for the Binance Spot symbol directory (the set of currently
 * tradable symbols from `GET /api/v3/exchangeInfo`): parsing the REST
 * response, and turning loose user input ("btc", "eth/usdt") into a real
 * symbol. No network or DOM, so it can be unit tested in isolation.
 */

/** Quote assets tried, in order, when the user types a bare base asset such as "BTC". */
export const SHORTHAND_QUOTE_ASSETS = ['USDT', 'USDC', 'FDUSD', 'BTC'] as const;

interface RawExchangeInfoSymbol {
  symbol?: unknown;
  status?: unknown;
  isSpotTradingAllowed?: unknown;
}

/** Extracts the sorted list of spot-tradable symbols from an `exchangeInfo` response; `[]` for anything malformed. */
export function parseExchangeInfoSymbols(raw: unknown): string[] {
  const list = typeof raw === 'object' && raw !== null ? (raw as { symbols?: unknown }).symbols : undefined;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list as RawExchangeInfoSymbol[]) {
    if (typeof entry !== 'object' || entry === null || typeof entry.symbol !== 'string') continue;
    if (entry.status !== undefined && entry.status !== 'TRADING') continue;
    if (entry.isSpotTradingAllowed === false) continue;
    out.push(entry.symbol.toUpperCase());
  }
  return out.sort();
}

/** Uppercases and strips whitespace and common pair separators ("eth/usdt", "btc-usdt"). Non-ASCII symbols are left intact. */
export function normalizeSymbolInput(input: string): string {
  return input.toUpperCase().replace(/[\s/\-_:]+/g, '');
}

/**
 * Resolves loose input to a symbol: an exact match first, then
 * `<input><quote>` for each of `SHORTHAND_QUOTE_ASSETS`. Returns `null` for
 * empty or unknown input. When `known` is `null` (directory not loaded yet,
 * or unreachable) any non-empty input is accepted as typed, so symbol entry
 * never hard-depends on the directory request succeeding.
 */
export function resolveSymbol(input: string, known: ReadonlySet<string> | null): string | null {
  const normalized = normalizeSymbolInput(input);
  if (!normalized) return null;
  if (!known || known.has(normalized)) return normalized;
  for (const quote of SHORTHAND_QUOTE_ASSETS) {
    const candidate = normalized + quote;
    if (known.has(candidate)) return candidate;
  }
  return null;
}
