/**
 * Cross-window symbol linking. Panels that share a `linkGroup` id change
 * symbol together, including across pop-out windows, via a BroadcastChannel
 * (same-origin, works across windows/tabs without touching the hub).
 *
 * The bus also remembers each group's current symbol so a panel that joins a
 * group adopts it. Every window's bus hears every change, and the last value
 * is mirrored to localStorage so a window that opened after the change still
 * knows it.
 */
export interface LinkGroupBus {
  setSymbol(group: string, symbol: string): void;
  subscribe(group: string, cb: (symbol: string) => void): () => void;
  /** The group's current symbol, if any window has set or seeded one. */
  getSymbol(group: string): string | null;
  /** Records `symbol` as the group's current symbol only if none is known yet in this window. Does not broadcast. */
  seed(group: string, symbol: string): void;
  dispose(): void;
}

const CHANNEL_NAME = 'trading-workstation-link-groups';
const STORAGE_PREFIX = 'trading-workstation:link-group:';

interface LinkGroupMsg {
  group: string;
  symbol: string;
}

function persist(group: string, symbol: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + group, symbol);
  } catch {
    // Storage unavailable - in-memory knowledge still works within this window.
  }
}

function readPersisted(group: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + group);
  } catch {
    return null;
  }
}

export function createLinkGroupBus(channelName: string = CHANNEL_NAME): LinkGroupBus {
  const listeners = new Map<string, Set<(symbol: string) => void>>();
  const current = new Map<string, string>();

  // Opened lazily and reopened after dispose(): React StrictMode disposes and
  // then keeps using the same bus instance on its simulated remount.
  let channel: BroadcastChannel | null = null;
  const openChannel = (): BroadcastChannel => {
    if (channel) return channel;
    channel = new BroadcastChannel(channelName);
    channel.onmessage = (ev: MessageEvent<LinkGroupMsg>) => {
      const { group, symbol } = ev.data;
      current.set(group, symbol);
      listeners.get(group)?.forEach((cb) => cb(symbol));
    };
    return channel;
  };

  return {
    setSymbol(group, symbol) {
      current.set(group, symbol);
      persist(group, symbol);
      listeners.get(group)?.forEach((cb) => cb(symbol));
      openChannel().postMessage({ group, symbol } satisfies LinkGroupMsg);
    },
    subscribe(group, cb) {
      openChannel();
      if (!listeners.has(group)) listeners.set(group, new Set());
      listeners.get(group)!.add(cb);
      return () => listeners.get(group)?.delete(cb);
    },
    getSymbol(group) {
      return current.get(group) ?? readPersisted(group);
    },
    seed(group, symbol) {
      if (current.has(group)) return;
      current.set(group, symbol);
      persist(group, symbol);
    },
    dispose() {
      channel?.close();
      channel = null;
      listeners.clear();
    },
  };
}
