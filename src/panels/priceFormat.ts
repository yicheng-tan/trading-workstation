/** Decimals that keep ~4 significant digits for sub-1 prices (e.g. PEPE at 0.0000099), capped at Binance's 8. */
export function priceDecimals(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price <= 0) return 6;
  return Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(price))));
}

/** Sizes for narrow ladder/tape columns: full precision for small lots, K/M/B for meme-coin sizes like 105,879,185. */
export function formatQty(qty: number): string {
  if (qty >= 1e9) return `${(qty / 1e9).toFixed(2)}B`;
  if (qty >= 1e6) return `${(qty / 1e6).toFixed(2)}M`;
  if (qty >= 1e5) return `${(qty / 1e3).toFixed(1)}K`;
  if (qty >= 100) return qty.toFixed(2);
  return qty.toFixed(4);
}
