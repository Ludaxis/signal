// Type sizes at 1080 px width (roles from the animation guide). FA size = EN size × 1.1,
// rounded to an even number, with more leading. `typeScale(role, lang)` gives the default size (the middle of the
// range, even) plus the range, line-height, weight and limits; `validateTextLayers` fails any layer below the
// absolute minimum and names the layer id. Pure module: no imports (shared with the Remotion bundle).

export type TypeRole = 'chant' | 'hook' | 'caption' | 'bubble' | 'tag' | 'feed-headline' | 'feed-body' | 'endcard-tagline' | 'endcard-sub' | 'ai-label';
export type TypeLang = 'fa' | 'en';

export interface TypeSpec {
  role: TypeRole;
  lang: TypeLang;
  /** Default size (px): the middle of the range, rounded to an even number. */
  size: number;
  range: [number, number];
  lineHeight: number | null;
  weight: [number, number];
  maxLines: number | null;
  /** Characters per line, or words per line for chant/caption (see `limitUnit`). */
  maxPerLine: number | null;
  limitUnit: 'chars' | 'words' | null;
  /** Static text never animates (the AI label). */
  static: boolean;
}

interface Row {
  en: [number, number];
  fa: [number, number];
  weight: [number, number];
  lh: { en: number | null; fa: number | null };
  maxLines: number | null;
  perLine: { en: number | null; fa: number | null };
  unit: 'chars' | 'words' | null;
  static?: boolean;
}

export const TYPE_TABLE: Record<TypeRole, Row> = {
  chant: { en: [160, 240], fa: [176, 264], weight: [900, 900], lh: { en: 1.0, fa: 1.25 }, maxLines: 1, perLine: { en: 1, fa: 1 }, unit: 'words' },
  hook: { en: [88, 120], fa: [96, 132], weight: [800, 900], lh: { en: 1.1, fa: 1.4 }, maxLines: 2, perLine: { en: 18, fa: 16 }, unit: 'chars' },
  caption: { en: [64, 84], fa: [70, 92], weight: [700, 800], lh: { en: 1.15, fa: 1.45 }, maxLines: 2, perLine: { en: 5, fa: 5 }, unit: 'words' },
  bubble: { en: [48, 60], fa: [52, 66], weight: [700, 700], lh: { en: 1.2, fa: 1.5 }, maxLines: 2, perLine: { en: 22, fa: 22 }, unit: 'chars' },
  tag: { en: [36, 44], fa: [40, 48], weight: [700, 700], lh: { en: 1.0, fa: 1.3 }, maxLines: 1, perLine: { en: 16, fa: 16 }, unit: 'chars' },
  'feed-headline': { en: [92, 112], fa: [100, 124], weight: [800, 900], lh: { en: 1.1, fa: 1.4 }, maxLines: 2, perLine: { en: null, fa: null }, unit: null },
  'feed-body': { en: [40, 52], fa: [44, 58], weight: [500, 600], lh: { en: 1.3, fa: 1.6 }, maxLines: null, perLine: { en: 32, fa: 32 }, unit: 'chars' },
  'endcard-tagline': { en: [72, 96], fa: [80, 104], weight: [800, 800], lh: { en: 1.15, fa: 1.4 }, maxLines: 2, perLine: { en: null, fa: null }, unit: null },
  'endcard-sub': { en: [36, 44], fa: [40, 48], weight: [500, 500], lh: { en: 1.3, fa: 1.5 }, maxLines: 1, perLine: { en: null, fa: null }, unit: null },
  'ai-label': { en: [24, 24], fa: [26, 26], weight: [600, 600], lh: { en: null, fa: null }, maxLines: 1, perLine: { en: null, fa: null }, unit: null, static: true },
};

/** Absolute minimum sizes: anything smaller fails C2. The AI label row is exempt (its own size). */
export const MIN_SIZE: Record<'video' | 'feed', Record<TypeLang, number>> = {
  video: { en: 36, fa: 40 },
  feed: { en: 32, fa: 36 },
};

const even = (n: number) => 2 * Math.round(n / 2);

export function typeScale(role: TypeRole, lang: TypeLang): TypeSpec {
  const r = TYPE_TABLE[role];
  const range = r[lang];
  return {
    role,
    lang,
    size: even((range[0] + range[1]) / 2),
    range,
    lineHeight: r.lh[lang],
    weight: r.weight,
    maxLines: r.maxLines,
    maxPerLine: r.perLine[lang],
    limitUnit: r.unit,
    static: Boolean(r.static),
  };
}

/** The FA size for an EN size (rule): × 1.1, rounded to an even number. */
export const faSizeOf = (enPx: number): number => even(enPx * 1.1);

export interface TextLayerSize {
  id: string;
  role: TypeRole;
  lang: TypeLang;
  sizePx: number;
}

export interface TypeViolation {
  layerId: string;
  rule: 'below-minimum' | 'outside-range';
  message: string;
}

/** Render validation (quality): a layer below the absolute minimum fails with its id. */
export function validateTextLayers(layers: TextLayerSize[], medium: 'video' | 'feed' = 'video'): TypeViolation[] {
  const out: TypeViolation[] = [];
  for (const l of layers) {
    const min = MIN_SIZE[medium][l.lang];
    const spec = typeScale(l.role, l.lang);
    if (l.role !== 'ai-label' && l.sizePx < min) {
      out.push({ layerId: l.id, rule: 'below-minimum', message: `Layer ${l.id} is ${l.sizePx} px; the minimum is ${min} px` });
      continue;
    }
    if (l.sizePx < spec.range[0] || l.sizePx > spec.range[1]) out.push({ layerId: l.id, rule: 'outside-range', message: `Layer ${l.id} is ${l.sizePx} px; ${l.role} is ${spec.range[0]}-${spec.range[1]} px` });
  }
  return out;
}
