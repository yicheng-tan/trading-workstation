/**
 * Cross-window symbol linking. Panels that share a `linkGroup` id change
 * symbol together, including across pop-out windows, via a BroadcastChannel
 * (same-origin, works across windows/tabs without touching the hub).
 */
export interface LinkGroupBus {
  setSymbol(group: string, symbol: string): void;
  subscribe(group: string, cb: (symbol: string) => void): () => void;
  dispose(): void;
}

const CHANNEL_NAME = 'trading-workstation-link-groups';

interface LinkGroupMsg {
  group: string;
  symbol: string;
}

export function createLinkGroupBus(channelName: string = CHANNEL_NAME): LinkGroupBus {
  const channel = new BroadcastChannel(channelName);
  const listeners = new Map<string, Set<(symbol: string) => void>>();

  channel.onmessage = (ev: MessageEvent<LinkGroupMsg>) => {
    const { group, symbol } = ev.data;
    listeners.get(group)?.forEach((cb) => cb(symbol));
  };

  return {
    setSymbol(group, symbol) {
      listeners.get(group)?.forEach((cb) => cb(symbol));
      channel.postMessage({ group, symbol } satisfies LinkGroupMsg);
    },
    subscribe(group, cb) {
      if (!listeners.has(group)) listeners.set(group, new Set());
      listeners.get(group)!.add(cb);
      return () => listeners.get(group)?.delete(cb);
    },
    dispose() {
      channel.close();
      listeners.clear();
    },
  };
}
