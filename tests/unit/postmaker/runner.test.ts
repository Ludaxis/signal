// @vitest-environment node
// runner on fakes (and the real narration-text step): one-click mock run to Proof with mock gate records
// unsigned (engine part), (contracts and adapters), (pinned beats),
// (overwriteEdit), (estimate token), (cache), on the engine,
// (cap pause), use-version, skip, choose-candidate.
import './guard';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { acceptBlockers } from '@/lib/studio/postmaker/graph/status';
import { readHead } from '@/lib/studio/postmaker/store/heads';
import { getJson, hashJson } from '@/lib/studio/postmaker/store/objects';
import { readEvents } from '@/lib/studio/postmaker/store/runs';
import { listVersionNumbers, readVersion } from '@/lib/studio/postmaker/store/versions';
import { openReservations } from '@/lib/studio/postmaker/store/ledger';
import { readJsonLines } from '@/lib/studio/postmaker/store/fs';
import { ledgerFile } from '@/lib/studio/postmaker/store/paths';
import type { LedgerLine } from '@/lib/studio/postmaker/types';
import type { ScriptDoc } from '@/lib/studio/postmaker/graph/adapters';
import { runAll, scriptedVoice, setup, signAll, versionsOf } from './engine-fixtures';
import { tmp } from './guard';

const ALL22 = [
  'script', 'art', 'music', 'check',
  ...['narration-text', 'voice', 'lipsync', 'motion', 'captions', 'compose', 'mix', 'render', 'post-copy'].flatMap((k) => [`${k}:fa`, `${k}:en`]),
];

const expect409 = async (p: Promise<unknown>, code: string, message?: string) => {
  try {
    await p;
  } catch (e) {
    expect(isPostmakerError(e, code), String(e)).toBe(true);
    expect((e as { status: number }).status).toBe(409);
    if (message) expect((e as Error).message).toBe(message);
    return e;
  }
  throw new Error(`expected 409 ${code}`);
};

describe('one-click mock run', () => {
  it('reaches Proof: 22 nodes done, all mock, $0, mock gate records reported unsigned', async () => {
    const { engine, recipeId } = await setup();
    const before = await engine.status(recipeId);
    expect(before.script!.status).toBe('off'); // no connector allowed: runs as mock
    const run = await runAll(engine, recipeId);
    expect(run.status).toBe('done');
    expect(run.spentUsd).toBe(0);
    expect(run.steps).toHaveLength(22);
    expect(run.steps.every((s) => s.status === 'done' && s.mode === 'mock')).toBe(true);
    const st = await engine.status(recipeId);
    expect(Object.keys(st).sort()).toEqual([...ALL22].sort());
    expect(Object.values(st).every((x) => x.status === 'done' && !x.outOfDate)).toBe(true);
    expect(st['narration-text:fa']!.gate).toMatchObject({ signed: false, mock: true });
    expect(st['voice:fa']!.gate).toMatchObject({ signed: false, mock: true });
    const s = await engine.state(recipeId);
    expect(acceptBlockers(s, { asDraft: true })).toEqual([]); // "Accept as draft" is offered
    const clean = acceptBlockers(s, { asDraft: false });
    expect(clean.filter((b) => b.why === 'unsigned').map((b) => b.nodeId)).toEqual(['narration-text:fa', 'voice:fa']);
    expect(clean.some((b) => b.why === 'mock')).toBe(true);
    const v = (await readVersion(tmp.root, recipeId, 'narration-text:fa', 1))!;
    expect(v.signoffs).toEqual([expect.objectContaining({ gate: 'fa-native-editor', by: 'mock', version: 1 })]);
    expect(v.implVersion).toBe('narration-text@1');
    const lines = await getJson<{ lines: { review: { text: { by: string } } }[] }>(tmp.root, v.outputs[0]!.sha256);
    expect(lines.lines.every((l) => l.review.text.by === 'mock')).toBe(true); // the real executor ran
    for (const id of ALL22) expect((await readVersion(tmp.root, recipeId, id, 1))!.runId, id).toBe(run.id); // provenance
    const { events } = await readEvents(tmp.root, run.id);
    expect(events[0]!.kind).toBe('run.started');
    expect(events.at(-1)!.kind).toBe('run.done');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  });

  it('running again with nothing changed makes no new version; one param change makes one new version of that step', async () => {
    const { engine, recipeId, pipeline } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    const v1 = await versionsOf(recipeId, pipeline.nodes.map((n) => n.id));
    expect((await engine.estimate(recipeId, { all: true })).plan).toEqual([]);
    const again = await runAll(engine, recipeId);
    expect(again.steps).toEqual([]);
    expect(await versionsOf(recipeId, pipeline.nodes.map((n) => n.id))).toEqual(v1);
    const { writePipelineVersion } = await import('@/lib/studio/postmaker/store/recipes');
    const nodes = pipeline.nodes.map((n) => (n.id === 'captions:en' ? { ...n, params: { maxWords: 4 } } : n));
    await writePipelineVersion(tmp.root, recipeId, { builtFrom: pipeline.builtFrom, nodes, edges: pipeline.edges });
    const st = await engine.status(recipeId);
    expect(st['captions:en']!.reasons).toEqual(['Settings changed']);
    const run = await runAll(engine, recipeId);
    expect(run.steps[0]).toMatchObject({ nodeId: 'captions:en', version: 2 });
    expect(await listVersionNumbers(tmp.root, recipeId, 'captions:en')).toEqual([1, 2]);
    expect(await versionsOf(recipeId, ['script', 'voice:en', 'art'])).toEqual({ script: v1.script, 'voice:en': v1['voice:en'], art: v1.art });
  });

  it('a deterministic step whose inputs return to a known state reuses that version (cache.hit, no new version)', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    // regenerate voice (new take), then go back to the first take: dependents' inputs match their v1 again.
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:en', mode: 'allow-breaks' });
    expect(r.outcome).toBe('ok');
    await runAll(engine, recipeId);
    const captionsVersions = await listVersionNumbers(tmp.root, recipeId, 'captions:en');
    await engine.useVersion(recipeId, 'voice:en', 1);
    const run = await runAll(engine, recipeId);
    const hits = (await readEvents(tmp.root, run.id)).events.filter((e) => e.kind === 'cache.hit').map((e) => e.nodeId);
    expect(hits).toContain('captions:en');
    expect(await listVersionNumbers(tmp.root, recipeId, 'captions:en')).toEqual(captionsVersions);
    expect((await readHead(tmp.root, recipeId, 'captions:en')).current).toBe(1);
  });
});

describe('estimate token', () => {
  it('a stale token answers 409 with the new estimate; the right token starts the run', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    const { estimate } = await engine.estimate(recipeId, { all: true });
    expect(estimate.nodes).toHaveLength(13);
    await engine.lock(recipeId, 'music', 'tester@example.test'); // heads changed since the estimate
    const e = (await expect409(engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token }), 'estimate-changed', 'Estimate changed')) as { estimate: { token: string; nodes: unknown[] } };
    expect(e.estimate.token).not.toBe(estimate.token);
    expect(e.estimate.nodes).toHaveLength(12);
    const h = await engine.run({ recipeId, scope: { all: true }, estimateToken: e.estimate.token });
    expect((await h.done).status).toBe('needs-you'); // music locked without a version: its dependents miss an input
  });
});

describe('regenerate with contracts', () => {
  // The graph (no lip-sync): 20 nodes.
  const ALL20 = ALL22.filter((id) => !id.startsWith('lipsync:'));

  it('a take 5 % longer keeps the timing current: captions.recompute, motion.retimeHolds and compose.rebuild run; mix (new voice stems), render, post-copy and check go out of date', async () => {
    const voice = scriptedVoice();
    const { engine, recipeId } = await setup({ build: {}, fakes: { voiceMs: voice.fn } });
    await runAll(engine, recipeId);
    const before = await versionsOf(recipeId, ALL20);
    voice.scale['l03:fa'] = 1.05;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:fa', mode: 'keep-contracts' });
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    // Batch C: mix reads the voice stems directly, so no mix.replan absorbs a voice change;: post-copy
    // reads the composed timeline (for the subtitles), so a rebuilt timeline puts it out of date.
    expect(r.adapted).toEqual(['motion:fa', 'captions:fa', 'compose:fa']);
    expect(r.outOfDate.sort()).toEqual(['check', 'mix:fa', 'post-copy:fa', 'render:fa']);
    const after = await versionsOf(recipeId, ALL20);
    for (const id of ALL20) {
      if (['voice:fa', 'motion:fa', 'captions:fa', 'compose:fa'].includes(id)) expect(after[id], id).toBe(before[id]! + 1);
      else expect(after[id], id).toBe(before[id]);
    }
    const m1 = (await readVersion(tmp.root, recipeId, 'motion:fa', 1))!;
    const m2 = (await readVersion(tmp.root, recipeId, 'motion:fa', 2))!;
    expect(m2.source).toBe('adapt');
    expect(m2.runId).toBe(r.runId); // provenance: the adapter version names the run whose step triggered it
    expect((await readVersion(tmp.root, recipeId, 'voice:fa', 2))!.runId).toBe(r.runId);
    expect(m2.cost.actualUsd).toBe(0);
    expect(Math.abs(m2.provides.totalFrames! - m1.provides.totalFrames!)).toBeLessThanOrEqual(15);
    expect(m2.provides.totalFrames).toBeGreaterThan(m1.provides.totalFrames!);
    const st = await engine.status(recipeId);
    expect(st['art']!.outOfDate).toBe(false); // S3 unchanged
    expect(st['music']!.outOfDate).toBe(false);
    for (const id of ALL20.filter((i) => i.endsWith(':en'))) expect(st[id]!.outOfDate, id).toBe(false);
  });

  it('mix.replan still absorbs a new timeline alone: an edited compose output adapts mix (scope)', async () => {
    const { engine, recipeId } = await setup({ build: {} });
    await runAll(engine, recipeId);
    const v = (await readVersion(tmp.root, recipeId, 'compose:fa', 1))!;
    const doc = await getJson<Record<string, unknown>>(tmp.root, v.outputs.find((o) => o.port === 'timeline')!.sha256);
    const e = await engine.edit({ recipeId, nodeId: 'compose:fa', baseVersion: 1, output: { json: { timeline: { ...doc, coverFrame: 1 } } }, by: 'tester@example.test' });
    expect(e.adapted).toContain('mix:fa');
  });

  it('with a dialogue lip-sync step, the same take leaves lip-sync honestly out of date (no adapter; paid re-sync) and what reads it', async () => {
    const voice = scriptedVoice();
    const { engine, recipeId } = await setup({ fakes: { voiceMs: voice.fn } });
    await runAll(engine, recipeId);
    voice.scale['l03:fa'] = 1.05;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:fa', mode: 'keep-contracts' });
    if (r.outcome !== 'ok') throw new Error(r.outcome);
    expect(r.adapted).toEqual(['motion:fa', 'captions:fa', 'compose:fa']);
    expect(r.outOfDate.sort()).toEqual(['check', 'compose:fa', 'lipsync:fa', 'mix:fa', 'motion:fa', 'post-copy:fa', 'render:fa']);
  });

  it('a take 20 % longer returns contract-break with a diff naming lineMs.l03 and beatFrames.b02 and changes no head; allow-breaks then marks S4/S5 out of date and leaves S3', async () => {
    const voice = scriptedVoice();
    const { engine, recipeId, fakes } = await setup({ fakes: { voiceMs: voice.fn } });
    await runAll(engine, recipeId);
    const before = await versionsOf(recipeId, ALL22);
    voice.scale['l03:fa'] = 1.2;
    const runsBefore = fakes.counters!.runs['voice:fa'] ?? 0;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:fa', mode: 'keep-contracts' });
    expect(r.outcome).toBe('contract-break');
    if (r.outcome !== 'contract-break') return;
    expect(fakes.counters!.runs['voice:fa']! - runsBefore).toBe(3); // up to 3 takes for voice
    const keys = r.diff.map((d) => d.key);
    expect(keys).toContain('lineMs.l03');
    expect(keys).toContain('beatFrames.b02');
    expect(r.diff.find((d) => d.key === 'lineMs.l03')).toMatchObject({ from: 2500, to: 3000, dependents: expect.arrayContaining(['motion:fa']) });
    expect(r.violations[0]).toBe('Line l03 must be 2,250-2,750 ms; your take was 3,000 ms');
    expect(await versionsOf(recipeId, ALL22)).toEqual(before); // nothing current changed
    const cand = (await readVersion(tmp.root, recipeId, 'voice:fa', r.candidate))!;
    expect(cand.status).toBe('candidate');
    const ev = await readEvents(tmp.root, r.runId);
    expect(ev.events.some((e) => e.kind === 'step.done' && e.nodeId === 'voice:fa')).toBe(true);
    // the user chooses allow-breaks for this candidate
    const c = await engine.chooseCandidate(recipeId, 'voice:fa', r.candidate, true);
    expect(c.head.current).toBe(r.candidate);
    expect(c.diff.map((d) => d.key)).toContain('lineMs.l03');
    const st = await engine.status(recipeId);
    expect(st['art']!.outOfDate).toBe(false); // S3 unchanged
    expect(st['motion:fa']!.outOfDate).toBe(true); // S4
    expect(st['compose:fa']!.outOfDate).toBe(true); // S5
    expect(st['captions:fa']!.outOfDate).toBe(true);
    expect(st['music']!.outOfDate).toBe(false); // the music bed itself does not read voice
    expect(st['mix:fa']!.outOfDate).toBe(true); // mix reads voice directly in the graph (see report)
  });

  it('a discarded candidate stays as history only', async () => {
    const voice = scriptedVoice();
    const { engine, recipeId } = await setup({ langs: ['fa'], fakes: { voiceMs: voice.fn } });
    await runAll(engine, recipeId);
    voice.scale['l03:fa'] = 1.2;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:fa' });
    if (r.outcome !== 'contract-break') throw new Error(r.outcome);
    const c = await engine.chooseCandidate(recipeId, 'voice:fa', r.candidate, false);
    expect(c.head.current).toBe(1);
    expect(await listVersionNumbers(tmp.root, recipeId, 'voice:fa')).toEqual([1, 2]);
  });

  it('unchecking an expects chip skips that rule; dependents become out of date ("May need a redo")', async () => {
    const voice = scriptedVoice();
    const { engine, recipeId } = await setup({ langs: ['fa'], fakes: { voiceMs: voice.fn } });
    await runAll(engine, recipeId);
    voice.scale['l03:fa'] = 1.2;
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:fa', uncheckedExpects: ['voice.lineMs.within'] });
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    expect(r.adapted).not.toContain('motion:fa');
    expect(r.outOfDate).toContain('motion:fa');
  });
});

describe('/: pinned beats', () => {
  it('regenerating script with b01 and b02 pinned keeps their beats and lines byte-identical (same object hashes)', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    await engine.setPinnedBeats(recipeId, 'script', ['b01', 'b02']);
    const r = await engine.regenerate({ recipeId, nodeId: 'script', mode: 'allow-breaks' });
    expect(r.outcome).toBe('ok');
    const s1 = await getJson<ScriptDoc>(tmp.root, (await readVersion(tmp.root, recipeId, 'script', 1))!.outputs[0]!.sha256);
    const s2 = await getJson<ScriptDoc>(tmp.root, (await readVersion(tmp.root, recipeId, 'script', 2))!.outputs[0]!.sha256);
    for (const id of ['b01', 'b02']) {
      expect(hashJson(s2.beats.find((b) => b.id === id))).toBe(hashJson(s1.beats.find((b) => b.id === id)));
      expect(hashJson(s2.lines.filter((l) => l.beatId === id))).toBe(hashJson(s1.lines.filter((l) => l.beatId === id)));
    }
    expect(hashJson(s2.beats.find((b) => b.id === 'b03'))).not.toBe(hashJson(s1.beats.find((b) => b.id === 'b03')));
  });
});

describe('/: user edits', () => {
  it('a regenerate of an edited step answers 409 without overwriteEdit and proceeds with it; edits are optimistic', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    const v1 = (await readVersion(tmp.root, recipeId, 'script', 1))!;
    const doc = await getJson<ScriptDoc>(tmp.root, v1.outputs[0]!.sha256);
    const edited = { ...doc, lines: doc.lines.map((l) => (l.id === 'l01' ? { ...l, en: { display: 'The house is loud tonight.' } } : l)) };
    const e = await engine.edit({ recipeId, nodeId: 'script', baseVersion: 1, output: { json: { script: edited } }, by: 'tester@example.test' });
    expect(e.version.runId).toBeNull(); // a plain Edit belongs to no run
    expect(e.version).toMatchObject({ n: 2, source: 'edit', editedByUser: true });
    await expect409(engine.edit({ recipeId, nodeId: 'script', baseVersion: 1, output: { json: { script: edited } }, by: 'x' }), 'conflict', 'Changed since you opened it');
    await expect409(engine.regenerate({ recipeId, nodeId: 'script' }), 'edited');
    const r = await engine.regenerate({ recipeId, nodeId: 'script', overwriteEdit: true, mode: 'allow-breaks' });
    expect(r.outcome).toBe('ok');
    expect((await readHead(tmp.root, recipeId, 'script')).current).toBe(3);
    // Undo = use-version back to the edit
    await engine.useVersion(recipeId, 'script', 2);
    expect((await readHead(tmp.root, recipeId, 'script')).current).toBe(2);
  });

  it('an edit runs the free adapters it can (post-copy.relint while the CTA is unchanged) and leaves the rest out of date', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    const doc = await getJson<ScriptDoc>(tmp.root, (await readVersion(tmp.root, recipeId, 'script', 1))!.outputs[0]!.sha256);
    const sameCta = { ...doc, beats: doc.beats.map((b) => (b.id === 'b03' ? { ...b, targetMs: b.targetMs + 100 } : b)) };
    const a = await engine.edit({ recipeId, nodeId: 'script', baseVersion: 1, output: { json: { script: sameCta } }, by: 'tester@example.test' });
    expect(a.adapted).toEqual(['post-copy:en']);
    const newCta = { ...sameCta, cta: { en: 'Play now' } };
    const b = await engine.edit({ recipeId, nodeId: 'script', baseVersion: 2, output: { json: { script: newCta } }, by: 'tester@example.test' });
    expect(b.adapted).toEqual([]);
    const st = await engine.status(recipeId);
    expect(st['post-copy:en']!.outOfDate).toBe(true); // shape: a CTA edit re-runs post-copy
    expect(st['music']!.outOfDate).toBe(true);
  });
});

describe('locks', () => {
  it('a locked step refuses regenerate with "Unlock to regenerate"; Run skips it and never writes to it', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    await engine.lock(recipeId, 'music', 'tester@example.test');
    await expect409(engine.regenerate({ recipeId, nodeId: 'music' }), 'locked', 'Unlock to regenerate');
    await expect409(engine.regenerateFromHere({ recipeId, nodeId: 'music' }), 'locked', 'Unlock to regenerate');
    await engine.regenerate({ recipeId, nodeId: 'script', mode: 'allow-breaks' });
    const st = await engine.status(recipeId);
    expect(st.music).toMatchObject({ outOfDate: false, lockedButChanged: true, reasons: ['script changed'] });
    const { plan } = await engine.estimate(recipeId, { all: true });
    expect(plan).not.toContain('music');
    await runAll(engine, recipeId);
    expect(await listVersionNumbers(tmp.root, recipeId, 'music')).toEqual([1]);
    await engine.unlock(recipeId, 'music');
    expect((await engine.status(recipeId)).music!.outOfDate).toBe(true);
  });
});

describe('on the engine (5-step fixture, step 4 locked)', () => {
  // script(1) → narration-text:en(2) → voice:en(3) → captions:en(5) and art(4, locked) → captions:en(5)
  const five = (p: { nodes: import('@/lib/studio/postmaker/types').PipelineNode[]; edges: unknown[]; builtFrom: { recipeVersion: number; builder: string } }) => {
    const keep = new Set(['script', 'narration-text:en', 'voice:en', 'art', 'captions:en']);
    const nodes = p.nodes.filter((n) => keep.has(n.id));
    return { builtFrom: p.builtFrom, nodes, edges: nodes.flatMap((n) => n.inputs.map((i) => ({ from: i.from, fromPort: i.fromPort, to: n.id, toPort: i.port, soft: !i.required }))) };
  };

  it('Regenerate on step k makes version n+1 on k only; its users show Out of date', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'], pipeline: five });
    await runAll(engine, recipeId);
    await engine.lock(recipeId, 'art', 'tester@example.test');
    const before = await versionsOf(recipeId, ['script', 'narration-text:en', 'voice:en', 'art', 'captions:en']);
    const r = await engine.regenerate({ recipeId, nodeId: 'narration-text:en' });
    expect(r.outcome).toBe('ok');
    const after = await versionsOf(recipeId, ['script', 'narration-text:en', 'voice:en', 'art', 'captions:en']);
    expect(after).toEqual({ ...before, 'narration-text:en': 2 });
    const st = await engine.status(recipeId);
    expect(['voice:en', 'captions:en'].every((id) => st[id]!.outOfDate)).toBe(true);
    expect(st.script!.outOfDate || st.art!.outOfDate).toBe(false);
  });

  it('Regenerate from here reruns k and every unlocked downstream step in order; the locked step keeps its version and its dependents use it', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'], pipeline: five });
    await runAll(engine, recipeId);
    await engine.lock(recipeId, 'art', 'tester@example.test');
    const h = await engine.regenerateFromHere({ recipeId, nodeId: 'script' });
    const run = await h.done;
    expect(run.status).toBe('done');
    expect(run.scope.nodes).toEqual(['script', 'narration-text:en', 'voice:en', 'captions:en']);
    const v = await versionsOf(recipeId, ['script', 'narration-text:en', 'voice:en', 'art', 'captions:en']);
    expect(v).toEqual({ script: 2, 'narration-text:en': 2, 'voice:en': 2, art: 1, 'captions:en': 2 });
    const cap = (await readVersion(tmp.root, recipeId, 'captions:en', 2))!;
    expect(cap.inputs.find((i) => i.nodeId === 'art')).toMatchObject({ version: 1 });
    const st = await engine.status(recipeId);
    expect(st.art).toMatchObject({ outOfDate: false, lockedButChanged: true });
    expect(st['captions:en']!.outOfDate).toBe(false);
  });
});

describe('spend cap', () => {
  it('cap $1.00 and a lip-sync estimate of $1.20: the run pauses before lipsync:fa, spent ≤ cap, no reservation for it', async () => {
    const { engine, recipeId } = await setup({
      fakes: { costs: { 'lipsync:fa': { usdHigh: 1.2, actual: 1.2 }, 'lipsync:en': { usdHigh: 0.1, actual: 0.1 } } },
      deps: { allowed: () => true, signoffs: signAll('rc-20261106-0001') },
    });
    const run = await runAll(engine, recipeId, { capUsd: 1 });
    expect(run.status).toBe('needs-you');
    expect(run.pausedFor).toBe('cap');
    expect(run.spentUsd).toBeLessThanOrEqual(1);
    const lines = await readJsonLines<LedgerLine>(ledgerFile(tmp.root));
    expect(lines.filter((l) => l.t === 'reserve' && l.nodeId === 'lipsync:fa')).toEqual([]);
    expect(lines.filter((l) => l.t === 'reserve').length).toBeGreaterThan(0); // voice was paid and reserved
    expect(await openReservations(tmp.root, run.id)).toEqual([]);
    const ev = (await readEvents(tmp.root, run.id)).events;
    expect(ev.find((e) => e.kind === 'run.paused' && e.nodeId === 'lipsync:fa')).toMatchObject({ text: 'Needs you · cap reached' });
    expect(run.steps.find((s) => s.nodeId === 'lipsync:fa')!.status).toBe('queued');
    expect(run.steps.find((s) => s.nodeId === 'voice:fa')!.mode).toBe('live');
    // Raise cap, Continue: the run finishes
    await engine.raiseCap(run.id, 3);
    const done = await (await engine.continueRun(run.id)).done;
    expect(done.status).toBe('done');
    expect(done.spentUsd).toBeLessThanOrEqual(3);
  });

  it('a live regenerate of a paid step is estimated, reserved and settled inside its own cap', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'], fakes: { costs: { 'voice:en': { usdHigh: 0.3, actual: 0.25 } } }, deps: { allowed: () => true } });
    await runAll(engine, recipeId, { capUsd: 5 });
    const { estimate, capUsd } = await engine.estimate(recipeId, { nodes: ['voice:en'] }, { exact: true });
    expect(estimate.usdHigh).toBe(0.3);
    expect(capUsd).toBe(0.5);
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:en', mode: 'allow-breaks', estimateToken: estimate.token });
    expect(r.outcome).toBe('ok');
    const lines = await readJsonLines<LedgerLine>(ledgerFile(tmp.root));
    const mine = lines.filter((l) => l.t === 'reserve' && l.runId === r.runId);
    expect(mine).toMatchObject([{ nodeId: 'voice:en', usd: 0.3 }]);
    expect(lines.find((l) => l.t === 'settle' && l.id === mine[0]!.id)).toMatchObject({ usd: 0.25, known: true });
  });

  it('live mode: an unsigned fa text gate blocks the paid voice call (before-paid-downstream) and nothing is reserved', async () => {
    const { engine, recipeId } = await setup({ langs: ['fa'], deps: { allowed: () => true } });
    const run = await runAll(engine, recipeId, { capUsd: 5 });
    expect(run).toMatchObject({ status: 'needs-you', pausedFor: 'gate' });
    expect(run.steps.find((s) => s.nodeId === 'voice:fa')!.status).toBe('queued');
    expect(await readJsonLines<LedgerLine>(ledgerFile(tmp.root))).toEqual([]);
  });

  it('Stop on a paused run releases what never ran and is final', async () => {
    const { engine, recipeId } = await setup({
      fakes: { costs: { 'lipsync:fa': { usdHigh: 1.2, actual: 1.2 }, 'lipsync:en': { usdHigh: 0.1, actual: 0.1 } } },
      deps: { allowed: () => true, signoffs: signAll('rc-20261106-0001') },
    });
    const run = await runAll(engine, recipeId, { capUsd: 1 });
    expect(run).toMatchObject({ status: 'needs-you', pausedFor: 'cap' });
    const stopped = await engine.stopRun(run.id);
    expect(stopped).toMatchObject({ status: 'stopped', pausedFor: null });
    expect(stopped.finishedAt).not.toBeNull();
    expect(stopped.spentUsd).toBeLessThanOrEqual(1);
    expect(await openReservations(tmp.root, run.id)).toEqual([]);
    expect((await readEvents(tmp.root, run.id)).events.at(-1)).toMatchObject({ kind: 'run.done', text: 'stopped' });
    await expect409(engine.continueRun(run.id), 'finished');
    await expect409(engine.stopRun(run.id), 'finished');
  });

  it('agent steps on API-key billing are estimated at the role cap; on a Claude plan they cost $0', async () => {
    const api = await setup({ langs: ['en'], fakes: { agentBilling: 'api-key' }, deps: { allowed: () => true } });
    const e = (await api.engine.estimate(api.recipeId, { all: true })).estimate;
    expect(e.nodes.find((n) => n.nodeId === 'script')).toMatchObject({ connector: 'claude-cli', mode: 'live', usdLow: 0, usdHigh: 1.2 });
    expect(e.nodes.find((n) => n.nodeId === 'post-copy:en')).toMatchObject({ usdHigh: 0.4 });
  });

  it('the project day ceiling pauses with day-ceiling', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'], fakes: { costs: { 'lipsync:en': { usdHigh: 2 } } }, deps: { allowed: () => true, dayCeilingUsd: 1 } });
    const run = await runAll(engine, recipeId, { capUsd: 10 });
    expect(run).toMatchObject({ status: 'needs-you', pausedFor: 'day-ceiling' });
  });

  it('after the script and narration texts, the run is re-estimated and a default cap is raised within the day ceiling', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'], deps: { allowed: () => true } });
    const { estimate, capUsd } = await engine.estimate(recipeId, { all: true });
    expect(estimate.nodes.find((n) => n.nodeId === 'voice:en')).toMatchObject({ usdHigh: 0 }); // no lines yet
    expect(capUsd).toBe(0);
    const run = await (await engine.run({ recipeId, scope: { all: true }, estimateToken: estimate.token, capUsd })).done;
    expect(run.status).toBe('done');
    expect(run.capUsd).toBe(0.5);
    const ev = (await readEvents(tmp.root, run.id)).events.filter((e) => e.kind === 'run.reestimate');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ nodeId: 'narration-text:en', text: 'Cap raised to $0.50', data: { usdHighBefore: 0, capBefore: 0, capAfter: 0.5, wantedCapUsd: 0.5, dayCeilingUsd: 20, chosenCap: false, limitedByDayCeiling: false } });
    const voice = (ev[0]!.data!.nodes as { nodeId: string; usdHigh: number }[]).find((n) => n.nodeId === 'voice:en')!;
    expect(voice.usdHigh).toBeGreaterThan(0);
    expect(ev[0]!.data!.usdHighAfter).toBeCloseTo(voice.usdHigh, 6);
    expect(run.spentUsd).toBeLessThanOrEqual(run.capUsd);
  });

  it('the raised cap never passes the day ceiling, and a cap the person chose is kept', async () => {
    const low = await setup({ langs: ['en'], deps: { allowed: () => true, dayCeilingUsd: 0.25 } });
    const e1 = await low.engine.estimate(low.recipeId, { all: true });
    const r1 = await (await low.engine.run({ recipeId: low.recipeId, scope: { all: true }, estimateToken: e1.estimate.token, capUsd: e1.capUsd })).done;
    expect(r1.capUsd).toBe(0.25);
    expect((await readEvents(tmp.root, r1.id)).events.find((e) => e.kind === 'run.reestimate')?.data).toMatchObject({ capAfter: 0.25, wantedCapUsd: 0.5, limitedByDayCeiling: true });

    const mine = await setup({ langs: ['en'], id: 'rc-20261106-0002', deps: { allowed: () => true } });
    const e2 = await mine.engine.estimate(mine.recipeId, { all: true });
    const r2 = await (await mine.engine.run({ recipeId: mine.recipeId, scope: { all: true }, estimateToken: e2.estimate.token, capUsd: 0.001 })).done;
    expect(r2).toMatchObject({ status: 'needs-you', pausedFor: 'cap', capUsd: 0.001 });
    expect((await readEvents(tmp.root, r2.id)).events.find((e) => e.kind === 'run.reestimate')).toMatchObject({ text: 'Cap unchanged', data: { chosenCap: true, capAfter: 0.001 } });
  });

  it('a run without the script step is not re-estimated', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await runAll(engine, recipeId);
    const { estimate } = await engine.estimate(recipeId, { nodes: ['voice:en'] }, { exact: true });
    const r = await engine.regenerate({ recipeId, nodeId: 'voice:en', mode: 'allow-breaks', estimateToken: estimate.token });
    expect((await readEvents(tmp.root, r.runId)).events.some((e) => e.kind === 'run.reestimate')).toBe(false);
  });

  it('a connector’s own day cap pauses before its node and the event names the limit and connector', async () => {
    const seen: string[] = [];
    const { engine, recipeId } = await setup({
      langs: ['en'],
      fakes: { costs: { 'lipsync:en': { usdHigh: 2 } } },
      deps: { allowed: () => true, connectorDayCapUsd: (c) => (seen.push(c), c === 'mock' ? null : 1.5) },
    });
    const run = await runAll(engine, recipeId, { capUsd: 10 });
    expect(run).toMatchObject({ status: 'needs-you', pausedFor: 'day-ceiling' });
    const ev = (await readEvents(tmp.root, run.id)).events.find((e) => e.kind === 'run.paused' && e.nodeId === 'lipsync:en');
    expect(ev?.data).toMatchObject({ pausedFor: 'day-ceiling', limit: 'connector-day', usdHigh: 2 });
    expect(seen.length).toBeGreaterThan(0);
    const lines = await readJsonLines<LedgerLine>(ledgerFile(tmp.root));
    expect(lines.filter((l) => l.t === 'reserve' && l.nodeId === 'lipsync:en')).toEqual([]);
  });
});

describe('skip and use-version', () => {
  it('skipping a step makes dependents with a required input from it "Needs you · missing input"; soft inputs are dropped', async () => {
    const { engine, recipeId } = await setup({ langs: ['en'] });
    await engine.skip(recipeId, 'lipsync:en');
    const run = await runAll(engine, recipeId);
    expect(run.status).toBe('done'); // lipsync is a soft input of motion and compose
    expect(run.steps.map((s) => s.nodeId)).not.toContain('lipsync:en');
    await engine.skip(recipeId, 'music');
    const st = await engine.status(recipeId);
    expect(st.music!.status).toBe('skipped');
    expect(st['mix:en']).toMatchObject({ status: 'needs-you', missingInput: true });
    expect(st['motion:en']!.missingInput).toBe(false); // the beat grid is soft
  });
});
