import { describe, it, expect } from 'vitest';
import { formatQty, priceDecimals } from './priceFormat';

describe('priceDecimals', () => {
  it('keeps about four significant digits below 1 and caps at 8', () => {
    expect(priceDecimals(77000)).toBe(2);
    expect(priceDecimals(1.25)).toBe(4);
    expect(priceDecimals(0.0741)).toBe(5);
    expect(priceDecimals(0.00000471)).toBe(8);
  });
});

describe('formatQty', () => {
  it('keeps full precision for small lots', () => {
    expect(formatQty(0.0123)).toBe('0.0123');
    expect(formatQty(12.5)).toBe('12.5000');
    expect(formatQty(4321.987)).toBe('4321.99');
  });

  it('abbreviates very large sizes so they fit a narrow column', () => {
    expect(formatQty(250_000)).toBe('250.0K');
    expect(formatQty(105_879_185)).toBe('105.88M');
    expect(formatQty(2_500_000_000)).toBe('2.50B');
  });
});
