// `compose:<lang>` executor (quality S5): a pure function of upstream artifacts that
// builds timeline.json (the StorySpine props) with the layout engine and renders a preview strip at scale 0.5 (one
// JPEG per beat plus every cut frame) for the Proof and storyboard screens. Text sizes are checked against the
// absolute minimum; the pacing and flash lints and the safe-zone report (every 3rd frame and every cut frame,
// C3) run on the result.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { CaptionsDoc, MotionDoc } from '../graph/adapters';
import { flashLint, pacingLint } from '../checks/timelineLints';
import { safeZoneReport, type FaceMeasure } from '../checks/safeZone';
import { contrastRatio, HIGHLIGHT_MIN_CONTRAST, markerInk } from '../render/contrast';
import { measuringFont, type FontFile } from '../render/fonts';
import { layoutTimeline, type LayoutBeat, type LayoutPage } from '../render/layout';
import type { SegmentId } from '../render/presets';
import type { AudioClip, TextEl, Timeline } from '../render/timeline';
import { validateTextLayers } from '../render/typeScale';
import { sha256Hex } from '../store/objects';
import type { Lang, PreviewStrip, Recipe, StepCheck } from '../types';
import { fontPublicFiles, lineageMock, lineMsOf, renderChainDeps, timelineFonts, workDirOf, type RenderChainDeps } from './render-chain';
import type { ExecInput, ExecOutput, Executor } from './types';

/** Proposed default AI-label wording; a pack's wording replaces it (the Persian form stays proposed until the owner or a reader they name signs). */
export const DEFAULT_AI_LABEL: Record<Lang, string> = { en: 'Made with AI', fa: 'ساخته‌شده با هوش مصنوعی' };

const LATIN = /[A-Za-z]/;

export interface ComposeParams {
  brand?: Partial<Record<Lang, string>>;
  aiLabel?: Partial<Record<Lang, string>>;
  chantBeatsPerCard?: 2 | 4;
  tagline?: Partial<Record<Lang, string>>;
  sub?: Partial<Record<Lang, string>>;
  palette?: Timeline['palette'];
  coverFrame?: number;
}

const linesOf = (s: string | undefined) => (s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

/** Everything compose needs, from the node's inputs (pure; the executor and the @render fixtures share it). */
export function composeTimeline(o: { lang: Lang; recipe: Recipe; motion: MotionDoc; captions: CaptionsDoc; lineMs?: Record<string, number>; params: ComposeParams; mock: boolean; seed: number; fonts: Timeline['fonts'] }): Timeline {
  const { lang, recipe, motion } = o;
  const byId = new Map(recipe.beats.map((b) => [b.id, b]));
  const beats: LayoutBeat[] = motion.beats.map((b) => ({ id: b.id, segment: (byId.get(b.id)?.segment ?? 'other') as SegmentId, techniques: byId.get(b.id)?.techniques ?? [], from: b.startFrame, to: b.endFrame }));
  const reveal = recipe.beats.find((b) => b.segment === 'reveal' || b.segment === 'chant');
  const brandText = o.params.brand?.[lang] ?? linesOf(reveal?.onScreenText[lang])[0] ?? null;
  const end = recipe.beats.find((b) => b.segment === 'endcard') ?? recipe.beats.at(-1);
  const endLines = linesOf(end?.onScreenText[lang]);
  const cta = endLines.at(-1) ?? '';
  const tagline = o.params.tagline?.[lang] ?? (endLines.length > 1 ? endLines.slice(0, -1).join(' ') : endLines[0] ?? '');
  const audio: AudioClip[] = [];
  for (const b of motion.beats) {
    let at = b.startFrame;
    for (const lineId of b.lines) {
      const ms = o.lineMs?.[lineId] ?? 0;
      const frames = Math.ceil((ms * 30) / 1000);
      audio.push({ id: `voice-${lineId}`, kind: 'voice', src: null, from: at, frames, lineId });
      at += frames;
    }
  }
  return layoutTimeline({
    lang,
    beats,
    pages: o.captions.pages as LayoutPage[],
    tempo: { bpm: recipe.tempo?.bpm ?? 100, downbeatMs: recipe.tempo?.downbeatMs ?? 0, chantBeatsPerCard: o.params.chantBeatsPerCard ?? 2 },
    brand: brandText ? { text: brandText, latin: LATIN.test(brandText) && !/[؀-ۿ]/.test(brandText) } : null,
    endcard: { tagline, sub: o.params.sub?.[lang] ?? null, cta, iconText: brandText ? [...brandText][0]! : '' },
    aiLabel: o.params.aiLabel?.[lang] ?? DEFAULT_AI_LABEL[lang],
    palette: o.params.palette,
    fonts: o.fonts,
    mock: o.mock,
    seed: o.seed,
    audio,
    coverFrame: o.params.coverFrame,
  });
}

/** A measure over the render's faces (by role; the text face stands in for a missing Latin face). */
export function faceMeasure(fonts: FontFile[]): FaceMeasure | undefined {
  if (!fonts.some((f) => f.role === 'text')) return undefined;
  return (text, sizePx, face, weight) => measuringFont(fonts.find((f) => f.role === face) ?? fonts.find((f) => f.role === 'text')!).measure(text, sizePx, weight);
}

/** Checks on a timeline: type minimum (C2, names the layer), pacing and flash lints (frames named), safe zones. */
export function timelineChecks(t: Timeline, prefix: string, o: { measure?: FaceMeasure } = {}): StepCheck[] {
  const text = t.elements.filter((e): e is TextEl => e.kind === 'caption' || e.kind === 'bubble' || e.kind === 'tag');
  const type = validateTextLayers(text.map((e) => ({ id: e.id, role: e.role, lang: e.lang, sizePx: e.sizePx })));
  const zones = safeZoneReport(t, { measure: o.measure });
  const first = zones.hits[0];
  const emphasis = text.some((e) => e.style !== 'outline' && e.style !== 'scrim' && e.lines.flat().some((x) => x.emphasis));
  // Emphasis words sit on the accent marker in the ink colour: report when no ink reaches 4.5:1 on it.
  const ink = markerInk({ colour: t.palette.text, accent: t.palette.accent, plate: t.palette.plate });
  const ratio = contrastRatio(ink, t.palette.accent);
  return [
    ...type.filter((v) => v.rule === 'below-minimum').map((v) => ({ id: `${prefix}:type:${v.layerId}`, ok: false, required: true, text: v.message, evidence: v.layerId })),
    ...pacingLint(t).map((v, k) => ({ id: `${prefix}:pacing:${v.rule}:${k}`, ok: false, required: false, text: v.message, evidence: `frame ${v.frame}` })),
    ...flashLint(t).map((v) => ({ id: `${prefix}:flash`, ok: false, required: true, text: v.message, evidence: `frame ${v.frame}` })),
    {
      id: `${prefix}:safe-zone`,
      ok: zones.hits.length === 0,
      required: true,
      text: zones.hits.length === 0 ? `Safe zones clear: ${zones.framesChecked} frames, ${zones.boxesChecked} boxes` : `${zones.hits.length} safe-zone intersections in ${zones.framesChecked} frames`,
      evidence: first ? `frame ${first.frame}, layer ${first.layer}: ${first.message}` : `${zones.sampling}${o.measure ? '' : '; words not measured'}`,
    },
    ...(emphasis && ratio < HIGHLIGHT_MIN_CONTRAST
      ? [{ id: `${prefix}:contrast:emphasis`, ok: false, required: false, text: `The emphasis text on the marker is ${ratio.toFixed(1)}:1 (needs 4.5:1)`, evidence: `${ink} on ${t.palette.accent}` }]
      : []),
  ];
}

/** Preview frames: each beat 15 frames in (or its middle when shorter) plus every cut frame. */
export const previewFrames = (t: Timeline): number[] =>
  [...new Set([...t.layers.map((l) => Math.min(l.to - 1, l.from + Math.min(15, Math.floor((l.to - l.from) / 2)))), ...t.cutFrames])].filter((f) => f >= 0 && f < t.durationInFrames).sort((a, b) => a - b);

export function composeExecutor(d: Partial<RenderChainDeps> = {}): Executor {
  const deps = renderChainDeps(d);
  return {
    kind: 'compose',
    implVersion: 'compose@4',
    deterministic: true,
    estimate: () => ({ usdLow: 0, usdHigh: 0, seconds: 20, basis: 'On this computer', verified: true }),
    async run(i: ExecInput) {
      const lang = i.lang;
      if (!lang) throw new Error('compose needs a language');
      const fonts = deps.fonts();
      const t = composeTimeline({
        lang,
        recipe: i.recipe,
        motion: i.byPort.motion as MotionDoc,
        captions: i.byPort.captions as CaptionsDoc,
        lineMs: lineMsOf(i.inputs),
        params: i.params as ComposeParams,
        mock: lineageMock(i),
        seed: i.seed,
        fonts: timelineFonts(fonts),
      });
      const dir = workDirOf(deps, i);
      const frames = previewFrames(t);
      const tasks = frames.map((frame) => ({ kind: 'still' as const, composition: 'StorySpine' as const, props: { timeline: t, master: null }, out: path.join(dir, `preview-${String(frame).padStart(5, '0')}.jpg`), frame, scale: 0.5, imageFormat: 'jpeg' as const }));
      const res = tasks.length ? await deps.chain.run(tasks, { publicFiles: fontPublicFiles(fonts), workDir: dir, signal: i.signal }) : null;
      const previews: ExecOutput[] = tasks.map((task) => ({ port: 'preview', name: path.basename(task.out), kind: 'image', mime: 'image/jpeg', lang, data: null, bytes: readFileSync(task.out), meta: { width: 540, height: 960, frames: task.frame } }));
      // contract: the strip in the PreviewStrip shape (frames by object hash) for get_run_frames and Proof.
      const strip: PreviewStrip = { lang, fps: t.fps, width: 540, height: 960, frames: previews.map((p) => ({ frame: p.meta!.frames!, sha256: sha256Hex(p.bytes!), mime: 'image/jpeg' })) };
      const checks = timelineChecks(t, `compose:${lang}`, { measure: faceMeasure(fonts) });
      return {
        outputs: [{ port: 'timeline', name: `timeline.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: t }, { port: 'preview', name: `preview.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: strip }, ...previews],
        provides: { totalFrames: t.durationInFrames, coverFrame: t.coverFrame },
        checks: res ? [...checks, { id: `compose:${lang}:previews`, ok: true, required: false, text: `${previews.length} preview frames (${deps.chain.id})` }] : checks,
        status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
        costUsd: 0,
        model: null,
      };
    },
  };
}
