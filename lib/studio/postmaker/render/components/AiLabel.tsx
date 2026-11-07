// The AI pill (quality -, C11): top row at x 108 on every frame, static, never animated.
import React from 'react';
import { AI_LABEL_ANCHOR } from '../safeZones';
import { typeScale } from '../typeScale';
import { useFaces } from './context';

export const AiLabel: React.FC<{ text: string; lang: 'fa' | 'en' }> = ({ text, lang }) => {
  const faces = useFaces();
  const t = typeScale('ai-label', lang);
  return (
    <div
      data-layer="ai-label"
      lang={lang}
      dir={lang === 'fa' ? 'rtl' : 'ltr'}
      style={{
        position: 'absolute',
        left: AI_LABEL_ANCHOR.x,
        top: AI_LABEL_ANCHOR.y,
        zIndex: 900,
        background: 'rgba(22, 22, 29, 0.88)',
        color: '#FFFFFF',
        fontFamily: lang === 'fa' ? faces.text : faces.latin,
        fontWeight: t.weight[0],
        fontSize: t.size,
        lineHeight: 1,
        padding: '10px 18px',
        borderRadius: 999,
        letterSpacing: 0,
      }}
    >
      {text}
    </div>
  );
};
