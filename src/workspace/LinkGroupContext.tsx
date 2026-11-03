import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createLinkGroupBus, type LinkGroupBus } from './linkGroupBus';

const LinkGroupReactContext = createContext<LinkGroupBus | null>(null);

export function LinkGroupProvider({ children }: { children: React.ReactNode }) {
  const bus = useMemo(() => createLinkGroupBus(), []);
  useEffect(() => () => bus.dispose(), [bus]);
  return <LinkGroupReactContext.Provider value={bus}>{children}</LinkGroupReactContext.Provider>;
}

/**
 * For a panel with `linkGroup` (or null for an unlinked panel): returns the
 * current shared symbol for that group plus a setter that broadcasts the
 * change to every other panel (in this window or any pop-out) in the group.
 * When `group` is null, behaves as fully local state.
 */
export function useLinkedSymbol(group: string | null, initialSymbol: string): [string, (symbol: string) => void] {
  const bus = useContext(LinkGroupReactContext);
  const [symbol, setSymbolState] = useState(initialSymbol);

  useEffect(() => {
    if (!group || !bus) return;
    return bus.subscribe(group, setSymbolState);
  }, [group, bus]);

  const setSymbol = (next: string) => {
    setSymbolState(next);
    if (group && bus) bus.setSymbol(group, next);
  };

  return [symbol, setSymbol];
}
