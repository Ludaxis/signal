// `StorySpine` (quality S5): draws a timeline.json frame by frame. Compose already decided every frame; this
// component only evaluates the curves at the current frame. Layers, bottom to top: scenes (with idles and camera),
// the cast (the compiled characters of `timeline.motion`, CastLayer), cards, phone, stickers, text (captions,
// bubbles), reveal, end card, AI label (every frame), MOCK (every frame of a mock lineage). A scene with a background
// image from the scene plan draws it as a cover plate under the cast. Persian blocks are lang="fa" dir="rtl"; tokens
// are laid out by the browser.
import React from 'react';
import { AbsoluteFill, Html5Audio, Img, staticFile, useCurrentFrame } from 'remotion';
import { curveAt, settleProgress } from '../curves';
import { REEL_BANDS } from '../safeZones';
import { PHONE_SLOT, textSlot } from '../slots';
import { REVEAL_FILL, type CardEl, type PhoneEl, type RevealEl, type SceneEl, type TextEl, type Timeline, type TimelineElement } from '../timeline';
import { typeScale } from '../typeScale';
import { AiLabel } from '../components/AiLabel';
import { CastLayer } from '../components/CastLayer';
import { FacesContext, Fill, SplitCharsContext, useFaces } from '../components/context';
import { EndCard } from '../components/EndCard';
import { KineticText } from '../components/KineticText';
import { KineticTextFa } from '../components/KineticTextFa';
import { MockWatermark } from '../components/MockWatermark';
import { Sticker } from '../components/Sticker';
import { facesOf, loadTimelineFonts } from './fonts';

export interface StorySpineProps extends Record<string, unknown> {
  timeline: Timeline;
  /** The mastered audio, served by the bundle, or null (silent preview stills). */
  master: string | null;
  /** Test-only: split Persian tokens per character (the golden guard must catch it). */
  splitChars?: boolean;
}

const live = (e: TimelineElement, f: number) => f >= e.from && f < e.to;

const Scene: React.FC<{ el: SceneEl; frame: number }> = ({ el, frame }) => {
  const local = frame - el.from;
  const breath = 1 + 0.012 * Math.sin((2 * Math.PI * local) / 72);
  const cam = el.camera ? 1 + (el.camera.scaleTo - 1) * settleProgress(frame - el.camera.at, el.camera.frames) : 1;
  const fade = el.transitionIn === 'crossfade' ? Math.min(1, Math.max(0, local / 8)) ** 2 : 1;
  return (
    <Fill layer={`scene-${el.beatId}`} style={{ background: el.background, opacity: fade, transform: `scale(${cam})` }}>
      {el.image ? <Img data-layer="background" src={el.image.startsWith('data:') ? el.image : staticFile(el.image)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      {el.segment === 'interrupt' || el.image ? null : (
        <div
          style={{
            position: 'absolute',
            left: 340,
            top: REEL_BANDS.action[0] + 180,
            width: 400,
            height: 400,
            borderRadius: '50%',
            background: el.accent,
            opacity: 0.22,
            transform: `scale(${breath})`,
          }}
        />
      )}
    </Fill>
  );
};

const Card: React.FC<{ el: CardEl; frame: number }> = ({ el, frame }) => {
  const faces = useFaces();
  const pop = curveAt('pop-in', frame - el.from);
  const hit = el.hitAt === null ? 1 : curveAt('punch', frame - el.hitAt).scale;
  return (
    <Fill layer="card" style={{ background: el.colour, alignItems: 'center', justifyContent: 'center' }}>
      {el.text ? (
        <div
          lang={el.lang}
          dir={el.lang === 'fa' ? 'rtl' : 'ltr'}
          style={{ fontFamily: el.latin ? faces.latin : faces.display, fontWeight: 900, fontSize: el.sizePx, lineHeight: el.lang === 'fa' ? 1.25 : 1, color: el.textColour, letterSpacing: 0, opacity: pop.opacity, transform: `scale(${pop.scale * hit})` }}
        >
          {el.latin ? <bdi dir="ltr">{el.text}</bdi> : el.text}
        </div>
      ) : null}
    </Fill>
  );
};

const Reveal: React.FC<{ el: RevealEl; frame: number }> = ({ el, frame }) => {
  const faces = useFaces();
  const punch = curveAt('punch', frame - el.punchAt).scale;
  const style: React.CSSProperties = { fontFamily: el.latin ? faces.latin : faces.display, fontWeight: 900, fontSize: el.sizePx, lineHeight: el.lang === 'fa' ? 1.25 : 1, color: el.colour, letterSpacing: 0, transform: `scale(${punch})` };
  let body: React.ReactNode = null;
  if (el.mode === 'zwj-prefix') {
    const step = [...el.steps].reverse().find((s) => s.at <= frame);
    const first = curveAt('pop-in', frame - (el.steps[0]?.at ?? el.from));
    body = step ? <span style={{ display: 'inline-block', opacity: first.opacity }}>{step.text}</span> : null;
  } else {
    body = el.steps.map((s, k) => {
      const c = curveAt('pop-in', frame - s.at);
      return (
        <span key={k} style={{ display: 'inline-block', opacity: c.opacity, transform: `scale(${c.scale})` }}>
          {s.text}
        </span>
      );
    });
  }
  return (
    <Fill layer="reveal" style={{ background: REVEAL_FILL, alignItems: 'center', justifyContent: 'center' }}>
      <Confetti seed={el.confettiSeed} from={el.punchAt} frame={frame} />
      <div lang={el.lang} dir={el.lang === 'fa' && !el.latin ? 'rtl' : 'ltr'} style={style}>
        {body}
      </div>
    </Fill>
  );
};

/** Seeded confetti particles (deterministic from the run seed): x, fall speed, start y and spin per particle. */
export function confettiParticles(seed: number, n = 48): { x: number; v: number; y0: number; rot: number }[] {
  let s = seed >>> 0 || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: n }, () => ({ x: 80 + rnd() * 920, v: 6 + rnd() * 10, y0: 300 + rnd() * 200, rot: rnd() * 360 }));
}

const CONFETTI_COLOURS = ['#E4572E', '#F3A712', '#669BBC', '#A8C686', '#FFFFFF'];

const Confetti: React.FC<{ seed: number; from: number; frame: number }> = ({ seed, from, frame }) => {
  const t = frame - from;
  if (t < 0) return null;
  return (
    <>
      {confettiParticles(seed).map((p, k) => {
        const y = p.y0 + t * p.v - 0.5 * t;
        return <div key={k} style={{ position: 'absolute', left: p.x, top: Math.min(y, 1460), width: 18, height: 28, background: CONFETTI_COLOURS[k % CONFETTI_COLOURS.length], transform: `rotate(${p.rot + t * 8}deg)`, opacity: y > 1460 ? 0 : 1 }} />;
      })}
    </>
  );
};

const Phone: React.FC<{ el: PhoneEl; frame: number }> = ({ el, frame }) => {
  const rise = settleProgress(frame - el.from, el.enterFrames);
  const finger = curveAt('pop-in', frame - el.fingerAt);
  const pts = [{ x: 300, y: 860, at: el.fingerAt + 8 }, ...el.targets];
  let fx = pts[0]!.x;
  let fy = pts[0]!.y;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    if (frame >= b.at) {
      fx = b.x;
      fy = b.y;
    } else if (frame > a.at) {
      const u = (frame - a.at) / (b.at - a.at);
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      fx = a.x + (b.x - a.x) * e;
      fy = a.y + (b.y - a.y) * e;
      break;
    }
  }
  return (
    <div data-layer="phone" style={{ position: 'absolute', left: PHONE_SLOT.x, top: PHONE_SLOT.y + (1 - rise) * 800, width: PHONE_SLOT.width, height: PHONE_SLOT.height, borderRadius: 64, background: '#16161D', padding: 22 }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 44, background: '#FFFFFF', overflow: 'hidden' }}>
        {el.targets.map((t, k) => {
          const sel = curveAt('punch', frame - t.at, { peak: 1.06 }).scale;
          return <div key={k} style={{ position: 'absolute', left: t.x - 50, top: t.y - 50, width: 100, height: 100, borderRadius: 24, background: frame >= t.at ? '#A8C686' : '#D9D4CC', transform: `scale(${sel})` }} />;
        })}
        <div style={{ position: 'absolute', left: fx - 34 - 22, top: fy - 34 - 22 - 120, width: 68, height: 68, borderRadius: '50%', background: 'rgba(22,22,29,0.55)', border: '6px solid #FFFFFF', opacity: finger.opacity, transform: `scale(${finger.scale})` }} />
      </div>
    </div>
  );
};

const TextLayer: React.FC<{ el: TextEl; frame: number; t: Timeline }> = ({ el, frame, t }) => {
  const slot = textSlot(el.zone);
  const weight = typeScale(el.role, el.lang).weight[1];
  const plate = el.style === 'plate' || el.style === 'plate-highlight' || el.style === 'bubble' ? t.palette.plate : null;
  const Comp = el.lang === 'fa' ? KineticTextFa : KineticText;
  return (
    <div data-layer={el.kind} style={{ position: 'absolute', left: slot.left, width: slot.width, top: slot.top }}>
      <Comp frame={frame} lines={el.lines} lang={el.lang} sizePx={el.sizePx} lineHeight={el.lineHeight} weight={weight} colour={t.palette.text} accent={t.palette.accent} exitAt={el.exitAt} plate={plate} />
    </div>
  );
};

export const StorySpine: React.FC<StorySpineProps> = ({ timeline, master, splitChars }) => {
  const frame = useCurrentFrame();
  loadTimelineFonts(timeline.fonts);
  const faces = facesOf(timeline.fonts);
  const now = timeline.elements.filter((e) => live(e, frame));
  const order: TimelineElement['kind'][] = ['scene', 'card', 'phone', 'sticker', 'caption', 'bubble', 'tag', 'reveal', 'endcard'];
  now.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <FacesContext.Provider value={faces}>
      <SplitCharsContext.Provider value={Boolean(splitChars)}>
        <AbsoluteFill style={{ background: timeline.palette.background, overflow: 'hidden' }}>
          {now.filter((e) => e.kind === 'scene').map((e) => (e.kind === 'scene' ? <Scene key={e.id} el={e} frame={frame} /> : null))}
          <CastLayer timeline={timeline} frame={frame} />
          {now.map((e) => {
            switch (e.kind) {
              case 'scene':
                return null;
              case 'card':
                return <Card key={e.id} el={e} frame={frame} />;
              case 'phone':
                return <Phone key={e.id} el={e} frame={frame} />;
              case 'sticker':
                return <Sticker key={e.id} el={e} frame={frame} />;
              case 'caption':
              case 'bubble':
              case 'tag':
                return <TextLayer key={e.id} el={e} frame={frame} t={timeline} />;
              case 'reveal':
                return <Reveal key={e.id} el={e} frame={frame} />;
              case 'endcard':
                return <EndCard key={e.id} el={e} frame={frame} textColour={timeline.palette.text} />;
            }
          })}
          <AiLabel text={timeline.aiLabel.text} lang={timeline.aiLabel.lang} />
          {timeline.mock ? <MockWatermark family={faces.latin} /> : null}
          {master ? <Html5Audio src={staticFile(master)} /> : null}
        </AbsoluteFill>
      </SplitCharsContext.Provider>
    </FacesContext.Provider>
  );
};
