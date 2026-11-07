// The deterministic layout engine: preset rows (presets.ts, roles) + a beat's frames, caption pages and tempo
// → timeline elements with absolute frames (timeline.ts). Compose is a pure function of its inputs (quality).
// Token frames follow roles notation: w(i) = onset frame of token i, enter = w(i) − 2 (pop-in, 9 frames),
// land(i) = w(i) − 2 + 6. Persian tokens keep logical (reading) order; the browser lays them out right to left, so
// token 0 (the earliest) is the rightmost. Pure module: no imports outside render/.
import { presetForSegment, TRANSITION_FRAMES, type SegmentId } from './presets';
import type { AudioClip, CardEl, EndCardEl, PacingEvent, PhoneEl, RevealEl, SceneEl, StickerEl, TextEl, Timeline, TimelineElement, TimelineFont, TimelineLang, TimelineToken } from './timeline';
import { typeScale } from './typeScale';
import { letterStagger, zwjPrefixes, zwjStepFrames } from './zwj';

export interface LayoutWord {
  text: string;
  latin: boolean;
  /** From the start of the beat. */
  beatOffsetMs: number;
}

export interface LayoutPage {
  lineId: string;
  beatId: string;
  text: string;
  beatOffsetMs: number;
  durationMs: number;
  words?: LayoutWord[];
  breaks?: number[];
  highlight?: number | null;
  emphasis?: number | null;
}

export interface LayoutBeat {
  id: string;
  segment: SegmentId;
  techniques: string[];
  from: number;
  to: number;
}

export interface Palette {
  background: string;
  backgroundDark: string;
  text: string;
  accent: string;
  plate: string;
  cards: string[];
}

/** A neutral core palette (a pack's palette replaces it). */
export const CORE_PALETTE: Palette = {
  background: '#F4EFE6',
  backgroundDark: '#16161D',
  text: '#16161D',
  accent: '#F2B705',
  plate: '#FFFFFF',
  cards: ['#E4572E', '#29335C', '#F3A712', '#669BBC', '#A8C686'],
};

export interface ComposeLayoutInput {
  lang: TimelineLang;
  beats: LayoutBeat[];
  pages: LayoutPage[];
  /** Speaker per line id (narrator lines are captions; other speakers in `story` are bubbles). */
  speakers?: Record<string, string>;
  tempo: { bpm: number; downbeatMs: number; chantBeatsPerCard: 2 | 4 };
  brand: { text: string; latin: boolean } | null;
  endcard: { tagline: string; sub: string | null; cta: string; iconText: string };
  aiLabel: string;
  palette?: Palette;
  fonts: TimelineFont[];
  mock: boolean;
  seed: number;
  audio?: AudioClip[];
  coverFrame?: number;
}

const FPS = 30;
const msToFrames = (ms: number) => Math.round((ms * FPS) / 1000);
const LATIN = /[A-Za-z]/;

/** The declared grid: every beat onset (frames) from the first downbeat. */
export function beatGrid(bpm: number, downbeatMs: number, totalFrames: number): { bf: number; beats: number[] } {
  const bf = Math.round(1800 / bpm);
  const beats: number[] = [];
  const msPerBeat = 60000 / bpm;
  for (let j = 0; ; j++) {
    const f = Math.round(((downbeatMs + j * msPerBeat) * FPS) / 1000);
    if (f >= totalFrames) break;
    beats.push(f);
  }
  return { bf, beats };
}

function tokensOf(page: LayoutPage, beatFrom: number, floor: number): { tokens: TimelineToken[]; lines: TimelineToken[][] } {
  const words: LayoutWord[] =
    page.words ??
    page.text
      .split(/\s+/)
      .filter(Boolean)
      .map((text, k, all) => ({ text, latin: LATIN.test(text) && !/[؀-ۿ]/.test(text), beatOffsetMs: page.beatOffsetMs + (page.durationMs * k) / Math.max(1, all.length) }));
  let last = -Infinity;
  const tokens = words.map((w, k) => {
    const enter = Math.max(floor, beatFrom + msToFrames(w.beatOffsetMs) - 2, last);
    last = enter;
    return { text: w.text, latin: w.latin, enter, curve: 'pop-in' as const, ...(page.highlight === k ? { highlight: true } : {}), ...(page.emphasis === k ? { emphasis: true } : {}) };
  });
  const cut = page.breaks?.[0];
  const lines = cut && cut > 0 && cut < tokens.length ? [tokens.slice(0, cut), tokens.slice(cut)] : [tokens];
  return { tokens, lines };
}

export function layoutTimeline(i: ComposeLayoutInput): Timeline {
  const palette = i.palette ?? CORE_PALETTE;
  const total = i.beats.at(-1)?.to ?? 0;
  const grid = beatGrid(i.tempo.bpm, i.tempo.downbeatMs, total);
  const n = i.tempo.chantBeatsPerCard;
  const elements: TimelineElement[] = [];
  const events: PacingEvent[] = [];
  const marks: Timeline['marks'] = { hookComplete: null, firstHookTokenOpaque: null };
  const segments = i.beats.map((b) => ({ beatId: b.id, segment: b.segment, preset: presetForSegment(b.segment), from: b.from, to: b.to }));
  const captionSize = typeScale('caption', i.lang);
  const bubbleSize = typeScale('bubble', i.lang);
  let cardIndex = 0;
  let previous: SceneEl | null = null;

  for (const b of i.beats) {
    const preset = presetForSegment(b.segment);
    const S = b.from;
    const E = b.to;
    const dark = b.segment === 'interrupt';
    const transitionIn: SceneEl['transitionIn'] = b.segment === 'interrupt' || b.segment === 'chant' ? 'card-cut' : b.segment === 'endcard' && previous?.segment === 'reveal' ? 'crossfade' : b.segment === 'demo' ? 'iris' : 'cut';
    const scene: SceneEl = { id: `scene-${b.id}`, kind: 'scene', beatId: b.id, segment: b.segment, preset, background: dark ? palette.backgroundDark : palette.background, accent: palette.accent, from: S, to: E, transitionIn };
    if (b.segment === 'hook' && E - S >= 240) scene.camera = { at: S + Math.round((E - S) / 3), frames: 60, scaleTo: 1.06 };
    if (b.segment === 'escalation') scene.camera = { at: S + 15, frames: 60, scaleTo: 0.94 };
    if (scene.camera) events.push({ frame: scene.camera.at, kind: 'camera' });
    if (b.segment !== 'chant') {
      elements.push(scene);
      events.push({ frame: S, kind: 'cut' });
    }
    previous = scene;

    // ---- caption pages (hook, story, interrupt bubbles, demo instruction) ----
    const pages = i.pages.filter((p) => p.beatId === b.id);
    const textual = b.segment !== 'chant' && b.segment !== 'reveal' && b.segment !== 'endcard';
    if (textual) {
      const floor = b.segment === 'interrupt' ? S + 6 : b.segment === 'hook' ? S : S + 1;
      const built = pages.map((p) => tokensOf(p, S, floor));
      if (b.segment === 'hook' && built[0]?.tokens[0]) {
        const t0 = built[0].tokens[0];
        t0.enter = Math.max(S, Math.min(t0.enter, S + 9)); // H3: legible by S + 15
        marks.firstHookTokenOpaque = t0.enter + 6;
        const firstLine = pages[0]!.lineId;
        const hookTokens = built.filter((_, k) => pages[k]!.lineId === firstLine).flatMap((x) => x.tokens);
        marks.hookComplete = (hookTokens.at(-1)?.enter ?? t0.enter) + 6;
      }
      built.forEach((bt, k) => {
        const p = pages[k]!;
        const from = bt.tokens[0]?.enter ?? S;
        const nextEnter = built[k + 1]?.tokens[0]?.enter;
        const exitAt = nextEnter !== undefined ? Math.max(from + 9, nextEnter - 4) : Math.max(from + 9, E - 4);
        const bubble = b.segment === 'interrupt' || (b.segment === 'story' && (i.speakers?.[p.lineId] ?? 'narrator') !== 'narrator');
        const size = bubble ? bubbleSize : captionSize;
        const el: TextEl = {
          id: `page-${p.lineId}-${k}`,
          kind: bubble ? 'bubble' : 'caption',
          role: bubble ? 'bubble' : 'caption',
          lang: i.lang,
          zone: 'headline',
          lines: bt.lines,
          exitAt: Math.min(exitAt, E - 4),
          style: bubble ? 'bubble' : 'plate-highlight',
          sizePx: size.size,
          lineHeight: size.lineHeight ?? 1.3,
          from,
          to: Math.min(exitAt, E - 4) + 4,
        };
        elements.push(el);
        events.push({ frame: from, kind: 'page' });
      });
    }

    // ---- stickers (hook): at word onsets, ≥ 20 frames apart; H10 beat guard keeps gaps ≤ 90 frames ----
    if (b.segment === 'hook' || b.segment === 'story') {
      const want = b.techniques.includes('emoji-sticker') ? 3 : 0;
      const onsets = pages.flatMap((p) => tokensOf(p, S, S).tokens.map((t) => t.enter + 2));
      const at: number[] = [];
      for (const f of onsets) if (at.length < want && (at.length === 0 || f - at.at(-1)! >= 20) && f > S + 20) at.push(f);
      const shapes: StickerEl['shape'][] = ['star', 'burst', 'heart', 'check'];
      at.forEach((f, k) => {
        elements.push({ id: `sticker-${b.id}-${k}`, kind: 'sticker', shape: shapes[k % shapes.length]!, x: k % 2 ? 300 : 780, y: 860 + 140 * (k % 3), size: 150, colour: palette.cards[k % palette.cards.length]!, from: f, to: E });
        events.push({ frame: f, kind: 'sticker' });
      });
    }

    // ---- demo: phone insert, finger, swipe through 2 targets, feedback sticker ----
    if (b.segment === 'demo') {
      const len = E - S;
      const t1 = S + 24 + Math.round(len * 0.25);
      const t2 = Math.min(E - 20, t1 + Math.round(len * 0.25));
      const phone: PhoneEl = { id: `phone-${b.id}`, kind: 'phone', enterFrames: 16, fingerAt: S + 16, targets: [{ x: 120, y: 420, at: t1 }, { x: 300, y: 620, at: t2 }], from: S, to: E };
      elements.push(phone);
      events.push({ frame: S + 16, kind: 'pose' }, { frame: t1, kind: 'pose' }, { frame: t2, kind: 'pose' });
      elements.push({ id: `feedback-${b.id}`, kind: 'sticker', shape: 'check', x: 760, y: 900, size: 160, colour: palette.accent, from: t2 + 2, to: E });
      events.push({ frame: t2 + 2, kind: 'sticker' });
    }

    // ---- chant: cards on beat onsets of the declared grid, n × bf frames each ----
    if (b.segment === 'chant') {
      const starts = grid.beats.filter((f) => f >= S - 2 && f < E);
      const cuts: number[] = [];
      for (let k = 0; k < starts.length; k += n) {
        const f = starts[k]!;
        if (f + 30 > E + 2) break;
        cuts.push(f);
      }
      if (cuts.length === 0) cuts.push(S);
      // The previous scene holds until the first card cut (cards cut only on beats).
      const prevScene = elements.filter((e): e is SceneEl => e.kind === 'scene').at(-1);
      if (prevScene && cuts[0]! > S) prevScene.to = cuts[0]!;
      const sizeChant = typeScale('chant', i.lang).size;
      cuts.forEach((f, k) => {
        const to = k + 1 < cuts.length ? cuts[k + 1]! : E;
        const colour = palette.cards[cardIndex++ % palette.cards.length]!;
        const card: CardEl = { id: `card-${b.id}-${k}`, kind: 'card', text: i.brand?.text ?? null, latin: i.brand?.latin ?? false, lang: i.lang, colour, textColour: '#FFFFFF', hitAt: f + grid.bf < to ? f + grid.bf : null, sizePx: sizeChant, from: f, to };
        elements.push(card);
        events.push({ frame: f, kind: 'card' });
      });
    }

    if (b.segment === 'interrupt') events.push({ frame: S, kind: 'card' });

    // ---- reveal: ZWJ prefixes (fa) or letter stagger (en) ----
    if (b.segment === 'reveal' && i.brand) {
      const sizeReveal = typeScale('chant', i.lang).size;
      let el: RevealEl;
      if (i.lang === 'fa' && !i.brand.latin) {
        const steps = zwjPrefixes(i.brand.text);
        const frames = zwjStepFrames(S, steps.length);
        el = { id: `reveal-${b.id}`, kind: 'reveal', lang: i.lang, mode: 'zwj-prefix', steps: steps.map((text, k) => ({ text, at: frames[k]! })), punchAt: frames.at(-1)!, latin: false, sizePx: sizeReveal, colour: palette.accent, confettiSeed: i.seed, from: S, to: E };
      } else {
        const st = letterStagger(S, i.brand.text);
        el = { id: `reveal-${b.id}`, kind: 'reveal', lang: i.lang, mode: 'letter-stagger', steps: st.letters, punchAt: st.punchAt, latin: i.brand.latin, sizePx: sizeReveal, colour: palette.accent, confettiSeed: i.seed, from: S, to: E };
      }
      elements.push(el);
      for (const s of el.steps) events.push({ frame: s.at, kind: 'reveal-step' });
      events.push({ frame: el.punchAt, kind: 'reveal-step' });
    }

    // ---- end card ----
    if (b.segment === 'endcard') {
      const words = i.endcard.tagline.split(/\s+/).filter(Boolean);
      const tagline = words.map((text, k) => ({ text, latin: LATIN.test(text) && !/[؀-ۿ]/.test(text), enter: S + 14 + 5 * k, curve: 'pop-in' as const }));
      const lastLand = (tagline.at(-1)?.enter ?? S + 14) + 6;
      const sub = i.endcard.sub ? { text: i.endcard.sub, at: lastLand + 6 } : null;
      const ctaAt = (sub ? sub.at + 6 : lastLand) + 6;
      const pulses: number[] = [];
      for (let f = ctaAt + 6 + 2 * grid.bf; f <= E - 31; f += 2 * grid.bf) pulses.push(f);
      const el: EndCardEl = { id: `endcard-${b.id}`, kind: 'endcard', lang: i.lang, iconText: i.endcard.iconText, iconAt: S + 4, tagline, sub, cta: { text: i.endcard.cta, at: ctaAt }, pulses, colour: palette.background, accent: palette.accent, from: S, to: E };
      elements.push(el);
      events.push({ frame: S + 4, kind: 'pose' }, { frame: S + 14, kind: 'page' }, { frame: ctaAt, kind: 'page' }, ...pulses.map((f) => ({ frame: f, kind: 'pose' as const })));
    }
  }

  const captions = elements
    .filter((e): e is TextEl => e.kind === 'caption' || e.kind === 'bubble')
    .map((e) => ({ lineId: e.id.replace(/^page-/, '').replace(/-\d+$/, ''), text: e.lines.flat().map((t) => t.text).join(' '), from: e.from, to: e.to }));
  const cutFrames = [...new Set([...segments.slice(1).map((s) => s.from), ...elements.filter((e) => e.kind === 'card').map((e) => e.from)])].sort((a, b) => a - b);
  return {
    schema: 'signal.pm.timeline/1',
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames: total,
    lang: i.lang,
    layers: i.beats.map((b) => ({ beatId: b.id, from: b.from, to: b.to })),
    captions,
    coverFrame: i.coverFrame ?? Math.max(0, total - 1),
    elements,
    audio: i.audio ?? [],
    aiLabel: { text: i.aiLabel, lang: i.lang },
    mock: i.mock,
    fonts: i.fonts,
    palette,
    segments,
    cutFrames,
    grid: { bpm: i.tempo.bpm, bf: grid.bf, beats: grid.beats, chantBeatsPerCard: n },
    events: events.sort((a, b) => a.frame - b.frame),
    marks,
  };
}

/** Frames of a whip-pan or crossfade, for the composition. */
export const transitionFrames = TRANSITION_FRAMES;
