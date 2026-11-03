/**
 * Shared light-theme semantic colors used across the canvas-rendered panels
 * (depth ladder, trade tape) and the watchlist table, so bid/ask and
 * gain/loss coloring stays visually consistent across panel types.
 */
export const COLORS = {
  bid: '#15803d',
  bidBg: 'rgba(21, 128, 61, 0.12)',
  bidBgStrong: 'rgba(21, 128, 61, 0.22)',
  ask: '#b91c1c',
  askBg: 'rgba(185, 28, 28, 0.12)',
  askBgStrong: 'rgba(185, 28, 28, 0.22)',
  gain: '#15803d',
  loss: '#b91c1c',
  neutral: '#6b7280',
  textPrimary: '#1f2430',
  textSecondary: '#6b7280',
  gridLine: '#e5e7eb',
  panelBg: '#ffffff',
  headerBg: '#f5f6f8',
  largeHighlight: 'rgba(217, 119, 6, 0.18)',
} as const;
