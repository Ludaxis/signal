// The highlight marker (quality): behind one token, 1.05 × cap height plus 12 px padding, radius 10, pack accent;
// grows from the reading-start edge (left for en, right for fa) over 5 frames, easeOutCubic, starting 2 frames after
// the word lands. Its box is the token's own laid-out box (it is a child of the token), never character offsets.
import React from 'react';
import { highlightProgress } from '../curves';

export const Highlight: React.FC<{ frame: number; landAt: number; colour: string; rtl: boolean }> = ({ frame, landAt, colour, rtl }) => {
  const p = highlightProgress(frame - (landAt + 2));
  return (
    <span
      aria-hidden
      data-layer="highlight"
      style={{
        position: 'absolute',
        left: -6,
        right: -6,
        top: '18%',
        bottom: '10%',
        background: colour,
        borderRadius: 10,
        transform: `scaleX(${p})`,
        transformOrigin: rtl ? 'right center' : 'left center',
        zIndex: -1,
      }}
    />
  );
};
