// What compose adds to the timeline from the creative chain: the compiled motion of the `motion` step
//, the art its characters are drawn with (a Tier A or C rig and its part files, or a Tier B
// still), the seed and tempo the solver runs on, and each scene's background image from the art step's scene plan.
// Files are served under `art/<sha256><ext>` and listed in `Timeline.art` with their hash; the render resolves them
// again through the pack and refuses a file whose bytes changed (`files_changed`). Without the pack the timeline
// keeps its colour fields and no character layer, as before.
import path from 'node:path';
import sharp from 'sharp';
import { timelineWithMotion } from '../anim/compile';
import type { TempoMap } from '../anim/types';
import { PostmakerError } from '../errors';
import type { SceneEl, Timeline, TimelineArtFile, TimelineCastArt } from '../render/timeline';
import { sha256OfFile } from '../store/objects';
import type { ScenesDoc } from './art';
import type { CharacterArt, PackWorlds } from './creative-world';
import { isMotionStepDoc } from './motion';

export interface PublicFile {
  from: string;
  to: string;
}

const servedAs = (sha: string, file: string) => `art/${sha}${path.extname(file).toLowerCase()}`;
const isScenesDoc = (d: unknown): d is ScenesDoc => Boolean(d && typeof d === 'object' && (d as { schema?: string }).schema === 'signal.pm.scenes/1');

/** The solver's tempo map from the motion basis grid (the declared music grid); null without one. */
export function tempoOfGrid(grid: { bpm: number; downbeatMs: number } | null | undefined): TempoMap | null {
  return grid ? { bpm: grid.bpm, firstDownbeatFrame: (grid.downbeatMs * 30) / 1000, beatsPerBar: 4 } : null;
}

async function stillSize(file: string, a: { w: number | null; h: number | null }): Promise<{ w: number; h: number }> {
  if (a.w && a.h) return { w: a.w, h: a.h };
  const m = await sharp(file).metadata();
  return { w: m.width ?? 1, h: m.height ?? 1 };
}

/** Adds the compiled motion, the cast art and the background images to a composed timeline. */
export async function withCreativeArt(t: Timeline, o: { motion: unknown; scenes: unknown; seed: number; art?: PackWorlds['art']; params: Record<string, unknown> }): Promise<{ timeline: Timeline; publicFiles: PublicFile[] }> {
  const doc = isMotionStepDoc(o.motion) && o.motion.compiled.totalFrames === t.durationInFrames ? o.motion : null;
  let out: Timeline = doc ? timelineWithMotion(t, doc.compiled) : t;
  const scenes = isScenesDoc(o.scenes) ? o.scenes : null;
  if (scenes) out = { ...out, aiAssets: scenes.aiGenerated === true };
  if (!o.art || (!doc && !scenes)) return { timeline: out, publicFiles: [] };
  const charIds = doc ? [...new Set(doc.compiled.characters.map((c) => c.charId))] : [];
  const backgrounds = scenes ? [...new Set(scenes.beats.map((b) => b.background))] : [];
  const got = await o.art({ characters: charIds, files: backgrounds }, { params: o.params });
  const files: TimelineArtFile[] = [];
  const publicFiles: PublicFile[] = [];
  const serve = (abs: string, sha: string, asset: string, rel?: string) => {
    const src = servedAs(sha, abs);
    if (!files.some((f) => f.src === src && f.asset === asset && f.rel === rel)) files.push({ src, sha256: sha, asset, ...(rel ? { rel } : {}) });
    if (!publicFiles.some((p) => p.to === src)) publicFiles.push({ from: abs, to: src });
    return src;
  };
  const cast: TimelineCastArt[] = [];
  for (const c of got.characters) cast.push(await castArt(c, serve));
  const images = new Map<string, string>();
  for (const [id, abs] of Object.entries(got.files)) images.set(id, serve(abs, await sha256OfFile(abs), id));
  if (scenes) {
    const bg = new Map(scenes.beats.map((b) => [b.beatId, images.get(b.background)]));
    out = { ...out, elements: out.elements.map((e) => (e.kind === 'scene' && bg.get(e.beatId) ? ({ ...e, image: bg.get(e.beatId)! } satisfies SceneEl) : e)) };
  }
  if (doc) out = { ...out, characters: { seed: o.seed, tempo: tempoOfGrid(doc.basis.grid), cast } };
  return { timeline: { ...out, art: files }, publicFiles };
}

async function castArt(c: CharacterArt, serve: (abs: string, sha: string, asset: string, rel?: string) => string): Promise<TimelineCastArt> {
  if (c.rig) {
    const sources: Record<string, string> = {};
    for (const [rel, sha] of Object.entries(c.rig.files)) sources[rel] = serve(path.join(c.rig.dir, rel), sha, c.charId, rel);
    return { charId: c.charId, tier: c.tier, rig: c.rig.rig, library: c.rig.library, sources };
  }
  const still = c.still!;
  const size = await stillSize(still.file, still);
  return { charId: c.charId, tier: c.tier, still: { src: serve(still.file, await sha256OfFile(still.file), c.charId), ...size } };
}

/**
 * The files a timeline needs at render time, resolved again through the pack. A file that is gone or whose bytes
 * changed since compose is refused: the render never draws different art than the proof was checked on.
 */
export async function timelineArtFiles(t: Pick<Timeline, 'art'>, art: PackWorlds['art'] | undefined, params: Record<string, unknown>): Promise<PublicFile[]> {
  const list = t.art ?? [];
  if (!list.length) return [];
  if (!art) throw new PostmakerError(409, 'files_changed', 'The scene art is not available on this computer.');
  const charIds = [...new Set(list.filter((f) => f.rel).map((f) => f.asset))];
  const fileIds = [...new Set(list.filter((f) => !f.rel).map((f) => f.asset))];
  const got = await art({ characters: [...new Set([...charIds, ...fileIds])], files: fileIds }, { params });
  const out: PublicFile[] = [];
  for (const f of list) {
    const c = got.characters.find((x) => x.charId === f.asset);
    const abs = f.rel ? (c?.rig ? path.join(c.rig.dir, f.rel) : null) : (got.files[f.asset] ?? c?.still?.file ?? null);
    const sha = abs ? (f.rel ? c?.rig?.files[f.rel] : await sha256OfFile(abs)) : null;
    if (!abs || sha !== f.sha256) throw new PostmakerError(409, 'files_changed', `The file of ${f.asset} changed since the proof was composed.`);
    if (!out.some((p) => p.to === f.src)) out.push({ from: abs, to: f.src });
  }
  return out;
}

/**
 * `compose.rebuild` (a retimed motion): the rebuilt timeline keeps the art of the one it replaces (the cast, the files
 * and each beat's background) and takes the newly compiled motion, so an adapted version still draws its characters.
 */
export function carryCreativeArt(prev: unknown, next: Timeline, motion: unknown): Timeline {
  const p = prev as Partial<Timeline> | null;
  let out = next;
  if (isMotionStepDoc(motion) && motion.compiled.totalFrames === next.durationInFrames) out = timelineWithMotion(out, motion.compiled);
  if (!p || p.schema !== 'signal.pm.timeline/1') return out;
  const images = new Map((p.elements ?? []).filter((e): e is SceneEl => e.kind === 'scene' && Boolean(e.image)).map((e) => [e.beatId, e.image!]));
  return {
    ...out,
    elements: out.elements.map((e) => (e.kind === 'scene' && images.has(e.beatId) ? { ...e, image: images.get(e.beatId)! } : e)),
    ...(p.characters && out.motion ? { characters: p.characters } : {}),
    ...(p.art ? { art: p.art } : {}),
    ...(typeof p.aiAssets === 'boolean' ? { aiAssets: p.aiAssets } : {}),
  };
}
