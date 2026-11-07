// The MOCK layer: on every frame of a render whose lineage holds a mock node, above
// everything else, never animated. A mock output can never become a post; this makes it visible. A translucent
// diagonal stripe crosses the frame (the content under it stays readable in Proof) and two solid MOCK bands sit in
// the top and bottom platform reserves, where the pixel check reads them (render/mockLayer.ts).
import React from 'react';
import { MOCK_BANDS, MOCK_COLOUR, MOCK_STRIPE_OPACITY, MOCK_TEXT } from '../mockLayer';
import { Fill } from './context';

export { MOCK_COLOUR, MOCK_PROBE, MOCK_TEXT } from '../mockLayer';

const rgba = (a: number) => `rgba(${MOCK_COLOUR.r}, ${MOCK_COLOUR.g}, ${MOCK_COLOUR.b}, ${a})`;

export const MockWatermark: React.FC<{ family: string }> = ({ family }) => (
  <Fill layer="mock-watermark" style={{ pointerEvents: 'none', zIndex: 1000, alignItems: 'center', justifyContent: 'center' }}>
    <>
      <div
        data-mock="stripe"
        style={{
          transform: 'rotate(-30deg)',
          background: rgba(MOCK_STRIPE_OPACITY),
          color: `rgba(255, 255, 255, ${MOCK_STRIPE_OPACITY + 0.15})`,
          width: 2400,
          height: 300,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: family,
          fontWeight: 900,
          fontSize: 220,
          letterSpacing: 40,
        }}
      >
        {`${MOCK_TEXT} ${MOCK_TEXT} ${MOCK_TEXT}`}
      </div>
      {MOCK_BANDS.map((b) => (
        <div
          key={b.id}
          data-mock={`band-${b.id}`}
          style={{
            position: 'absolute',
            left: 0,
            top: b.y,
            width: 1080,
            height: b.height,
            background: rgba(1),
            color: '#FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: family,
            fontWeight: 900,
            fontSize: 60,
            lineHeight: 1,
            letterSpacing: 16,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {`${MOCK_TEXT} · ${MOCK_TEXT} · ${MOCK_TEXT}`}
        </div>
      ))}
    </>
  </Fill>
);
