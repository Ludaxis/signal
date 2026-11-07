// The end card (preset `endcard`, roles): icon (settle), tagline tokens (pop-in, 5-frame stagger, reading
// order), sub-line (slide-in), CTA (pop-in) and its pulses (punch, peak 1.04) every 2 beats; the last 30 frames hold.
import React from 'react';
import { curveAt, settleProgress } from '../curves';
import type { EndCardEl } from '../timeline';
import { ENDCARD_SLOT } from '../slots';
import { typeScale } from '../typeScale';
import { useFaces } from './context';
import { KineticText } from './KineticText';

export const EndCard: React.FC<{ el: EndCardEl; frame: number; textColour: string }> = ({ el, frame, textColour }) => {
  const faces = useFaces();
  const rtl = el.lang === 'fa';
  const tag = typeScale('endcard-tagline', el.lang);
  const sub = typeScale('endcard-sub', el.lang);
  const icon = settleProgress(frame - el.iconAt, 16);
  const subState = el.sub ? curveAt('slide-in', frame - el.sub.at) : null;
  const cta = curveAt('pop-in', frame - el.cta.at);
  const pulse = el.pulses.reduce((s, p) => s * curveAt('punch', frame - p, { peak: 1.04 }).scale, 1);
  return (
    <div data-layer="endcard" style={{ position: 'absolute', left: ENDCARD_SLOT.left, width: ENDCARD_SLOT.width, top: ENDCARD_SLOT.top, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: ENDCARD_SLOT.gap }}>
      <div
        style={{
          width: ENDCARD_SLOT.icon,
          height: ENDCARD_SLOT.icon,
          borderRadius: 56,
          background: el.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: faces.display,
          fontWeight: 900,
          fontSize: 150,
          color: '#16161D',
          opacity: Math.min(1, icon * 1.5),
          transform: `translateY(${(1 - icon) * 120}px) scale(${0.7 + 0.3 * icon})`,
        }}
        lang={el.lang}
        dir={rtl ? 'rtl' : 'ltr'}
      >
        {el.iconText}
      </div>
      <KineticText frame={frame} lines={[el.tagline]} lang={el.lang} rtl={rtl} sizePx={tag.size} lineHeight={tag.lineHeight ?? 1.3} weight={tag.weight[0]} colour={textColour} accent={el.accent} exitAt={null} plate={null} />
      {el.sub && subState ? (
        <div lang={el.lang} dir={rtl ? 'rtl' : 'ltr'} style={{ fontFamily: rtl ? faces.text : faces.latin, fontSize: sub.size, fontWeight: sub.weight[0], lineHeight: sub.lineHeight ?? 1.4, color: textColour, opacity: subState.opacity, transform: `translateY(${subState.y}px)` }}>
          {el.sub.text}
        </div>
      ) : null}
      <div
        data-layer="cta"
        lang={el.lang}
        dir={rtl ? 'rtl' : 'ltr'}
        style={{ background: '#16161D', color: '#FFFFFF', borderRadius: 999, padding: `${ENDCARD_SLOT.ctaPadY}px 56px`, fontFamily: rtl ? faces.text : faces.latin, fontWeight: 800, fontSize: ENDCARD_SLOT.ctaFont[el.lang], lineHeight: 1.25, opacity: cta.opacity, transform: `scale(${cta.scale * pulse})` }}
      >
        {el.cta.text}
      </div>
    </div>
  );
};
