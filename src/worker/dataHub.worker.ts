/**
 * SharedWorker entry point. This is the one process every window (main
 * window + every pop-out) connects to, so there is exactly one Binance
 * WebSocket connection for the whole app regardless of how many windows
 * are open - each window just opens its own `MessagePort` into this same
 * worker (see `createDataHubClient.ts` on the main-thread side).
 *
 * This file intentionally contains almost no logic of its own: it adapts
 * the raw `MessagePort` API into the `HubPort` contract (`protocol.ts`)
 * and hands everything off to the single shared `DataHub` instance, which
 * owns the actual WebSocket/REST/order-book/backpressure machinery.
 */
import type { ClientToHubMsg, HubPort, HubToClientMsg } from '../core/hub/protocol';
import { DataHub } from '../core/hub/DataHub';

declare const self: SharedWorkerGlobalScope;

// One DataHub for the lifetime of this worker, shared by every connected port.
const dataHub = new DataHub();

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;

  // The HubPort wrapper needs a `clientId` up front, but we only learn it
  // from the first message a client sends (always a `hello`, carrying its
  // own `clientId`) - every `ClientToHubMsg` variant carries `clientId`,
  // so we can construct the wrapper lazily on first message and reuse it
  // for the remaining lifetime of this port.
  let hubPort: HubPort | null = null;

  port.onmessage = (ev: MessageEvent<ClientToHubMsg>) => {
    const msg = ev.data;
    if (!hubPort) {
      const clientId = msg.clientId;
      hubPort = {
        clientId,
        send: (outgoing: HubToClientMsg) => port.postMessage(outgoing),
      };
    }
    dataHub.handleClientMessage(hubPort, msg);
  };

  port.start();
};
