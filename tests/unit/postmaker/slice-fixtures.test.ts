// @vitest-environment node
// The slice fixtures: the example pack built from tests/fixtures/postmaker/pack-example loads, locks
// and resolves for a final render; its lexicon, glossary, voices, style guide, music licence record and template are
// what the pack format says; the slice recipe's Persian lines pass the similarity guard and the S1 checks (Persian guide
// acceptance 3-4); the pack's strings never appear in core; no reference name is anywhere in the fixtures.
// Quality bar (mock): the three variants of the template pass the automated checks, the fa ones
// stop at the fa human gates and the en one has none. [Pack example] everything pack-specific is fixture data.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { similarityGuard } from '@/lib/studio/lang/fa/bilingual';
import { loadRig } from '@/lib/studio/postmaker/anim/rig/load';
import { validateRig } from '@/lib/studio/postmaker/anim/rig/validate';
import { buildFaLine } from '@/lib/studio/lang/fa/pron';
import { CORE_LEXICON, loadLexicon, type LexiconFile } from '@/lib/studio/lang/fa/lexicon';
import { licenceComplete } from '@/lib/studio/postmaker/connectors/music';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import { runNarrationText } from '@/lib/studio/postmaker/executors/narration-text';
import { buildPipeline } from '@/lib/studio/postmaker/graph/build';
import { acceptBlockers } from '@/lib/studio/postmaker/graph/status';
import { loadPack, type LoadedPack } from '@/lib/studio/postmaker/pack/load';
import { mergeLibraries, packEntries, resolveAsset } from '@/lib/studio/postmaker/pack/resolve';
import { loadPackTemplates, scaleTemplate, type PackTemplate } from '@/lib/studio/postmaker/pack/template';
import { fakeRenderChain } from '@/lib/studio/postmaker/render/renderer';
import { PostmakerEngine } from '@/lib/studio/postmaker/runner';
import { createRecipe, writePipelineVersion } from '@/lib/studio/postmaker/store/recipes';
import type { Lang, RecipeBeat } from '@/lib/studio/postmaker/types';
import { serviceExecutors } from '@/lib/studio/postmaker/wiring';
import corpus from '@/lib/studio/lang/fa/__fixtures__/normalization-corpus.json';
import transcript from './fixtures/synthetic-reference-transcript.json';
import { tmp } from './guard';
import { FIXTURES, fixtureBuilders, sliceFixture, WEB } from './slice-harness';

const shared: { dir: string; pack: LoadedPack | null; templates: PackTemplate[] } = { dir: '', pack: null, templates: [] };
beforeAll(async () => {
  shared.dir = mkdtempSync(path.join(os.tmpdir(), 'signal-pack-'));
  const { buildPack } = await fixtureBuilders();
  const built = await buildPack(path.join(shared.dir, 'pack'));
  shared.pack = await loadPack(built.dir, { now: Date.parse('2026-11-07T00:00:00Z') });
  shared.templates = await loadPackTemplates(shared.pack);
}, 60_000);
afterAll(() => rmSync(shared.dir, { recursive: true, force: true }));

const pack = () => shared.pack!;
const readPackJson = <T,>(rel: string) => JSON.parse(readFileSync(path.join(pack().dir, rel), 'utf8')) as T;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length; // ZWNJ compounds are one word (counts)

describe('the example pack', () => {
  it('loads and locks: manifest, lexicon, glossary, style, template, fonts, voices and every asset', () => {
    const p = pack();
    expect(p.manifest).toMatchObject({ id: 'example-word-game', name: '{Brand} example pack', languages: ['fa', 'en'] });
    expect(Object.keys(p.lock.entries).sort()).toEqual(
      [
        'manifest', 'lexicon:fa', 'style:fa', 'glossary', 'template:pov-story-spine', 'font:Vazirmatn', 'font:Instrument Sans',
        'voice:mock-narrator-fa', 'voice:mock-elder-fa', 'voice:mock-narrator-en', 'voice:mock-elder-en',
        'asset:char-lead', 'asset:char-elder', 'asset:char-cutout', 'asset:bg-living-room-night', 'asset:ui-phone-frame', 'asset:ui-app-icon', 'asset:music-loop-100', 'asset:font-vazirmatn', 'asset:font-instrument-sans',
        // The synthesised SFX library, one asset per cue id
        ...['pop', 'whoosh', 'tap', 'swipe', 'success', 'clap', 'hit', 'riser', 'confetti', 'tick'].map((c) => `asset:sfx-${c}`),
      ].sort(),
    );
    expect(Object.values(p.assetFiles).every((f) => f.sha256 !== null)).toBe(true);
  });

  it('every asset resolves for a final render (approved, licensed for organic use, hash matches) with a complete licence record', async () => {
    const lib = mergeLibraries(packEntries(pack()), []);
    for (const a of pack().library) {
      const r = await resolveAsset(lib, a.id, { final: true, use: 'organic', now: Date.parse('2026-11-07T00:00:00Z') });
      expect(r.sha256, a.id).toBe(a.sha256);
      expect(licenceComplete(a.licence), a.id).toBe(true);
      expect(a.licence.aiGenerated, a.id).toBe(false);
    }
  });

  it('two original flat characters (Tier B), one generated cut-out rig (Tier A), one background, one phone frame with UI targets, exactly one app icon', () => {
    const lib = pack().library;
    const chars = lib.filter((a) => a.kind === 'character');
    expect(chars.map((a) => a.id)).toEqual(['char-lead', 'char-elder', 'char-cutout']);
    expect(pack().manifest.rigTier).toEqual({ 'char-lead': 'B', 'char-elder': 'B', 'char-cutout': 'A' });
    for (const c of chars.filter((a) => pack().manifest.rigTier[a.id] === 'B')) expect(c.file).toBe(`characters/${c.id}/flat.png`);
    expect(chars.find((a) => a.id === 'char-cutout')!.file).toBe('characters/char-cutout/rig.json');
    expect(lib.filter((a) => a.kind === 'background')).toHaveLength(1);
    expect(lib.filter((a) => a.tags.includes('app-icon'))).toHaveLength(1);
    const phone = lib.find((a) => a.tags.includes('phone-frame'))!;
    const ui = readPackJson<{ schema: string; targets: { id: string; x: number; y: number; w: number; h: number }[] }>(`library/${phone.file.replace(/\.png$/, '.ui.json')}`);
    expect(ui.schema).toBe('signal.pack-ui/1');
    expect(new Set(ui.targets.map((t) => t.id)).size).toBe(ui.targets.length);
    for (const t of ui.targets) expect(t.x + t.w <= phone.dims!.w && t.y + t.h <= phone.dims!.h, t.id).toBe(true);
  });

  it('the Tier A rig loads through the pack (resolver, tier, part files) and passes validateRig', async () => {
    const lib = mergeLibraries(packEntries(pack()), []);
    const r = await loadRig(pack(), lib, 'char-cutout', { final: true, use: 'organic', now: Date.parse('2026-11-07T00:00:00Z') });
    expect(r.tier).toBe('A');
    expect(r.rig.views).toEqual(['front', 'three-quarter-L']);
    expect(validateRig(r.rig).ok).toBe(true);
    expect(r.rigSha256).toBe(pack().library.find((a) => a.id === 'char-cutout')!.sha256);
  });

  it('fonts: Vazirmatn and one Latin OFL face, pinned, each with its OFL licence beside it', () => {
    const fonts = pack().manifest.fonts;
    expect([...new Set(fonts.map((f) => f.family))]).toEqual(['Vazirmatn', 'Instrument Sans']);
    expect(fonts.find((f) => f.family === 'Vazirmatn')!.scripts).toEqual(['arabic']);
    expect(fonts.filter((f) => f.family === 'Instrument Sans').every((f) => f.scripts.includes('latin'))).toBe(true);
    for (const f of fonts) expect(readFileSync(path.join(pack().dir, f.licence), 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/);
  });

  it('music: a 100 BPM click-plus-chord loop whose licence record declares BPM and first downbeat', () => {
    const m = pack().library.find((a) => a.kind === 'music')!;
    const raw = readPackJson<{ id: string; music: { bpm: number; firstDownbeatMs: number; beatsPerBar: number; declaredBy: string; loopable: boolean } }[]>('library/library.json').find((a) => a.id === m.id)!;
    expect(raw.music).toEqual({ bpm: 100, firstDownbeatMs: 0, beatsPerBar: 4, declaredBy: 'pack', loopable: true });
    const rec = readPackJson<{ declared: { bpm: number; firstDownbeatMs: number; durationMs: number } }>(m.licence.proof!);
    expect(rec.declared).toMatchObject({ bpm: 100, firstDownbeatMs: 0, durationMs: 4800 });
    const wav = readFileSync(path.join(pack().libraryDir, m.file));
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(Math.round((wav.readUInt32LE(40) / 2 / 48_000) * 1000)).toBe(4800);
    expect(m.durationMs).toBe(4800);
    // a click on each of the 8 beats: the loudest 10 ms window after every beat onset beats the window just before it
    const at = (ms: number) => {
      let peak = 0;
      for (let i = Math.round((ms * 48_000) / 1000); i < Math.round(((ms + 10) * 48_000) / 1000); i++) peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)));
      return peak;
    };
    for (let k = 1; k < 8; k++) expect(at(k * 600), `beat ${k}`).toBeGreaterThan(at(k * 600 - 40));
  });

  it('voices: mock voices only, models pinned, Persian voices with projection settings, no clones', () => {
    expect(pack().voices.map((v) => [v.id, v.lang, v.connector])).toEqual([
      ['mock-narrator-fa', 'fa', 'mock'], ['mock-elder-fa', 'fa', 'mock'], ['mock-narrator-en', 'en', 'mock'], ['mock-elder-en', 'en', 'mock'],
    ]);
    for (const v of pack().voices) {
      expect(v.model).toBe('mock-tts-1');
      expect(v.consentRef).toBeNull();
      if (v.lang === 'fa') expect(v.projection).not.toBeNull();
    }
  });

  it('lexicon/fa.json: 10 generic entries, all proposed until a named reader signs; glossary: the fictional brand and the elder', () => {
    const lex = readPackJson<LexiconFile>('lexicon/fa.json');
    expect(lex).toMatchObject({ schema: 'signal.fa-lexicon/1', scope: 'pack', packId: 'example-word-game' });
    expect(lex.entries).toHaveLength(10);
    expect(lex.entries.every((e) => e.status === 'proposed' && e.approvedBy === null)).toBe(true);
    const gl = readPackJson<LexiconFile>('glossary.json');
    expect(gl.entries.map((e) => e.kind)).toEqual(['brand', 'character']);
    const both = loadLexicon(CORE_LEXICON, { ...lex, entries: [...gl.entries, ...lex.entries] });
    // every entry matches its own display form in a sentence and the line builds without errors
    for (const e of lex.entries) {
      const form = e.match.display[0]!;
      const sentence = /[A-Za-z]/.test(form) ? `یه ${form} اومد.` : `یه ${form} دیگه.`;
      const built = buildFaLine(sentence, { lexicon: both, lint: { narrated: false } });
      expect(built.line.spans.some((s) => s.ruleId === e.id), e.id).toBe(true);
      expect(built.invariant, e.id).toEqual([]);
    }
  });

  it('style/fa.md has the front matter', () => {
    const text = readFileSync(path.join(pack().dir, 'style/fa.md'), 'utf8');
    const fm = Object.fromEntries(text.split('---')[1]!.trim().split('\n').map((l) => l.split(/:\s*/, 2) as [string, string]));
    expect(fm).toMatchObject({ schema: 'signal.pack-style/1', lang: 'fa', version: '1', faAddress: 'to', ezafeAfterHeh: 'zwnj-yeh', smallNumbers: 'words' });
  });

  it('the template validates against the pack and scales to its min, max and 30 s at the variant BPMs', () => {
    expect(shared.templates.map((t) => t.id)).toEqual(['pov-story-spine']);
    const t = shared.templates[0]!;
    for (const [sec, bpm] of [[30, 120], [90, 100], [45, 110]] as const) expect(scaleTemplate(t, { totalSec: sec, bpm }).boundaries.at(-1)).toBe(sec * 30);
  });
});

describe('the slice recipe and the Persian guide', () => {
  const f = sliceFixture();
  const faLines = f.recipe.beats.flatMap((b) => (b.onScreenText.fa ?? '').split('\n').filter(Boolean).map((display, k) => ({ id: `${b.id}.${k}`, beatId: b.id, display })));

  it('3: no fa or en line is over 0.6 similar to the reference transcript (synthetic here; the real one stays outside the repository) or the corpus', () => {
    expect(faLines).toHaveLength(8);
    expect(similarityGuard(faLines, transcript.lines)).toEqual([]);
    expect(similarityGuard(faLines, corpus.lines)).toEqual([]);
    const enLines = f.recipe.beats.flatMap((b) => (b.onScreenText.en ?? '').split('\n').filter(Boolean).map((display, k) => ({ id: `${b.id}.${k}`, display })));
    expect(similarityGuard(enLines, transcript.lines)).toEqual([]);
  });

  it('4: every fa line passes the S1 automated checks in mock mode with the pack lexicon and glossary; the hook line fits 2.0 s at 2.6 words/s', async () => {
    const lex = readPackJson<LexiconFile>('lexicon/fa.json');
    const gl = readPackJson<LexiconFile>('glossary.json');
    const out = await runNarrationText({
      lang: 'fa',
      mode: 'mock',
      now: '2026-11-07T00:00:00Z',
      lexicon: { pack: { ...lex, entries: [...gl.entries, ...lex.entries] } },
      lines: faLines.map((l, i) => ({ id: `l${String(i + 1).padStart(2, '0')}`, beatId: l.beatId, speaker: 'narrator', langs: ['fa', 'en'] as Lang[], fa: { display: l.display }, en: { display: 'x' } })),
    });
    expect(out.checks.filter((c) => c.severity === 'error')).toEqual([]);
    expect(out.ok).toBe(true);
    const hook = faLines[0]!;
    expect(words(hook.display)).toBe(5);
    expect(words(hook.display) / 2.6).toBeLessThanOrEqual(2.0);
  });
});

describe('generic core and the reference rule', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : [path.join(dir, n)]));

  it('no string of the example pack appears in core (lib/studio, app/studio, app/api/studio)', () => {
    const p = pack();
    const lex = readPackJson<LexiconFile>('lexicon/fa.json');
    const gl = readPackJson<LexiconFile>('glossary.json');
    const strings = [
      p.manifest.id, ...shared.templates.map((t) => t.id), ...shared.templates.flatMap((t) => t.variants!.map((v) => v.id)),
      ...p.library.map((a) => a.id), ...p.voices.map((v) => v.id), ...lex.entries.map((e) => e.id), ...gl.entries.map((e) => e.id),
      ...gl.entries.filter((e) => e.kind === 'brand').flatMap((e) => Object.values(e.display ?? {})),
    ];
    expect(strings.length).toBeGreaterThan(25);
    const hits: string[] = [];
    for (const root of ['lib/studio', 'app/studio', 'app/api/studio'])
      for (const file of files(path.join(WEB, root))) {
        if (!/\.(ts|tsx|css|json|md)$/.test(file) || file.split(path.sep).includes('__fixtures__')) continue;
        const text = readFileSync(file, 'utf8');
        for (const s of strings) if (text.includes(s)) hits.push(`${path.relative(WEB, file)}: ${s}`);
      }
    expect(hits).toEqual([]);
  });

  it('no reference name is in tests/fixtures (grep over tests/fixtures/ returns nothing)', () => {
    // The three names, built from parts so this file does not carry them (the scan).
    const names = [String.fromCodePoint(0x06a9, 0x0644, 0x0645, 0x0627, 0x062a, 0x06cc, 0x06a9), ['Go', 'lab'].join(''), ['Kala', 'matic'].join('')];
    const found = files(path.join(WEB, 'tests/fixtures')).filter((f) => names.some((n) => readFileSync(f, 'utf8').includes(n)));
    expect(found).toEqual([]);
    expect(files(FIXTURES).filter((f) => /\.(mp4|mov|wav|png|jpe?g|woff2?|ttf|otf)$/i.test(f))).toEqual([]); // binaries are built, never committed
  });
});

// ---- (mock) ---------------------------------------------------------------------------

const FA: Record<string, string> = {
  hook: 'شب یلداست، خونه‌ی مامان‌بزرگ غوغاست.\nمنم این‌ور، غرق بازی‌ام.',
  story: 'بیا یه فال حافظ برات بگیرم!\nالان عمه‌جون! دارم یه کلمه‌ی هفت‌حرفی می‌سازم!',
  interrupt: 'حافظ یا گوشی؟!',
  demo: 'ببین: حروف رو می‌کشم، کلمه درمیاد.',
  chant: 'حرفینو',
  escalation: 'حالا کل فامیل ریختن سر گوشیم!',
  reveal: '',
  endcard: 'یلدا با حرفینو بلندتره!\nامشب نوبت توئه!',
};
// Persian guide V3 lines, with the CTA the fixture pack's claims allow ("Install now" is an availability claim).
const EN: Record<string, string> = {
  hook: "POV: the office party.\nEveryone's dancing,\nand I'm in the corner, glued to my phone.",
  story: 'My boss: Come on, one dance!\nMe: Wait. One more word.',
  interrupt: 'Word?\nWhat word?',
  demo: 'Five letters. Make a word.',
  chant: 'Harfino',
  escalation: "Now the whole office is on my phone!",
  reveal: '',
  endcard: 'Your turn.\nPlay tonight',
};

describe('(mock): the three variants', () => {
  for (const [id, lang] of [['v1-hero', 'fa'], ['v2-cutdown', 'fa'], ['v3-setting-swap', 'en']] as const) {
    it(`${id}: every step done with no failed required check; ${lang === 'fa' ? 'stops at the fa human gates' : 'no human gate (en)'}`, async () => {
      const t = shared.templates[0]!;
      const v = t.variants!.find((x) => x.id === id)!;
      const s = scaleTemplate(t, { totalSec: v.lengthSec, bpm: v.bpm, segmentSec: v.segmentSec });
      const texts = lang === 'fa' ? FA : EN;
      const beats: RecipeBeat[] = s.segments.map((x, i) => ({ id: `b${String(i + 1).padStart(2, '0')}`, start: x.from / 30, end: x.to / 30, segment: x.id, name: x.id, purpose: x.id, visual: 'flat card', techniques: [], onScreenText: { [lang]: texts[x.id] ?? '' }, audio: '', motion: '' }));
      const project = { id: 'example-project', timeZone: 'Asia/Tehran' };
      const { recipe } = await createRecipe(tmp.root, project, { referenceId: 'ref-20261107-0b0b', projectId: project.id, campaignId: null, packId: 'example-word-game', languages: [lang], lengthSec: v.lengthSec, shape: '9:16', fps: 30, capUsd: 0, beats, style: { captions: 'word-pop', pace: 'fast', palette: [], type: '', voice: '', music: '' }, assets: [], tempo: { bpm: v.bpm!, downbeatMs: 0 }, evidence: { sheets: [], cuts: [], silences: [], loudnessLufs: null }, stopAfterRecipe: false });
      await writePipelineVersion(tmp.root, recipe.id, buildPipeline(recipe, {}));
      const engine = new PostmakerEngine({
        root: tmp.root,
        project,
        packLock: null,
        executors: serviceExecutors({ root: tmp.root, render: fakeRenderChain(), claudeCli: null, fakes: { counters: newCounters() }, renderDeps: { ffmpeg: null, workDir: (r, n) => path.join(tmp.dir, 'work', r, n.replace(/:/g, '-')) } }),
      });
      const { estimate } = await engine.estimate(recipe.id, { all: true });
      const run = await (await engine.run({ recipeId: recipe.id, scope: { all: true }, estimateToken: estimate.token })).done;
      expect(run.status, JSON.stringify(run.steps.filter((x) => x.status !== 'done'))).toBe('done');
      const st = await engine.state(recipe.id);
      const failed = Object.values(st.current).flatMap((x) => (x?.checks ?? []).filter((c) => c.required && !c.ok).map((c) => `${x!.nodeId}: ${c.text}`));
      expect(failed).toEqual([]);
      expect(acceptBlockers(st, { asDraft: true })).toEqual([]);
      const unsigned = acceptBlockers(st, { asDraft: false }).filter((b) => b.why === 'unsigned').map((b) => b.nodeId);
      expect(unsigned).toEqual(lang === 'fa' ? ['narration-text:fa', 'voice:fa'] : []);
      expect(s.segments.some((x) => x.id === 'escalation')).toBe(v.lengthSec >= 40);
    }, 30_000);
  }
});
