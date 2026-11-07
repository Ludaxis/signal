// @vitest-environment node
// SSR smoke tests of the Post maker compositions, with the Remotion stub (vitest.config.mts aliases `remotion` to
// remotion-stub.tsx), so they run without the optional render workspace. Static HTML at sampled frames: StorySpine
// mounts at every 6th frame, draws the AI label on every frame and the MOCK layer on every frame of a mock timeline
// (never on a clean one); Persian blocks are lang="fa" dir="rtl" with one token per word; AudioMaster mounts the music
// bed and each narration clip in its sequence. Not a substitute for a real Chrome render (the @render suite and the
// slice). The compositions are loaded by path, so the root typecheck keeps excluding them (they type against Remotion).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { layoutTimeline } from '@/lib/studio/postmaker/render/layout';
import { planMix, type MixPlan } from '@/lib/studio/postmaker/render/mixPlan';
import { MOCK_BANDS, MOCK_PROBE, MOCK_STRIPE_OPACITY } from '@/lib/studio/postmaker/render/mockLayer';
import { checkBox } from '@/lib/studio/postmaker/render/safeZones';
import type { Timeline } from '@/lib/studio/postmaker/render/timeline';
import { ConfigContext, FrameContext, STUB_EXPORTS } from './remotion-stub';

const RENDER = path.resolve(__dirname, '../../../../lib/studio/postmaker/render');

type StorySpineC = React.FC<{ timeline: Timeline; master: string | null; splitChars?: boolean }>;
type AudioMasterC = React.FC<{ plan: MixPlan }>;
let StorySpine: StorySpineC;
let AudioMaster: AudioMasterC;

beforeAll(async () => {
  StorySpine = ((await import(/* @vite-ignore */ path.join(RENDER, 'compositions/StorySpine.tsx'))) as { StorySpine: StorySpineC }).StorySpine;
  AudioMaster = ((await import(/* @vite-ignore */ path.join(RENDER, 'compositions/AudioMaster.tsx'))) as { AudioMaster: AudioMasterC }).AudioMaster;
});

const FONTS = [
  { family: 'Vazirmatn', role: 'text' as const, src: 'fonts/vazirmatn/Vazirmatn-Variable.woff2', sha256: 'x', weights: '100 900' },
  { family: 'Estedad', role: 'display' as const, src: 'fonts/estedad/Estedad-Variable.woff2', sha256: 'y', weights: '100 900' },
];

function timeline(lang: 'fa' | 'en', mock: boolean): Timeline {
  const words = lang === 'fa' ? ['یه', 'روز', 'یه', 'بازی'] : ['One', 'day', 'a', 'game'];
  return layoutTimeline({
    lang,
    beats: [
      { id: 'b01', segment: 'hook', techniques: ['emoji-sticker', 'highlight-marker', 'emphasis-punch'], from: 0, to: 150 },
      { id: 'b02', segment: 'interrupt', techniques: [], from: 150, to: 210 },
      { id: 'b03', segment: 'demo', techniques: [], from: 210, to: 360 },
      { id: 'b04', segment: 'chant', techniques: [], from: 360, to: 468 },
      { id: 'b05', segment: 'reveal', techniques: [], from: 468, to: 558 },
      { id: 'b06', segment: 'endcard', techniques: [], from: 558, to: 768 },
    ],
    pages: [{ lineId: 'l01', beatId: 'b01', text: words.join(' '), beatOffsetMs: 0, durationMs: 1600, words: words.map((text, k) => ({ text, latin: false, beatOffsetMs: k * 400 })), highlight: 3, emphasis: 3 }],
    tempo: { bpm: 100, downbeatMs: 0, chantBeatsPerCard: 2 },
    brand: lang === 'fa' ? { text: 'حرفینو', latin: false } : { text: 'Wordo', latin: true },
    endcard: { tagline: lang === 'fa' ? 'هر روز یه کلمه' : 'A word a day', sub: null, cta: lang === 'fa' ? 'بازی کن' : 'Play now', iconText: 'W' },
    aiLabel: lang === 'fa' ? 'ساخته‌شده با هوش مصنوعی' : 'Made with AI',
    fonts: FONTS,
    mock,
    seed: 3,
  });
}

const at = (t: Timeline, frame: number, extra: { splitChars?: boolean } = {}) =>
  renderToStaticMarkup(
    <ConfigContext.Provider value={{ fps: 30, width: 1080, height: 1920, durationInFrames: t.durationInFrames, id: 'StorySpine' }}>
      <FrameContext.Provider value={{ frame, offset: 0 }}>
        <StorySpine timeline={t} master={null} {...extra} />
      </FrameContext.Provider>
    </ConfigContext.Provider>,
  );

describe('the Remotion stub covers the compositions', () => {
  it('every name a composition or component imports from remotion is in the stub (index and Root register only)', () => {
    const used = new Set<string>();
    for (const dir of ['compositions', 'components']) {
      for (const f of readdirSync(path.join(RENDER, dir))) {
        if (dir === 'compositions' && (f === 'Root.tsx' || f === 'index.ts')) continue;
        const src = readFileSync(path.join(RENDER, dir, f), 'utf8');
        for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'remotion'/g)) for (const n of m[1]!.split(',')) if (n.trim() && !n.trim().startsWith('type ')) used.add(n.trim());
      }
    }
    expect(used.size).toBeGreaterThan(3);
    expect([...used].filter((n) => !STUB_EXPORTS.includes(n))).toEqual([]);
  });
});

describe('StorySpine (SSR smoke)', () => {
  for (const lang of ['fa', 'en'] as const) {
    it(`${lang}: mounts at every 6th frame with the AI label and the MOCK layer on every frame`, () => {
      const t = timeline(lang, true);
      for (let f = 0; f < t.durationInFrames; f += 6) {
        const html = at(t, f);
        expect(html, `frame ${f}`).toContain('data-layer="ai-label"');
        expect(html, `frame ${f}`).toContain('data-layer="mock-watermark"');
        // a translucent diagonal stripe plus the two solid bands in the reserves the pixel check reads
        for (const part of ['stripe', 'band-top', 'band-bottom']) expect(html, `frame ${f}`).toContain(`data-mock="${part}"`);
      }
      expect(at(t, t.durationInFrames - 1)).toContain('data-layer="mock-watermark"');
    });
  }

  it('the MOCK stripe is translucent (content stays readable); the bands are solid and sit inside the reserves', () => {
    const html = at(timeline('fa', true), 30);
    expect(html).toContain(`rgba(230, 30, 60, ${MOCK_STRIPE_OPACITY})`);
    expect(MOCK_STRIPE_OPACITY).toBeLessThanOrEqual(0.45);
    expect(html).toContain('rgba(230, 30, 60, 1)');
    for (const b of MOCK_BANDS) expect(checkBox('reel', { x: 0, y: b.y, width: 1080, height: b.height }, { text: false, critical: true }).some((v) => v.zone === 'top' || v.zone === 'bottom'), b.id).toBe(true);
    expect(MOCK_PROBE.y).toBeGreaterThanOrEqual(MOCK_BANDS[1].y);
    expect(MOCK_PROBE.y + MOCK_PROBE.height).toBeLessThanOrEqual(MOCK_BANDS[1].y + MOCK_BANDS[1].height);
  });

  it('a clean timeline has no MOCK layer, and is deterministic', () => {
    const t = timeline('fa', false);
    expect(at(t, 40)).not.toContain('mock-watermark');
    expect(at(t, 40)).toContain('data-layer="ai-label"');
    expect(at(t, 40)).toBe(at(t, 40));
  });

  it('Persian caption: lang="fa" dir="rtl", one span per word (never per letter), highlight inside the key token', () => {
    const html = at(timeline('fa', true), 60);
    expect(html).toContain('lang="fa" dir="rtl"');
    expect(html).toContain('data-token="بازی"');
    expect(html).toContain('data-layer="highlight"');
    expect(html).not.toMatch(/<span style="display:inline-block">ب<\/span>/);
    const split = at(timeline('fa', true), 60, { splitChars: true });
    expect(split).toMatch(/<span style="display:inline-block">ب<\/span>/); // the guard variant the golden diff must catch
  });

  it('draws the chant card, the ZWJ reveal step and the end card CTA at their frames', () => {
    const t = timeline('fa', true);
    expect(at(t, 370)).toContain('data-layer="card"');
    expect(at(t, 370)).toContain('حرفینو');
    expect(at(t, 480)).toContain('حر‍'); // step 2 of the reveal
    expect(at(t, 700)).toContain('data-layer="cta"');
    expect(at(t, 250)).toContain('data-layer="phone"');
  });
});

describe('AudioMaster (SSR smoke)', () => {
  it('mounts the music bed and each narration clip in its sequence', () => {
    const plan = planMix({
      durationFrames: 300,
      segments: [{ beatId: 'b01', segment: 'hook', from: 0, to: 300 }],
      voice: [{ id: 'v1', lineId: 'l01', src: 'jobs/t/voice-l01.wav', from: 30, frames: 60, measuredLufs: -20 }],
      music: { src: 'jobs/t/music.wav', measuredLufs: -18 },
    });
    const html = (frame: number) =>
      renderToStaticMarkup(
        <ConfigContext.Provider value={{ fps: 30, width: 1080, height: 1920, durationInFrames: 300, id: 'AudioMaster' }}>
          <FrameContext.Provider value={{ frame, offset: 0 }}>
            <AudioMaster plan={plan} />
          </FrameContext.Provider>
        </ConfigContext.Provider>,
      );
    expect(html(10)).toContain('/public/jobs/t/music.wav');
    expect(html(10)).not.toContain('voice-l01');
    expect(html(40)).toContain('/public/jobs/t/voice-l01.wav');
  });
});
