// The Mac app's bridge (desktop/preload.cjs). Absent in a normal browser: callers fall back to
// typed paths and normal links.
export interface SignalDesktop {
  isDesktop: true;
  pickFolder: () => Promise<string | null>;
  reveal: (path: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
}

export function desktop(): SignalDesktop | null {
  if (typeof window === 'undefined') return null;
  const d = (window as unknown as { signalDesktop?: SignalDesktop }).signalDesktop;
  return d && d.isDesktop ? d : null;
}

/** Opens a link in the default browser (Mac app) or a new tab (browser). */
export function openLink(url: string): void {
  const d = desktop();
  if (d) void d.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
