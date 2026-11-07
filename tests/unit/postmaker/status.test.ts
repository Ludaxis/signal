// @vitest-environment node
// derived status: out-of-date is computed from recorded input hashes, settings, pack refs and
// the implementation version; a locked node stops propagation and shows "Out of date · locked"; skipped inputs make a
// node "Needs you · missing input". Gate records by 'mock' count as unsigned; accept blockers (acc. 5).
import './guard';
import { describe, expect, it } from 'vitest';
import { acceptBlockers, assertAcceptable, deriveStatus, gateStateOf, outputsHash, REASON_IMPL, type GraphState } from '@/lib/studio/postmaker/graph/status';
import { emptyHead } from '@/lib/studio/postmaker/store/heads';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import type { PipelineNode, StepHead, StepVersion } from '@/lib/studio/postmaker/types';
import { versionDraft } from './fixtures';

const RC = 'rc-20261106-0001';
const node = (id: string, inputs: string[], o: Partial<PipelineNode> = {}): PipelineNode => ({
  id,
  kind: id.split(/[:#]/)[0] as PipelineNode['kind'],
  lang: (id.split(':')[1] as 'fa' | 'en') ?? null,
  title: id,
  role: null,
  connectorChain: ['local'],
  params: {},
  instructions: '',
  inputs: inputs.map((f) => ({ port: f, from: f, fromPort: 'out', required: true })),
  expects: [],
  gate: null,
  attendance: 'any',
  ...o,
});

const ver = (id: string, n: number, inputs: [string, number, string][] = [], o: Partial<StepVersion> = {}): StepVersion => ({
  ...versionDraft(RC, id),
  schema: 'signal.pm.step-version/1',
  n,
  createdAt: '2026-11-06T10:00:00.000Z',
  inputs: inputs.map(([nodeId, version, hash]) => ({ port: nodeId, nodeId, version, hash })),
  hash: `${id}@${n}`,
  ...o,
});

// fixture: five steps in a chain with a side branch; step 4 (motion:en) is locked.
//   script(1) → narration-text:en(2) → voice:en(3) → motion:en(4, locked) → compose:en(5)
//                                                  └──────────────────────────↗
const NODES = [node('script', []), node('narration-text:en', ['script']), node('voice:en', ['narration-text:en']), node('motion:en', ['voice:en']), node('compose:en', ['motion:en', 'voice:en'])];

function state(o: { versions?: Record<string, StepVersion | null>; heads?: Record<string, Partial<StepHead>>; nodes?: PipelineNode[] } = {}): GraphState {
  const current: Record<string, StepVersion | null> = {
    script: ver('script', 1),
    'narration-text:en': ver('narration-text:en', 1, [['script', 1, 'script@1']]),
    'voice:en': ver('voice:en', 1, [['narration-text:en', 1, 'narration-text:en@1']]),
    'motion:en': ver('motion:en', 1, [['voice:en', 1, 'voice:en@1']]),
    'compose:en': ver('compose:en', 1, [
      ['motion:en', 1, 'motion:en@1'],
      ['voice:en', 1, 'voice:en@1'],
    ]),
    ...o.versions,
  };
  const heads = Object.fromEntries((o.nodes ?? NODES).map((n) => [n.id, { ...emptyHead(0), current: current[n.id]?.n ?? null, ...o.heads?.[n.id] }]));
  return { pipeline: { nodes: o.nodes ?? NODES }, heads, current, packLock: null, implVersions: {} };
}

const stale = (s: GraphState) => Object.values(deriveStatus(s)).filter((x) => x.outOfDate).map((x) => x.nodeId);

describe('derived status', () => {
  it('everything current: done and nothing out of date', () => {
    const st = deriveStatus(state());
    expect(Object.values(st).map((x) => x.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(stale(state())).toEqual([]);
  });

  it('a new version of step k makes its users out of date and nothing else', () => {
    const s = state({ versions: { 'narration-text:en': ver('narration-text:en', 2, [['script', 1, 'script@1']]) } });
    const st = deriveStatus(s);
    expect(st['voice:en']).toMatchObject({ outOfDate: true, direct: true, reasons: ['narration-text:en changed'] });
    expect(stale(s)).toEqual(['voice:en', 'motion:en', 'compose:en']);
    expect(Object.values(st).filter((x) => x.direct).map((x) => x.nodeId)).toEqual(['voice:en']);
  });

  it('a locked step stops propagation and shows "Out of date · locked"', () => {
    const s = state({
      heads: { 'motion:en': { locked: true } },
      versions: { 'voice:en': ver('voice:en', 2, [['narration-text:en', 1, 'narration-text:en@1']]) },
    });
    const st = deriveStatus(s);
    expect(st['motion:en']).toMatchObject({ outOfDate: false, lockedButChanged: true, reasons: ['voice:en changed'] });
    expect(st['compose:en']).toMatchObject({ outOfDate: true, reasons: ['voice:en changed'] }); // it also reads voice directly
    const t = state({ heads: { 'motion:en': { locked: true } }, versions: { 'narration-text:en': ver('narration-text:en', 2, [['script', 1, 'script@1']]) } });
    expect(stale(t)).toEqual(['voice:en', 'compose:en']);
    // a path that only runs through the locked step does not propagate
    const chain = [node('script', []), node('art', ['script']), node('motion:en', ['art']), node('compose:en', ['motion:en'])];
    const c = state({
      nodes: chain,
      heads: { 'motion:en': { locked: true } },
      versions: {
        script: ver('script', 2),
        art: ver('art', 1, [['script', 1, 'script@1']]),
        'motion:en': ver('motion:en', 1, [['art', 1, 'art@1']]),
        'compose:en': ver('compose:en', 1, [['motion:en', 1, 'motion:en@1']]),
      },
    });
    expect(stale(c)).toEqual(['art']);
  });

  it('settings, pack entries and the implementation version are reasons; skipped inputs need you', () => {
    const p = NODES.map((n) => (n.id === 'voice:en' ? { ...n, params: { speed: 1.1 } } : n));
    expect(deriveStatus(state({ nodes: p }))['voice:en']!.reasons).toEqual(['Settings changed']);
    const lock = { schema: 'signal.pm.pack-lock/1' as const, packId: 'example-pack', version: '1.0.0', readAt: '', entries: { 'lexicon:en': 'b'.repeat(64) }, root: '' };
    const s = state({ versions: { 'narration-text:en': ver('narration-text:en', 1, [['script', 1, 'script@1']], { packRefs: [{ ref: 'lexicon:en', sha256: 'a'.repeat(64) }] }) } });
    s.packLock = lock;
    const st = deriveStatus(s);
    expect(st['narration-text:en']!.reasons).toEqual(['Lexicon changed']);
    expect(stale(s)).toEqual(['narration-text:en', 'voice:en', 'motion:en', 'compose:en']);
    const u = state();
    u.implVersions = { motion: 'motion@2' };
    expect(deriveStatus(u)['motion:en']!.reasons).toEqual([REASON_IMPL]);
    const k = state({ heads: { 'voice:en': { skipped: true } } });
    const ks = deriveStatus(k);
    expect(ks['voice:en']!.status).toBe('skipped');
    expect(ks['motion:en']).toMatchObject({ status: 'needs-you', missingInput: true, reasons: ['Missing input'] });
  });

  it('not run, off, and run overlays', () => {
    const s = state({ versions: { 'compose:en': null } });
    s.connectorOff = (n) => n.id === 'compose:en';
    expect(deriveStatus(s)['compose:en']!.status).toBe('off');
    s.running = { 'compose:en': 'running', 'voice:en': 'failed' };
    expect(deriveStatus(s)['compose:en']!.status).toBe('running');
    expect(deriveStatus(s)['voice:en']!.status).toBe('failed');
  });
});

describe('gates and accept', () => {
  const gated = NODES.map((n) => (n.id === 'narration-text:en' ? { ...n, id: 'narration-text:en', gate: { id: 'fa-native-editor' as const, blocks: 'before-paid-downstream' as const } } : n));

  it('a gate record by mock is reported but counts as unsigned; a named pass for this version signs it', () => {
    const v = ver('narration-text:en', 1, [['script', 1, 'script@1']]);
    const mock = { ...v, signoffs: [{ gate: 'fa-native-editor' as const, nodeId: v.nodeId, version: 1, hash: outputsHash(v), by: 'mock', name: 'mock', at: '', verdict: 'pass' as const }] };
    expect(gateStateOf(gated[1]!, mock)).toMatchObject({ signed: false, mock: true });
    const real = { gate: 'fa-native-editor' as const, nodeId: v.nodeId, version: 1, hash: v.hash, by: 'editor@example.test', name: 'Editor A', at: '', verdict: 'pass' as const };
    expect(gateStateOf(gated[1]!, mock, [real])).toMatchObject({ signed: true, mock: false });
    expect(gateStateOf(gated[1]!, mock, [{ ...real, version: 2 }])!.signed).toBe(false); // bound to the exact version
    expect(gateStateOf(gated[1]!, mock, [{ ...real, hash: 'f'.repeat(64) }])!.signed).toBe(false);
  });

  it('Accept is refused (409) while a node is out of date or failed; drafts waive only gates and mock', () => {
    const s = state({ nodes: gated, versions: { 'voice:en': ver('voice:en', 2, [['narration-text:en', 1, 'narration-text:en@1']]) } });
    expect(acceptBlockers(s, { asDraft: true }).map((b) => [b.nodeId, b.why])).toEqual([
      ['motion:en', 'out-of-date'],
      ['compose:en', 'out-of-date'],
    ]);
    try {
      assertAcceptable(s, { asDraft: true });
      throw new Error('expected 409');
    } catch (e) {
      expect(isPostmakerError(e, 'accept-blocked')).toBe(true);
      expect((e as { status: number }).status).toBe(409);
    }
    const f = state({ nodes: gated });
    f.running = { 'compose:en': 'failed' };
    expect(acceptBlockers(f, { asDraft: true }).map((b) => b.why)).toEqual(['failed']);
    const ok = state({ nodes: gated });
    expect(acceptBlockers(ok, { asDraft: true })).toEqual([]);
    expect(acceptBlockers(ok, { asDraft: false }).map((b) => [b.nodeId, b.why])).toEqual([
      ['script', 'mock'],
      ['narration-text:en', 'unsigned'],
      ['narration-text:en', 'mock'],
      ['voice:en', 'mock'],
      ['motion:en', 'mock'],
      ['compose:en', 'mock'],
    ]);
  });
});
