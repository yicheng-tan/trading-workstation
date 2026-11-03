import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * Joining a group (changing `group` after mount) adopts the group's current
 * symbol. On mount the panel keeps its own symbol and only seeds the group if
 * nothing is known yet - a restored layout already stores matching symbols for
 * every member, and must not be overridden by a stale value from an earlier
 * session.
 */
export function useLinkedSymbol(group: string | null, initialSymbol: string): [string, (symbol: string) => void] {
  const bus = useContext(LinkGroupReactContext);
  const [symbol, setSymbolState] = useState(initialSymbol);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const mountedGroupRef = useRef(group);

  useEffect(() => {
    if (!group || !bus) {
      mountedGroupRef.current = group;
      return;
    }
    const joined = mountedGroupRef.current !== group;
    mountedGroupRef.current = group;
    const groupSymbol = bus.getSymbol(group);
    if (joined && groupSymbol) {
      setSymbolState(groupSymbol);
    } else {
      bus.seed(group, symbolRef.current);
    }
    return bus.subscribe(group, setSymbolState);
  }, [group, bus]);

  const setSymbol = useCallback(
    (next: string) => {
      setSymbolState(next);
      if (group && bus) bus.setSymbol(group, next);
    },
    [group, bus],
  );

  return [symbol, setSymbol];
}
