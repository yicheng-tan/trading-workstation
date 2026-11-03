/**
 * Primary/fallback Binance Spot production endpoints. No API key required
 * for any of these (public market data only).
 *
 * The fallback host (`data-api.binance.vision` / `data-stream.binance.vision`)
 * is Binance's documented mirror for regions where the primary
 * `binance.com` / `stream.binance.com` hosts are blocked. `ReconnectPolicy`
 * decides when to switch a connection over to the fallback.
 */
import type { Host } from '../connection/ReconnectPolicy';

export const REST_HOSTS: Record<Host, string> = {
  primary: 'https://api.binance.com',
  fallback: 'https://data-api.binance.vision',
};

export const WS_HOSTS: Record<Host, string> = {
  primary: 'wss://stream.binance.com:9443',
  fallback: 'wss://data-stream.binance.vision',
};

export function restBaseUrl(host: Host): string {
  return REST_HOSTS[host];
}

export function wsBaseUrl(host: Host): string {
  return WS_HOSTS[host];
}

/** Combined-stream control endpoint: streams are added/removed via SUBSCRIBE/UNSUBSCRIBE frames, not the URL. */
export function wsControlUrl(host: Host): string {
  return `${wsBaseUrl(host)}/ws`;
}
