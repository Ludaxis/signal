// The backing plate (quality legibility): a rounded rect at 94 % opacity, 20 px padding, radius 18.
import React from 'react';

export const Plate: React.FC<{ colour: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ colour, children, style }) => (
  <div style={{ background: colour, opacity: 0.94, padding: '20px 28px', borderRadius: 18, display: 'inline-block', ...style }}>{children}</div>
);
