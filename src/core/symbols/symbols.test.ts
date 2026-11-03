import { describe, it, expect } from 'vitest';
import { normalizeSymbolInput, parseExchangeInfoSymbols, resolveSymbol } from './symbols';

const KNOWN = new Set(['BTCUSDT', 'ETHUSDT', 'ETHBTC', 'SOLUSDC', 'WBTCBTC']);

describe('parseExchangeInfoSymbols', () => {
  it('keeps only TRADING, spot-allowed symbols, sorted', () => {
    const list = parseExchangeInfoSymbols({
      symbols: [
        { symbol: 'ETHUSDT', status: 'TRADING', isSpotTradingAllowed: true },
        { symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true },
        { symbol: 'LUNAUSDT', status: 'BREAK', isSpotTradingAllowed: true },
        { symbol: 'MARGINONLY', status: 'TRADING', isSpotTradingAllowed: false },
      ],
    });
    expect(list).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('returns [] for malformed payloads and skips malformed entries', () => {
    expect(parseExchangeInfoSymbols(null)).toEqual([]);
    expect(parseExchangeInfoSymbols({ symbols: 'nope' })).toEqual([]);
    expect(parseExchangeInfoSymbols({ symbols: [null, { symbol: 42 }, { symbol: 'BTCUSDT' }] })).toEqual(['BTCUSDT']);
  });
});

describe('normalizeSymbolInput', () => {
  it('uppercases and strips whitespace and pair separators', () => {
    expect(normalizeSymbolInput(' eth/usdt ')).toBe('ETHUSDT');
    expect(normalizeSymbolInput('btc-usdt')).toBe('BTCUSDT');
    expect(normalizeSymbolInput('sol_usdc')).toBe('SOLUSDC');
  });

  it('leaves non-ASCII symbol characters intact', () => {
    expect(normalizeSymbolInput('币安人生usdt')).toBe('币安人生USDT');
  });
});

describe('resolveSymbol', () => {
  it('accepts exact matches regardless of case or separators', () => {
    expect(resolveSymbol('ethbtc', KNOWN)).toBe('ETHBTC');
    expect(resolveSymbol('ETH/BTC', KNOWN)).toBe('ETHBTC');
  });

  it('expands a bare base asset using the first quote asset that exists', () => {
    expect(resolveSymbol('btc', KNOWN)).toBe('BTCUSDT');
    expect(resolveSymbol('sol', KNOWN)).toBe('SOLUSDC');
    expect(resolveSymbol('wbtc', KNOWN)).toBe('WBTCBTC');
  });

  it('rejects unknown and empty input', () => {
    expect(resolveSymbol('NOTACOIN', KNOWN)).toBeNull();
    expect(resolveSymbol('   ', KNOWN)).toBeNull();
  });

  it('accepts any non-empty input as typed when the directory is unavailable', () => {
    expect(resolveSymbol('btc', null)).toBe('BTC');
    expect(resolveSymbol('', null)).toBeNull();
  });
});
