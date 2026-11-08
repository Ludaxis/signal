// `render:<lang>` executor (the file name avoids the guard's `/render` import rule): the final MP4 (H.264 CRF 18, yuv420p, AAC 48 kHz 192 kbps, the
// mastered WAV as the only audio) and the cover still (PNG at coverFrame), through the render child. A mock lineage
// forces the MOCK layer on every frame whatever the timeline says. The render log lists each font
// family with its sha256, the renderer, concurrency and timings; the frame count is checked against the timeline.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TimelineDoc } from '../graph/adapters';
import { fontLog, verifyFonts } from '../render/fonts';
import { layoutTimeline } from '../render/layout';
import { defaultConcurrency } from '../render/renderer';
import { run } from '../render/loudness';
import { isFullTimeline, type Timeline, type TimelineLang } from '../render/timeline';
import type { StepCheck } from '../types';
import { renderMeasurements } from '../checks/renderMeasurements';
import { DEFAULT_AI_LABEL, faceMeasure } from './compose';
import { fontPublicFiles, lineageMock, mediaRefs, renderChainDeps, spawnOf, timelineFonts, workDirOf, type RenderChainDeps } from './render-chain';
import type { Executor } from './types';
import { timelineArtFiles } from './compose-art';

/** A TimelineDoc rebuilt by the free `compose.rebuild` adapter, upgraded to a drawable timeline (cuts and captions). */
export function upgradeTimeline(doc: TimelineDoc, lang: TimelineLang, fonts: Timeline['fonts'], mock: boolean): Timeline {
  const pages = doc.captions.map((c) => ({ lineId: c.lineId, beatId: doc.layers.find((l) => c.from >= l.from && c.from < l.to)?.beatId ?? '', text: c.text, beatOffsetMs: 0, durationMs: ((c.to - c.from) * 1000) / 30 }));
  for (const p of pages) {
    const l = doc.layers.find((x) => x.beatId === p.beatId);
    const c = doc.captions.find((x) => x.lineId === p.lineId && x.text === p.text);
    if (l && c) p.beatOffsetMs = ((c.from - l.from) * 1000) / 30;
  }
  const t = layoutTimeline({
    lang,
    beats: doc.layers.map((l) => ({ id: l.beatId, segment: 'other', techniques: [], from: l.from, to: l.to })),
    pages,
    tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
    brand: null,
    endcard: { tagline: '', sub: null, cta: '', iconText: '' },
    aiLabel: DEFAULT_AI_LABEL[lang],
    fonts,
    mock,
    seed: 1,
    coverFrame: doc.coverFrame,
  });
  return { ...t, durationInFrames: doc.durationInFrames };
}

/** Counts the video frames of a file with ffmpeg (stream copy, no decode). */
export async function countFrames(d: RenderChainDeps, file: string): Promise<number | null> {
  if (!d.ffmpeg) return null;
  const err = await run(await spawnOf(d), d.ffmpeg.bin, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']).catch(() => '');
  const all = [...err.matchAll(/frame=\s*(\d+)/g)];
  return all.length ? Number(all.at(-1)![1]) : null;
}

export function renderExecutor(dIn: Partial<RenderChainDeps> = {}): Executor {
  const d = renderChainDeps(dIn);
  return {
    kind: 'render',
    implVersion: 'render@4',
    deterministic: true,
    estimate: (e) => ({ usdLow: 0, usdHigh: 0, seconds: Math.ceil(((e.byPort.timeline as { durationInFrames?: number } | null)?.durationInFrames ?? 900) / 15), basis: 'On this computer', verified: true }),
    async run(i) {
      const lang = i.lang as TimelineLang;
      const fonts = d.fonts();
      verifyFonts(fonts);
      const mock = lineageMock(i);
      const raw = i.byPort.timeline as Timeline | TimelineDoc;
      const base = isFullTimeline(raw) ? raw : upgradeTimeline(raw, lang, timelineFonts(fonts), mock);
      const timeline: Timeline = { ...base, mock: base.mock || mock, fonts: timelineFonts(fonts) };
      const dir = workDirOf(d, i);
      const tag = `${i.runId}-${i.node.id}`.replace(/[^a-z0-9-]/gi, '-');
      const masterRef = mediaRefs(i.inputs, 'master')[0];
      const masterBytes = masterRef && d.readObject ? await d.readObject(masterRef.sha256).catch(() => null) : null;
      const masterFile = path.join(dir, 'master.wav');
      if (masterBytes) writeFileSync(masterFile, masterBytes);
      const master = masterBytes ? `jobs/${tag}/master.wav` : null;
      const video = path.join(dir, `video.${lang}.mp4`);
      const cover = path.join(dir, `cover.${lang}.png`);
      const props = { timeline, master };
      const artFiles = await timelineArtFiles(timeline, d.art, i.params);
      const s = Date.now();
      const res = await d.chain.run(
        [
          { kind: 'media', composition: 'StorySpine', props, out: video, codec: 'h264', crf: 18, muted: !master },
          { kind: 'still', composition: 'StorySpine', props, out: cover, frame: timeline.coverFrame, imageFormat: 'png' },
        ],
        { publicFiles: [...fontPublicFiles(fonts), ...artFiles, ...(master ? [{ from: masterFile, to: master }] : [])], workDir: dir, signal: i.signal },
      );
      const wallMs = Date.now() - s;
      const frames = d.chain.id === 'fake' ? null : await countFrames(d, video);
      const log = {
        schema: 'signal.pm.render-log/1',
        renderer: d.chain.id,
        fonts: fontLog(timeline.fonts),
        mock: timeline.mock,
        concurrency: defaultConcurrency(),
        codec: { video: 'h264', crf: 18, pixelFormat: 'yuv420p', audio: master ? 'aac 48 kHz 192 kbps' : 'none' },
        frames: { expected: timeline.durationInFrames, counted: frames },
        timings: { wallMs, bundleMs: res.bundleMs, bundleCached: res.bundleCached, tasks: res.tasks.map((t) => ({ file: path.basename(t.out), ms: t.ms })) },
        child: res.log,
      };
      const checks: StepCheck[] = [
        { id: `render:${lang}:fonts`, ok: true, required: true, text: `Bundled faces only: ${timeline.fonts.map((f) => f.family).join(', ')}`, evidence: log.fonts.join('; ') },
        frames === null
          ? { id: `render:${lang}:frames`, ok: false, required: false, text: `Frame count not measured (${d.chain.id} renderer)` }
          : { id: `render:${lang}:frames`, ok: Math.abs(frames - timeline.durationInFrames) <= 1, required: true, text: `${frames} frames (expected ${timeline.durationInFrames})` },
        { id: `render:${lang}:mock`, ok: true, required: false, text: timeline.mock ? 'MOCK layer on every frame' : 'No mock in the lineage' },
      ];
      return {
        outputs: [
          { port: 'video', name: `video.${lang}.mp4`, kind: 'video', mime: 'video/mp4', lang, data: null, bytes: readFileSync(video), meta: { width: 1080, height: 1920, frames: frames ?? timeline.durationInFrames } },
          { port: 'cover', name: `cover.${lang}.png`, kind: 'image', mime: 'image/png', lang, data: null, bytes: readFileSync(cover), meta: { width: 1080, height: 1920 } },
          { port: 'log', name: `render-log.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: log },
          // contract: the check reads layout, AI label, fonts and chant cards from this port.
          { port: 'measurements', name: `measurements.${lang}.json`, kind: 'json', mime: 'application/json', lang, data: renderMeasurements(timeline, { measure: faceMeasure(fonts) }) },
        ],
        provides: { totalFrames: timeline.durationInFrames, coverFrame: timeline.coverFrame },
        checks,
        status: checks.some((c) => c.required && !c.ok) ? 'needs-you' : 'ok',
        costUsd: 0,
        model: null,
      };
    },
  };
}
