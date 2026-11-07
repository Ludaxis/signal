// The face families a composition uses (from timeline.fonts), shared by every text component.
import React, { createContext, useContext } from 'react';

export interface Faces {
  text: string;
  display: string;
  latin: string;
}

export const FacesContext = createContext<Faces>({ text: 'serif', display: 'serif', latin: 'serif' });
export const useFaces = () => useContext(FacesContext);

/** Test-only switch for the golden guard: split Persian tokens per character (must fail the diff). */
export const SplitCharsContext = createContext(false);

/** A full-frame layer that keeps its data-layer attribute (the pixel and SSR checks find layers by it). */
export const Fill: React.FC<{ layer: string; style?: React.CSSProperties; children?: React.ReactNode }> = ({ layer, style, children }) => (
  <div data-layer={layer} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', ...style }}>
    {children}
  </div>
);
