import { useSyncExternalStore, type ChangeEvent } from 'react';
import { REST_HOSTS } from '../core/hub/hosts';
import { parseExchangeInfoSymbols } from '../core/symbols/symbols';

/**
 * Per-window directory of tradable Binance Spot symbols, backing symbol-input
 * autocomplete and validation. It's a one-off REST request rather than
 * streaming data, so it's fetched on the main thread instead of through the
 * SharedWorker hub, and cached in localStorage for a day so reloads and
 * pop-outs don't refetch it.
 */

const CACHE_KEY = 'trading-workstation:symbols';
const CACHE_TTL_MS = 24 * 3600 * 1000;
const RETRY_AFTER_MS = 60_000;
const EXCHANGE_INFO_PATH = '/api/v3/exchangeInfo?symbolStatus=TRADING';

/** `id` of the single shared `<datalist>` (see `SymbolDatalist`) that every symbol input points its `list` attribute at. */
export const SYMBOL_DATALIST_ID = 'tw-symbol-options';

let symbolSet: ReadonlySet<string> | null = null;
let sortedSymbols: readonly string[] = [];
let requested = false;
const listeners = new Set<() => void>();

function publish(list: string[]): void {
  sortedSymbols = list;
  symbolSet = new Set(list);
  for (const listener of listeners) listener();
}

function readCache(): string[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { fetchedAt?: unknown; symbols?: unknown };
    if (typeof parsed.fetchedAt !== 'number' || Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    if (!Array.isArray(parsed.symbols) || parsed.symbols.length === 0) return null;
    if (!parsed.symbols.every((s) => typeof s === 'string')) return null;
    return parsed.symbols as string[];
  } catch {
    return null;
  }
}

function writeCache(list: string[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), symbols: list }));
  } catch {
    // Storage unavailable or full - we'll just refetch next time.
  }
}

async function fetchSymbols(): Promise<string[]> {
  for (const base of [REST_HOSTS.primary, REST_HOSTS.fallback]) {
    try {
      const res = await fetch(base + EXCHANGE_INFO_PATH);
      if (!res.ok) continue;
      const list = parseExchangeInfoSymbols(await res.json());
      if (list.length > 0) return list;
    } catch {
      // Network/CORS failure on this host - try the next one.
    }
  }
  return [];
}

function ensureLoaded(): void {
  if (requested) return;
  requested = true;
  const cached = readCache();
  if (cached) {
    publish(cached);
    return;
  }
  void fetchSymbols().then((list) => {
    if (list.length === 0) {
      console.warn('[symbolDirectory] could not load the Binance symbol list; symbol inputs will accept any value.');
      setTimeout(() => {
        requested = false;
        if (listeners.size > 0) ensureLoaded();
      }, RETRY_AFTER_MS);
      return;
    }
    writeCache(list);
    publish(list);
  });
}

function subscribe(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Set of known symbols, or `null` until the directory has loaded (callers should then accept input as typed). */
export function useSymbolSet(): ReadonlySet<string> | null {
  return useSyncExternalStore(subscribe, () => symbolSet);
}

/** Alphabetical list of known symbols; empty until loaded. */
export function useSortedSymbols(): readonly string[] {
  return useSyncExternalStore(subscribe, () => sortedSymbols);
}

/**
 * True when a change came from choosing a `<datalist>` suggestion rather than
 * typing: Chromium fires a plain `Event` for it, Firefox an `InputEvent` with
 * `inputType: 'insertReplacementText'`.
 */
export function isDatalistPick(e: ChangeEvent<HTMLInputElement>): boolean {
  const native = e.nativeEvent;
  return !(native instanceof InputEvent) || native.inputType === 'insertReplacementText';
}
