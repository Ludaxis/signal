// Phone UI targets (pack format `phone-frame`, schema `uiTargetsSchema`): a `phone-frame` asset lists its
// UI target ids in `<file>.ui.json` beside the image, `{ schema: 'signal.pack-ui/1', targets: { id, x, y, w, h }[] }` in
// integer image px, each rect inside the asset's dims, ids unique. The animator's `swipe.targets` name these ids and
// the compiler moves the finger through each target's centre in phone-local px (the screen inside the phone insert,
// render/slots.ts PHONE_SLOT less its bezel). A phone frame without the file, or with an invalid one, is refused with
// `asset.ui-targets-invalid`; the motion world then keeps the core default targets (DEFAULT_UI_TARGETS).
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { PostmakerError } from '../errors';
import { PHONE_SLOT } from '../render/slots';
import { insideDir } from './load';
import type { LibraryEntry } from './resolve';
import { firstIssue } from './schema';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const uiTargetsSchema = z
  .object({
    schema: z.literal('signal.pack-ui/1'),
    targets: z.array(z.object({ id: z.string().regex(SLUG), x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().positive(), h: z.number().int().positive() })).min(1),
  })
  .refine((u) => new Set(u.targets.map((t) => t.id)).size === u.targets.length, { message: 'Each UI target needs its own id.', path: ['targets'] });
export type UiTargetsFile = z.infer<typeof uiTargetsSchema>;

/** The bezel StorySpine draws around the phone screen (its padding), so the screen is PHONE_SLOT less 2 × 22 px. */
export const PHONE_BEZEL = 22;
export const PHONE_SCREEN = { w: PHONE_SLOT.width - 2 * PHONE_BEZEL, h: PHONE_SLOT.height - 2 * PHONE_BEZEL } as const;

const invalid = (assetId: string, why: string) => new PostmakerError(422, 'asset.ui-targets-invalid', `The UI targets of ${assetId} are not valid (${why}).`);

/** `<file>` with its extension replaced by `.ui.json`. */
export const uiTargetsPath = (file: string) => file.replace(/\.[A-Za-z0-9]+$/, '') + '.ui.json';

/** Reads and checks a phone frame's targets (rects in image px). Throws `asset.ui-targets-invalid` naming the asset. */
export async function readUiTargets(e: Pick<LibraryEntry, 'asset' | 'base' | 'origin'>): Promise<UiTargetsFile> {
  const a = e.asset;
  let raw: unknown;
  try {
    const file = await insideDir(e.base, uiTargetsPath(a.file), e.origin === 'pack' ? 'pack' : 'assets');
    raw = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ file, 'utf8'));
  } catch {
    throw invalid(a.id, 'the .ui.json file is missing or unreadable');
  }
  const parsed = uiTargetsSchema.safeParse(raw);
  if (!parsed.success) throw invalid(a.id, firstIssue(parsed.error));
  if (a.dims) for (const t of parsed.data.targets) if (t.x + t.w > a.dims.w || t.y + t.h > a.dims.h) throw invalid(a.id, `${t.id} lies outside the image`);
  return parsed.data;
}

/** Target centres in phone-local px: image px scaled to the phone screen (the image's dims, else the targets' extent). */
export function phoneTargets(file: UiTargetsFile, dims?: { w: number; h: number } | null): Record<string, { x: number; y: number }> {
  const w = dims?.w ?? Math.max(...file.targets.map((t) => t.x + t.w));
  const h = dims?.h ?? Math.max(...file.targets.map((t) => t.y + t.h));
  const sx = PHONE_SCREEN.w / w;
  const sy = PHONE_SCREEN.h / h;
  return Object.fromEntries(file.targets.map((t) => [t.id, { x: Math.round((t.x + t.w / 2) * sx), y: Math.round((t.y + t.h / 2) * sy) }]));
}

/**
 * The UI targets for a run: the phone frame the scenes use (else the library's first `phone-frame`), read from
 * its `.ui.json`; null when there is none or it is invalid (the caller keeps DEFAULT_UI_TARGETS).
 */
export async function uiTargetsFor(entries: Iterable<LibraryEntry>, phoneFrameId?: string | null): Promise<Record<string, { x: number; y: number }> | null> {
  const frames = [...entries].filter((e) => e.asset.kind === 'ui' && e.asset.tags.includes('phone-frame') && e.asset.status !== 'retired').sort((a, b) => (a.asset.id < b.asset.id ? -1 : 1));
  const e = frames.find((x) => x.asset.id === phoneFrameId) ?? frames[0];
  if (!e) return null;
  try {
    return phoneTargets(await readUiTargets(e), e.asset.dims);
  } catch {
    return null;
  }
}
