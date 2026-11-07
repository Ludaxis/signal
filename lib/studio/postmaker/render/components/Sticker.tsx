// Stickers (quality): pop with `pop-in` and a ±6° wobble decaying over 12 frames. Shapes are drawn (no emoji
// font: only bundled faces render text).
import React from 'react';
import { curveAt, stickerWobbleDeg } from '../curves';
import type { StickerEl } from '../timeline';

const PATHS: Record<StickerEl['shape'], string> = {
  star: 'M50 4 L61 37 L96 37 L68 58 L79 92 L50 71 L21 92 L32 58 L4 37 L39 37 Z',
  burst: 'M50 2 L58 30 L86 14 L70 42 L98 50 L70 58 L86 86 L58 70 L50 98 L42 70 L14 86 L30 58 L2 50 L30 42 L14 14 L42 30 Z',
  heart: 'M50 88 C20 66 4 48 4 30 C4 14 16 6 28 6 C38 6 46 12 50 20 C54 12 62 6 72 6 C84 6 96 14 96 30 C96 48 80 66 50 88 Z',
  check: 'M50 4 A46 46 0 1 1 49.9 4 Z M28 52 L44 68 L74 36',
};

export const Sticker: React.FC<{ el: StickerEl; frame: number }> = ({ el, frame }) => {
  const s = curveAt('pop-in', frame - el.from);
  const rot = stickerWobbleDeg(frame - el.from - 6);
  return (
    <svg
      data-layer="sticker"
      viewBox="0 0 100 100"
      width={el.size}
      height={el.size}
      style={{ position: 'absolute', left: el.x - el.size / 2, top: el.y - el.size / 2, opacity: s.opacity, transform: `scale(${s.scale}) rotate(${rot}deg)` }}
    >
      {el.shape === 'check' ? (
        <>
          <circle cx="50" cy="50" r="46" fill={el.colour} />
          <path d="M28 52 L44 68 L74 36" stroke="#FFFFFF" strokeWidth="10" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <path d={PATHS[el.shape]} fill={el.colour} stroke="#FFFFFF" strokeWidth="4" />
      )}
    </svg>
  );
};
