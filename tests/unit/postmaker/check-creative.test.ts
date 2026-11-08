// @vitest-environment node
// The check reads the creative chain. Quality bar acceptance 7 on the compiled motion (a Tier B lead on
// screen over 20 % cannot record 4 or 5; a Tier A lead can), rows cite measurements (the lint, the
// rig tiers, narration over the bed, the SFX cues), and the AI flag follows scenes.aiGenerated (follow-up).
import { describe, expect, it } from 'vitest';
import { runDeterministic } from '@/lib/studio/postmaker/checks/deterministic';
import { draftSheet } from '@/lib/studio/postmaker/checks/sheet';
import { mixAudioOf, presenceOf } from '@/lib/studio/postmaker/executors/check';
import { aiGeneratedFrom } from '@/lib/studio/postmaker/executors/post-copy';
import type { StepVersion } from '@/lib/studio/postmaker/types';
import { answer, baseSubject } from './check-fixtures';
import './guard';

const doc = (lead: 'A' | 'B', leadFrames: number[][], foil?: number[][]) => ({
  compiled: { characters: [...leadFrames.map(([from, to]) => ({ charId: 'lead', from: from!, to: to! })), ...(foil ?? []).map(([from, to]) => ({ charId: 'foil', from: from!, to: to! }))] },
  world: { rigs: { lead: { tier: lead }, foil: { tier: 'B' } } },
});
const c5Of = (d: ReturnType<typeof doc>) => {
  const subject = baseSubject({ characters: { list: presenceOf(d) } });
  return draftSheet({ lang: 'en', medium: 'video', report: runDeterministic(subject), answer: answer(5), scoredBy: 'agent-sdk', unscoredReason: null }).scores.find((s) => s.criterion === 'C5')!;
};

describe('acceptance 7 on the compiled motion', () => {
  it('presence sums each character’s appearances with its rig tier', () => {
    expect(presenceOf(doc('B', [[0, 180], [312, 522]], [[180, 312]]))).toEqual([{ id: 'foil', tier: 'B', onScreenFrames: 132 }, { id: 'lead', tier: 'B', onScreenFrames: 390 }]);
  });

  it('a Tier B lead on screen 43 % is capped at 3; at 20 % it may reach 4; a Tier A lead with a 15 % Tier B foil reaches 4, alone 5', () => {
    expect(c5Of(doc('B', [[0, 390]]))).toMatchObject({ score: 3 });
    expect(c5Of(doc('B', [[0, 180]]))).toMatchObject({ score: 4 });
    expect(c5Of(doc('A', [[0, 900]], [[180, 312]]))).toMatchObject({ score: 4 });
    const alone = c5Of(doc('A', [[0, 900]]));
    expect(alone.score).toBe(5);
    expect(alone.evidence.find((e) => e.ref === 'rig:tiers')?.value).toBe('lead A 100 %; ceiling 5');
  });
});

describe('rows cite measurements', () => {
  it('a clean lint and the narration-bed and SFX checks are evidence; a failing bed or a dropped cue caps at 3', () => {
    const motion = { characters: [{ charId: 'lead', from: 0, to: 300, loops: ['breath', 'blink'] as never, poses: [{ pose: 'neutral' as const, at: 0 }], gestures: [] }] };
    const ok = { narrationBed: { ok: true, text: 'Narration over the music bed: lowest 9.1 dB at 4 measured lines (needs 8 dB)' }, sfx: { ok: true, text: 'SFX: 5 cues, stem peak -7.2 dBFS (at most -6)', dropped: null } };
    const r = runDeterministic(baseSubject({ motion, audio: ok }));
    expect(r.evidence.C5?.map((e) => e.ref)).toContain('motion:c5-lint');
    expect(r.evidence.C9?.map((e) => e.ref)).toEqual(expect.arrayContaining(['loudness:master', 'mix:narration-bed', 'mix:sfx']));
    expect(r.caps.C9).toBeUndefined();
    expect(runDeterministic(baseSubject({ audio: { ...ok, narrationBed: { ok: false, text: 'too low' } } })).caps.C9?.max).toBe(3);
    expect(runDeterministic(baseSubject({ audio: { ...ok, sfx: { ...ok.sfx, dropped: 'Dropped 1 SFX cue with no sound in the library: tick' } } })).caps.C9?.max).toBe(3);
  });

  it('mixAudioOf reads the mix version checks of the language', () => {
    const v = { checks: [{ id: 'mix:en:narration-bed', ok: true, required: true, text: 'bed' }, { id: 'mix:en:sfx', ok: true, required: true, text: 'sfx' }, { id: 'mix:en:sfx-dropped', ok: false, required: false, text: 'dropped' }] } as unknown as StepVersion;
    expect(mixAudioOf(v, 'en')).toEqual({ narrationBed: { ok: true, text: 'bed' }, sfx: { ok: true, text: 'sfx', dropped: 'dropped' } });
    expect(mixAudioOf(v, 'fa')).toBeNull();
    expect(mixAudioOf(undefined, 'en')).toBeNull();
  });
});

describe('the AI flag follows an AI-generated asset on screen', () => {
  it('post-copy flags a live lineage whose timeline carries an AI-generated asset', () => {
    const local = { mode: 'live' as const, inputs: [{ version: { mode: 'live', provenance: { connector: 'local', executor: 'local' } } }] as never };
    expect(aiGeneratedFrom({ ...local, byPort: { timeline: { aiAssets: false } } })).toBe(false);
    expect(aiGeneratedFrom({ ...local, byPort: { timeline: { aiAssets: true } } })).toBe(true);
  });
});
