// A minimal stand-in for Remotion's browser runtime, so the Post maker compositions render to static HTML in Node
// (react-dom/server) at any frame without Remotion installed. vitest.config.mts aliases `remotion` to this file; the
// real renders (render child, the @render suite and the slice) use the optional render workspace's Remotion instead.
// It mirrors the semantics the compositions rely on: useCurrentFrame() is relative to the innermost <Sequence>, which
// renders only inside [from, from + durationInFrames); staticFile() resolves under /public/.
import React, { createContext, useContext } from 'react';

export const FrameContext = createContext({ frame: 0, offset: 0 });
export const ConfigContext = createContext({ fps: 30, width: 1080, height: 1920, durationInFrames: 450, id: 'stub' });

export const useCurrentFrame = () => {
  const c = useContext(FrameContext);
  return c.frame - c.offset;
};

export const useVideoConfig = () => useContext(ConfigContext);

export const Sequence: React.FC<{ from?: number; durationInFrames?: number; layout?: 'none' | 'absolute-fill'; name?: string; children?: React.ReactNode }> = ({ from = 0, durationInFrames = Infinity, layout, name, children }) => {
  const c = useContext(FrameContext);
  const start = c.offset + from;
  if (c.frame < start || c.frame >= start + durationInFrames) return null;
  return <FrameContext.Provider value={{ frame: c.frame, offset: start }}>{layout === 'none' ? children : <div data-sequence={name ?? ''}>{children}</div>}</FrameContext.Provider>;
};

export const AbsoluteFill: React.FC<{ style?: React.CSSProperties; className?: string; children?: React.ReactNode }> = ({ style, className, children }) => (
  <div className={className} style={{ position: 'absolute', inset: 0, ...style }}>
    {children}
  </div>
);

// Media stand-ins are plain marked elements (no player in static HTML); the tests read their sources.
export const Html5Audio: React.FC<{ src: string; volume?: number | ((f: number) => number) }> = ({ src }) => <span data-audio={src} />;
export const Audio = Html5Audio;
export const OffthreadVideo: React.FC<{ src: string; trimBefore?: number }> = ({ src, trimBefore }) => <span data-video={src} data-trim-before={trimBefore} />;
// eslint-disable-next-line @next/next/no-img-element -- test stub mirroring Remotion's Img
export const Img: React.FC<{ src: string }> = ({ src }) => <img src={src} alt="" />;

export const staticFile = (p: string) => `/public/${p}`;
export const delayRender = () => 0;
export const continueRender = () => undefined;
export const cancelRender = (err: unknown) => {
  throw err;
};

/** The Remotion names the stub provides (the smoke test checks the compositions import nothing else). */
export const STUB_EXPORTS = ['useCurrentFrame', 'useVideoConfig', 'Sequence', 'AbsoluteFill', 'Html5Audio', 'Audio', 'OffthreadVideo', 'Img', 'staticFile', 'delayRender', 'continueRender', 'cancelRender'];
