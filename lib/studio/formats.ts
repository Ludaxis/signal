// Format records: what each post format is called and what it needs. The core names no brand or font.
// A project pack may rename formats and state its store and call-to-action lines in <pack>/formats.json
// (loadPackFormats). The default copy makes no store or availability claim: a pack states those in "lines".
//
// Built-in formats work for any project: website-card, codex-post, higgsfield-image, higgsfield-reel.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { packDir } from './pack';
import type { Project } from './projects';

/** All formats. */
export const FORMATS = ['website-card', 'codex-post', 'higgsfield-image', 'higgsfield-reel'] as const;
export type Format = (typeof FORMATS)[number];

export interface FormatRecord {
  id: Format;
  /** Plain label shown in the Studio. */
  label: string;
  /** Made from a written brief ({prompt, headline?, caption?}). */
  brief: boolean;
  /** A brief format that puts the headline on the image. */
  headline: boolean;
  /** Calls the paid Higgsfield API (feature switch "higgsfield"). */
  higgsfield: boolean;
}

const rec = (id: Format, label: string, o: Partial<Omit<FormatRecord, 'id' | 'label'>> = {}): FormatRecord => ({ id, label, brief: false, headline: false, higgsfield: false, ...o });

/** The built-in formats: any project can use them. */
export const BUILT_IN_FORMATS: readonly FormatRecord[] = [
  rec('website-card', 'Website post'),
  rec('codex-post', 'Codex image post', { brief: true, headline: true }),
  rec('higgsfield-image', 'Higgsfield image', { brief: true, headline: true, higgsfield: true }),
  rec('higgsfield-reel', 'Higgsfield Reel', { brief: true, higgsfield: true }),
];
const recordOf = (f: Format) => BUILT_IN_FORMATS.find((r) => r.id === f)!;

export const isFormat = (f: unknown): f is Format => typeof f === 'string' && (FORMATS as readonly string[]).includes(f);
/** Formats that work for any project. */
export const ANY_PROJECT_FORMATS: Format[] = [...FORMATS];
/** Formats made from a written brief rather than from a web page. */
export const BRIEF_FORMATS: Format[] = FORMATS.filter((f) => recordOf(f).brief);
/** Brief formats that put the headline on the image (a Reel gets it on its cover only). */
export const HEADLINE_FORMATS: Format[] = FORMATS.filter((f) => recordOf(f).headline);
/** Formats that call the paid Higgsfield API (feature switch "higgsfield"). */
export const HIGGSFIELD_FORMATS: Format[] = FORMATS.filter((f) => recordOf(f).higgsfield);
/** Built-in labels (a pack may rename formats for its project: FormatSet.labels). */
export const FORMAT_LABEL: Record<Format, string> = Object.fromEntries(FORMATS.map((f) => [f, recordOf(f).label])) as Record<Format, string>;

/** Fills {key} placeholders in one pass (values are never scanned again). Unknown keys stay as written. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

/** The project name as a hashtag ("Fish & Chips' Shop" → "#FishAndChipsShop"). */
export const hashtag = (s: string) => '#' + s.replace(/&/g, 'And').replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

/**
 * Store and availability lines a pack states in formats.json "lines" (named so it cannot be confused with the
 * pack.json "claims" policy of allowed and denied words).
 */
export interface PackLines {
  /** Small line for end cards ({name} allowed). */
  store?: string;
  /** Closing caption line ({name} allowed). */
  cta?: string;
}
export const LINE_KEYS = ['store', 'cta'] as const;

/** Neutral defaults: they name no store and claim no availability. */
export const DEFAULT_LINES: Required<PackLines> = { store: 'Link in bio', cta: '{name} · link in bio' };

/** Everything a project's formats need: which formats, named how, with which store and closing lines. */
export interface FormatSet {
  /** The project name the lines are filled with. */
  name: string;
  formats: Format[];
  labels: Record<Format, string>;
  /** The lines the pack's formats.json stated; empty for the built-in set. */
  lines: PackLines;
  /** Where the set came from: built-in only, or with the project pack's formats.json. */
  from: 'built-in' | 'pack';
  /** Problems with the pack's formats.json (each problem field is ignored, never half-applied). */
  problems: string[];
}

/** The built-in format set of a project (no pack read). */
export function formatSetFor(project: Pick<Project, 'name'>): FormatSet {
  return { name: project.name, formats: [...FORMATS], labels: { ...FORMAT_LABEL }, lines: {}, from: 'built-in', problems: [] };
}

const MAX = { label: 60, line: 120 };
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v : null);

/** Applies a parsed formats.json over a set. Exported for tests. */
export function applyPackFormats(base: FormatSet, raw: unknown): FormatSet {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, problems: ['formats.json is not a JSON object.'] };
  const j = raw as Record<string, unknown>;
  if (j.schema !== undefined && j.schema !== 'signal.formats/1') {
    return { ...base, problems: [/^signal\.formats\/\d+$/.test(String(j.schema)) ? 'formats.json was made by a newer Signal.' : 'formats.json has an unknown schema.'] };
  }
  const out: FormatSet = { ...base, labels: { ...base.labels }, from: 'pack' };
  if (j.labels && typeof j.labels === 'object') {
    for (const [k, v] of Object.entries(j.labels as Record<string, unknown>)) {
      const s = str(v, MAX.label);
      if (isFormat(k) && s) out.labels[k] = s;
      else problems.push(`labels.${k} is not used.`);
    }
  }
  if (j.lines !== undefined) {
    if (j.lines && typeof j.lines === 'object' && !Array.isArray(j.lines)) {
      const lines: PackLines = {};
      for (const [k, v] of Object.entries(j.lines as Record<string, unknown>)) {
        const s = str(v, MAX.line);
        if (!(LINE_KEYS as readonly string[]).includes(k) || !s) {
          problems.push(`lines.${k} is not used.`);
          continue;
        }
        lines[k as (typeof LINE_KEYS)[number]] = s;
      }
      out.lines = lines;
    } else problems.push('lines is not used.');
  }
  // Fields this edition does not read are reported, never applied silently.
  for (const k of ['rotation', 'copy'] as const) if (j[k] !== undefined) problems.push(`${k} is not used.`);
  if (j.claims !== undefined) problems.push('claims is now "lines" (store, cta).');
  return { ...out, problems };
}

/**
 * The project's format set with its pack's formats.json when the project has a pack and the file exists
 * (a project without a pack gets the built-in set unchanged).
 */
export async function loadPackFormats(project: Pick<Project, 'name' | 'pack'>): Promise<FormatSet> {
  const base = formatSetFor(project);
  const dir = packDir(project);
  if (!dir) return base;
  let text: string;
  try {
    text = await fs.readFile(/* turbopackIgnore: true */ path.join(dir, 'formats.json'), 'utf8');
  } catch {
    return base;
  }
  try {
    return applyPackFormats(base, JSON.parse(text));
  } catch {
    return { ...base, problems: ['formats.json is not valid JSON.'] };
  }
}

/** A set's store or closing line with the project name filled in (the neutral default when the pack states none). */
export const packLine = (set: Pick<FormatSet, 'name' | 'lines'>, key: (typeof LINE_KEYS)[number]): string => fill(set.lines[key] ?? DEFAULT_LINES[key], { name: set.name });
