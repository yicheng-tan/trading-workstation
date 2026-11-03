import { SYMBOL_DATALIST_ID, useSortedSymbols } from './symbolDirectory';

/**
 * Rendered once per window. Every symbol input references it via
 * `list={SYMBOL_DATALIST_ID}` rather than owning a copy, so 30 panels don't
 * mean 30 × ~1500 `<option>` nodes.
 */
export function SymbolDatalist() {
  const symbols = useSortedSymbols();
  return (
    <datalist id={SYMBOL_DATALIST_ID}>
      {symbols.map((s) => (
        <option key={s} value={s} />
      ))}
    </datalist>
  );
}
