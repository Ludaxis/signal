// timeline.json (S5 shape): the props of the `StorySpine` composition.
// A superset of graph/adapters.ts `TimelineDoc` (fps, durationInFrames, layers, captions, coverFrame), so the
// contracts and the free adapters keep reading it. Everything the composition draws is precomputed here as frames;
// the composition only evaluates curves at the current frame. Pure module: no imports outside render/.
import type { CurveId } from './curves';
import type { PresetId, SegmentId, TransitionId } from './presets';
import type { TypeRole } from './typeScale';

export type TimelineLang = 'fa' | 'en';

export interface TimelineFont {
  family: string;
  /** text = captions and body; display = chant, reveal, hook; latin = Latin runs inside any text. */
  role: 'text' | 'display' | 'latin';
  /** Path served by the render bundle (relative to its public dir). */
  src: string;
  sha256: string;
  weights: string;
}

export interface TimelineToken {
  text: string;
  /** A Latin run (brand name, number with unit, handle): its own span in the Latin face, isolated with <bdi>. */
  latin: boolean;
  /** Absolute frame the token's curve starts. */
  enter: number;
  curve: Extract<CurveId, 'pop-in' | 'slide-in'>;
  emphasis?: boolean;
  highlight?: boolean;
}

interface Base {
  id: string;
  from: number;
  /** Exclusive end frame. */
  to: number;
}

export interface SceneEl extends Base {
  kind: 'scene';
  beatId: string;
  segment: SegmentId;
  preset: PresetId;
  /** Background colour (palette role resolved). */
  background: string;
  accent: string;
  transitionIn: TransitionId;
  /** Camera push-in / pull-back: start frame, frames, direction. */
  camera?: { at: number; frames: number; scaleTo: number };
}

export interface TextEl extends Base {
  kind: 'caption' | 'bubble' | 'tag';
  role: TypeRole;
  lang: TimelineLang;
  zone: 'headline' | 'lower' | 'top-row';
  /** Broken lines of tokens, in logical (reading) order. */
  lines: TimelineToken[][];
  /** Frame the out-fast exit starts (the element is gone at `to`). */
  exitAt: number | null;
  style: 'plate-highlight' | 'plate' | 'outline' | 'scrim' | 'bubble' | 'pill';
  sizePx: number;
  lineHeight: number;
}

export interface CardEl extends Base {
  kind: 'card';
  /** A chant card's brand word or an interrupt card (no text). */
  text: string | null;
  latin: boolean;
  lang: TimelineLang;
  colour: string;
  textColour: string;
  /** Frame of the card-hit punch (second beat of the card). */
  hitAt: number | null;
  sizePx: number;
}

/** The reveal's fixed full-frame fill (drawn by StorySpine; counted by the flash lint). */
export const REVEAL_FILL = '#16161D';

export interface RevealEl extends Base {
  kind: 'reveal';
  lang: TimelineLang;
  mode: 'zwj-prefix' | 'letter-stagger' | 'word';
  /** zwj-prefix: each step's full text (prefixes ending with U+200D, then the word) and its frame. letter-stagger: one letter per step. */
  steps: { text: string; at: number }[];
  punchAt: number;
  latin: boolean;
  sizePx: number;
  colour: string;
  confettiSeed: number;
}

export interface StickerEl extends Base {
  kind: 'sticker';
  shape: 'star' | 'burst' | 'heart' | 'check';
  x: number;
  y: number;
  size: number;
  colour: string;
}

export interface PhoneEl extends Base {
  kind: 'phone';
  enterFrames: number;
  /** Swipe targets in phone-local px and the frame each is reached. */
  targets: { x: number; y: number; at: number }[];
  fingerAt: number;
}

export interface EndCardEl extends Base {
  kind: 'endcard';
  lang: TimelineLang;
  iconText: string;
  iconAt: number;
  tagline: TimelineToken[];
  sub: { text: string; at: number } | null;
  cta: { text: string; at: number };
  pulses: number[];
  colour: string;
  accent: string;
}

export type TimelineElement = SceneEl | TextEl | CardEl | RevealEl | StickerEl | PhoneEl | EndCardEl;

export interface AudioClip {
  id: string;
  kind: 'voice' | 'music' | 'sfx';
  /** Served path inside the render bundle, or null when the file is attached at render time. */
  src: string | null;
  from: number;
  frames: number;
  lineId?: string;
}

/** A pacing beat (quality): a new caption page, a cut, a pose change, a sticker pop, a camera move start. */
export interface PacingEvent {
  frame: number;
  kind: 'page' | 'cut' | 'pose' | 'sticker' | 'camera' | 'card' | 'reveal-step';
}

export interface Timeline {
  schema: 'signal.pm.timeline/1';
  fps: 30;
  width: 1080;
  height: 1920;
  durationInFrames: number;
  lang: TimelineLang;
  // ---- TimelineDoc compatibility (graph/adapters.ts) ----
  layers: { beatId: string; from: number; to: number }[];
  captions: { lineId: string; text: string; from: number; to: number }[];
  coverFrame: number;
  // ---- the S5 shape ----
  elements: TimelineElement[];
  audio: AudioClip[];
  aiLabel: { text: string; lang: TimelineLang };
  /** Any node in this timeline's lineage ran in mock mode: the diagonal MOCK layer goes on every frame. */
  mock: boolean;
  fonts: TimelineFont[];
  palette: { background: string; backgroundDark: string; text: string; accent: string; plate: string; cards: string[] };
  segments: { beatId: string; segment: SegmentId; preset: PresetId; from: number; to: number }[];
  cutFrames: number[];
  /** The declared music grid (frames of every beat onset) and frames per beat. */
  grid: { bpm: number; bf: number; beats: number[]; chantBeatsPerCard: 2 | 4 };
  events: PacingEvent[];
  marks: { hookComplete: number | null; firstHookTokenOpaque: number | null };
}

/** The TimelineDoc view (for the free adapters and contracts). */
export const timelineDocOf = (t: Pick<Timeline, 'fps' | 'durationInFrames' | 'layers' | 'captions' | 'coverFrame'>) => ({
  fps: t.fps,
  durationInFrames: t.durationInFrames,
  layers: t.layers,
  captions: t.captions,
  coverFrame: t.coverFrame,
});

/** Is this a full S5 timeline (from the compose executor) rather than a rebuilt TimelineDoc? */
export const isFullTimeline = (t: unknown): t is Timeline => Boolean(t && typeof t === 'object' && (t as { schema?: string }).schema === 'signal.pm.timeline/1');
