/** Decimals that keep ~4 significant digits for sub-1 prices (e.g. PEPE at 0.0000099), capped at Binance's 8. */
export function priceDecimals(price: number): number {
  if (price >= 1000) return 2;
  if (price >= 1) return 4;
  if (price <= 0) return 6;
  return Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(price))));
}
