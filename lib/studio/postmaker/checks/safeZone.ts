// The safe-zone report (quality S5 automated check; rubric C3): a box-intersection list over every 3rd frame and
// every cut frame of a timeline, with zero intersections required. The boxes are the composition's slots
// (render/slots.ts) at rest: text layers (caption, bubble, tag) and the end card must sit inside the text area and
// clear the rail; chant and reveal words are measured with the bundled face when a measure is given; the AI pill and
// the phone insert (critical content) must clear every reserve. Stickers are decoration and are not checked. Entry
// motion (a phone rising from below) is not part of the box: the report checks where each layer rests.
import { checkBox, type Box, type CanvasId, type ZoneViolation } from '../render/safeZones';
import { aiLabelBox, centredWordBox, endCardBox, PHONE_SLOT, TEXT_WIDTH, textLayerBox } from '../render/slots';
import type { Timeline, TimelineElement } from '../render/timeline';
import { typeScale } from '../render/typeScale';

/** Width in px of `text` at `sizePx` in a face role and weight (bundled-font measurement). */
export type FaceMeasure = (text: string, sizePx: number, face: 'text' | 'display' | 'latin', weight: number) => number;

export interface SafeZoneHit extends ZoneViolation {
  frame: number;
  layer: string;
  box: Box;
}

export interface SafeZoneReport {
  canvas: CanvasId;
  sampling: 'every 3rd frame and every cut frame';
  framesChecked: number;
  boxesChecked: number;
  hits: SafeZoneHit[];
}

export interface Slot {
  id: string;
  /** The element kind the slot belongs to (`ai-label` for the AI pill). */
  kind: TimelineElement['kind'] | 'ai-label';
  from: number;
  to: number;
  box: Box;
  text: boolean;
}

/** The resting box of every checked layer (exported for the render measurements, `measurements` port). */
export function slotsOf(t: Pick<Timeline, 'elements' | 'aiLabel' | 'durationInFrames'>, measure?: FaceMeasure): Slot[] {
  const out: Slot[] = [];
  const add = (e: TimelineElement, box: Box, text: boolean) => out.push({ id: e.id, kind: e.kind, from: e.from, to: e.to, box, text });
  for (const e of t.elements) {
    if (e.kind === 'caption' || e.kind === 'bubble' || e.kind === 'tag') add(e, textLayerBox(e), true);
    else if (e.kind === 'endcard') add(e, endCardBox(e), true);
    else if (e.kind === 'phone') add(e, PHONE_SLOT, false);
    else if ((e.kind === 'card' && e.text) || e.kind === 'reveal') {
      const text = e.kind === 'card' ? e.text! : (e.steps.at(-1)?.text ?? '');
      const lh = typeScale('chant', e.lang).lineHeight ?? 1.25;
      const w = measure ? measure(text, e.sizePx, e.latin ? 'latin' : 'display', 900) : TEXT_WIDTH;
      add(e, centredWordBox(e.sizePx, lh, w), true);
    }
  }
  const lang = t.aiLabel.lang;
  const label = measure ? measure(t.aiLabel.text, typeScale('ai-label', lang).size, lang === 'fa' ? 'text' : 'latin', 600) : 400;
  out.push({ id: 'ai-label', kind: 'ai-label', from: 0, to: t.durationInFrames, box: aiLabelBox(lang, label), text: false });
  return out;
}

export function safeZoneReport(t: Pick<Timeline, 'elements' | 'aiLabel' | 'durationInFrames' | 'cutFrames'>, o: { measure?: FaceMeasure; canvas?: CanvasId } = {}): SafeZoneReport {
  const canvas = o.canvas ?? 'reel';
  const frames = new Set<number>();
  for (let f = 0; f < t.durationInFrames; f += 3) frames.add(f);
  for (const f of t.cutFrames) if (f >= 0 && f < t.durationInFrames) frames.add(f);
  const slots = slotsOf(t, o.measure);
  const verdicts = new Map(slots.map((s) => [s, checkBox(canvas, s.box, { text: s.text, critical: true })]));
  const hits: SafeZoneHit[] = [];
  let boxesChecked = 0;
  for (const f of [...frames].sort((a, b) => a - b))
    for (const s of slots) {
      if (f < s.from || f >= s.to) continue;
      boxesChecked++;
      for (const v of verdicts.get(s)!) hits.push({ ...v, frame: f, layer: s.id, box: s.box });
    }
  return { canvas, sampling: 'every 3rd frame and every cut frame', framesChecked: frames.size, boxesChecked, hits };
}
