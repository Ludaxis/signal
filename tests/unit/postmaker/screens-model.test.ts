// Post maker screens: the pure rules the screens show.
import { describe, expect, it } from 'vitest';
import { acceptState, beatAt, capFor, cardsOf, defaultLength, descendants, expectsOn, furthest, gateRows, laneModifiers, laneWord, lengthAllowed, ownerOf, pmLocation, pmParams, providerLine, runCount, runNeedsYou, runsNeedingYou, signerOf, stepTitle, wordDiff } from '@/app/studio/postmaker/model';
import { comboOf, inTextField } from '@/app/studio/postmaker/keys';
import { runBarShown } from '@/app/studio/postmaker/RunBar';
import { isStatusWord } from '@/app/studio/ui/status';
import type { ProofProjection, RecipeBeat, RecipeView, RecipeViewNode, Run, SignOff, StepVersion } from '@/lib/studio/postmaker/types';

const head = (o: Partial<RecipeViewNode['head']> = {}): RecipeViewNode['head'] => ({ schema: 'signal.pm.step-head/1', current: 1, locked: false, lockedBy: null, lockedAt: null, skipped: false, pinnedBeats: [], updatedAt: '', ...o });
const version = (o: Partial<StepVersion> = {}) => ({ n: 1, hash: 'h1', mode: 'mock', outputs: [], signoffs: [], ...o }) as unknown as StepVersion;
function node(id: string, o: Partial<RecipeViewNode> = {}): RecipeViewNode {
  const [kind, lang] = id.split(':') as [RecipeViewNode['kind'], 'fa' | 'en' | undefined];
  return {
    id,
    kind,
    lang: lang ?? null,
    title: kind,
    role: null,
    connectorChain: ['mock'],
    params: {},
    instructions: '',
    inputs: [],
    expects: [],
    gate: null,
    attendance: 'any',
    status: 'done',
    outOfDate: false,
    lockedButChanged: false,
    reasons: [],
    head: head(),
    current: version(),
    versions: [],
    estimate: { usd: 0, seconds: 1 },
    gateState: null,
    ...o,
  };
}
const run = (o: Partial<Run> = {}) => ({ id: 'run-20261106-100000-abcd', status: 'needs-you', pausedFor: 'check', packageIds: [], steps: [{ nodeId: 'script', version: 1, status: 'done', usd: 0, seconds: 1, mode: 'live', error: null }], ...o }) as unknown as Run;
const proof = (o: Partial<ProofProjection> = {}) => ({ lang: 'en', verdict: 'premium', checks: [], hardGates: [], criteria: [], routes: [], ...o }) as unknown as ProofProjection;
const fa = { languages: ['fa', 'en'] } as RecipeView['recipe'];

describe('URL state', () => {
  it('reads valid parameters and drops malformed ones', () => {
    expect(pmLocation('?tab=postmaker&r=rc-20261106-ab12&s=pipeline&step=voice:fa')).toMatchObject({ r: 'rc-20261106-ab12', s: 'pipeline', step: 'voice:fa', view: 'drafts' });
    expect(pmLocation('?tab=postmaker&r=../x&s=nope&step=a%20b&view=runs&run=run-1')).toEqual({ r: null, s: null, step: null, view: 'runs', run: null, t: null });
  });
  it('writes only what is set, step only with a recipe', () => {
    expect(pmParams({ r: 'rc-20261106-ab12', s: 'proof' })).toEqual({ r: 'rc-20261106-ab12', s: 'proof' });
    expect(pmParams({ step: 'voice:fa' })).toEqual({});
    expect(pmParams({ view: 'runs', run: 'run-20261106-100000-abcd' })).toEqual({ view: 'runs', run: 'run-20261106-100000-abcd' });
  });
});

describe('step words and lanes', () => {
  it('every lane word is in the status dictionary; Out of date wins over Done; Mock and Locked are modifiers', () => {
    for (const status of ['not-run', 'queued', 'running', 'done', 'needs-you', 'failed', 'skipped', 'off'] as const) expect(isStatusWord(laneWord({ status, outOfDate: false }))).toBe(true);
    expect(laneWord({ status: 'done', outOfDate: true })).toBe('Out of date');
    expect(laneModifiers(node('voice:fa', { head: head({ locked: true }) }))).toEqual(['Mock', 'Locked']);
  });
  it('one card per kind, language nodes as lanes in the recipe order', () => {
    const cards = cardsOf([node('script'), node('voice:en'), node('voice:fa'), node('check')], ['fa', 'en']);
    expect(cards.map((c) => c.kind)).toEqual(['script', 'voice', 'check']);
    expect(cards[1]!.lanes.map((l) => l.id)).toEqual(['voice:fa', 'voice:en']);
  });
  it('"Run n steps" counts nodes that are not run, out of date or failed, never locked; m counts the mock ones', () => {
    const v = {
      nodes: [node('script', { status: 'not-run', current: null }), node('voice:fa', { outOfDate: true }), node('voice:en', { status: 'failed' }), node('music', { outOfDate: true, head: head({ locked: true }) }), node('check')],
      estimate: { nodes: [{ nodeId: 'script', mode: 'live', usdHigh: 1, seconds: 10 }, { nodeId: 'voice:fa', mode: 'mock', usdHigh: 0, seconds: 5 }, { nodeId: 'voice:en', mode: 'mock', usdHigh: 0, seconds: 5 }] },
    } as unknown as RecipeView;
    expect(runCount(v)).toEqual({ n: 3, mock: 2, usd: 1, seconds: 20 });
  });
});

describe('regenerate dialog inputs', () => {
  const v = {
    pipeline: { edges: [{ from: 'voice:fa', to: 'captions:fa' }, { from: 'captions:fa', to: 'compose:fa' }, { from: 'script', to: 'voice:fa' }], nodes: [{ id: 'script' }, { id: 'voice:fa' }, { id: 'captions:fa' }, { id: 'compose:fa' }] },
    nodes: [node('script'), node('voice:fa'), node('captions:fa', { expects: [{ id: 'voice.wordTimings.recompute', from: 'voice:fa', key: 'wordTimings', tolerance: 'recompute', label: 'Word timings', adapter: null }] }), node('compose:fa')],
  } as unknown as RecipeView;
  it('the knock-on list is every downstream node in pipeline order', () => expect(descendants(v, 'voice:fa')).toEqual(['captions:fa', 'compose:fa']));
  it('the uncheckable constraint chips are the downstream expects on this node', () => expect(expectsOn(v, 'voice:fa')).toMatchObject([{ id: 'voice.wordTimings.recompute', nodeId: 'captions:fa' }]));
});

describe('Persian gate rows and Accept', () => {
  const text = node('narration-text:fa', { gate: { id: 'fa-native-editor', blocks: 'before-paid-downstream' }, current: version({ n: 2, hash: 'ht', mode: 'live' }) });
  const voice = node('voice:fa', { gate: { id: 'fa-native-listener', blocks: 'before-paid-downstream' }, current: version({ n: 1, hash: 'hv', mode: 'live' }) });
  const sign = (nodeId: string, v: number, hash: string, name = 'Editor A', verdict: 'pass' | 'fail' = 'pass'): SignOff => ({ gate: nodeId === 'voice:fa' ? 'fa-native-listener' : 'fa-native-editor', nodeId, version: v, hash, by: 'owner@example.test', name, at: '', verdict });
  const live = (signoffs: SignOff[], p: ProofProjection[] = [proof()]) => ({ recipe: fa, nodes: [text, voice, node('check', { current: version({ mode: 'live' }) })], signoffs, run: run(), proof: p }) as unknown as RecipeView;

  it('a row is signed only by a person, on the current version and hash, with a pass', () => {
    expect(signerOf(live([sign('narration-text:fa', 2, 'ht')]), 'narration-text:fa')?.name).toBe('Editor A');
    expect(signerOf(live([sign('narration-text:fa', 1, 'old')]), 'narration-text:fa')).toBeNull(); // an edit after signing
    expect(signerOf(live([sign('narration-text:fa', 2, 'ht', 'mock')]), 'narration-text:fa')).toBeNull(); // an agent-looking name never signs
    expect(signerOf(live([sign('narration-text:fa', 2, 'ht', 'Editor A', 'fail')]), 'narration-text:fa')).toBeNull();
    expect(gateRows(live([])).map((g) => g.nodeId)).toEqual(['narration-text:fa', 'voice:fa']);
    expect(gateRows({ ...live([]), recipe: { languages: ['en'] } } as unknown as RecipeView)).toEqual([]);
  });
  it('clean Accept is disabled until both Persian rows are signed for the current hashes', () => {
    expect(acceptState(live([]))).toMatchObject({ asDraft: false, disabled: true, reason: 'unsigned' });
    expect(acceptState(live([sign('narration-text:fa', 2, 'ht')]))).toMatchObject({ disabled: true, reason: 'unsigned' });
    expect(acceptState(live([sign('narration-text:fa', 2, 'ht'), sign('voice:fa', 1, 'hv')]))).toMatchObject({ asDraft: false, disabled: false, reason: null });
  });
  it('any mock step makes the button "Accept as draft", enabled at Proof without sign-offs', () => {
    const v = { ...live([]), nodes: [text, { ...voice, current: version({ mode: 'mock' }) }] } as RecipeView;
    expect(acceptState(v)).toMatchObject({ asDraft: true, mock: true, disabled: false });
  });
  it('Unscored offers only Accept as draft; Regenerate blocks; a failed check blocks', () => {
    const signed = [sign('narration-text:fa', 2, 'ht'), sign('voice:fa', 1, 'hv')];
    expect(acceptState(live(signed, [proof({ verdict: 'unscored' })]))).toMatchObject({ asDraft: true, disabled: false });
    expect(acceptState(live(signed, [proof({ verdict: 'regenerate' })]))).toMatchObject({ disabled: true, reason: 'regenerate' });
    expect(acceptState(live(signed, [proof({ checks: [{ id: 'loudness', ok: false, measured: true, reason: 'x' }] })]))).toMatchObject({ disabled: true, reason: 'check' });
  });
  it('no run, a running run and an accepted run disable Accept with their reason', () => {
    expect(acceptState({ ...live([]), run: null })).toMatchObject({ disabled: true, reason: 'no-run' });
    expect(acceptState({ ...live([]), run: run({ status: 'running', pausedFor: null }) })).toMatchObject({ disabled: true, reason: 'running' });
    expect(acceptState({ ...live([]), run: run({ packageIds: ['01'] }) })).toMatchObject({ disabled: true, reason: 'accepted' });
  });
});

describe('beats, notes, home', () => {
  const beats = [
    { id: 'b01', start: 0, end: 6, onScreenText: { en: 'Hook' } },
    { id: 'b02', start: 6, end: 14, onScreenText: { en: '' } },
  ] as unknown as RecipeBeat[];
  it('the beat at a time, and the step that owns it (Captions with text, else Animation)', () => {
    const nodes = [node('captions:en'), node('motion:en'), node('script')];
    expect(beatAt(beats, 3)!.id).toBe('b01');
    expect(beatAt(beats, 14)!.id).toBe('b02');
    expect(ownerOf(beatAt(beats, 3), 'en', nodes)).toBe('captions:en');
    expect(ownerOf(beatAt(beats, 12), 'en', nodes)).toBe('motion:en');
    expect(ownerOf(null, 'en', [node('script')])).toBe('script');
  });
  it('drafts know how far they got; runs that need you include Proof, pauses and failures', () => {
    expect(furthest({ id: 'r', pipeline: null }, [])).toBe('recipe');
    expect(furthest({ id: 'r', pipeline: 1 }, [{ recipeId: 'r', status: 'needs-you', pausedFor: 'check', packageIds: [] }])).toBe('proof');
    expect(furthest({ id: 'r', pipeline: 1 }, [])).toBe('pipeline');
    expect(runNeedsYou({ status: 'needs-you', packageIds: [] })).toBe(true);
    expect(runNeedsYou({ status: 'failed', packageIds: [] })).toBe(true);
    expect(runNeedsYou({ status: 'done', packageIds: [] })).toBe(false);
    // Today and the badge: only the latest run of a recipe (newest first); a superseded run at Proof is not listed.
    const runs = [
      { id: 'r3', recipeId: 'a', status: 'running' as const, packageIds: [] },
      { id: 'r2', recipeId: 'b', status: 'needs-you' as const, packageIds: [] },
      { id: 'r1', recipeId: 'a', status: 'needs-you' as const, packageIds: [] },
    ];
    expect(runsNeedingYou(runs).map((r) => r.id)).toEqual(['r2']);
  });
});

describe('template limits and cap', () => {
  it('lengths outside 30-90 s are not offered; the default is the reference length when it fits, else 30', () => {
    expect(lengthAllowed(15)).toBe(false);
    expect(lengthAllowed(60)).toBe(true);
    expect(defaultLength(10)).toBe(30);
    expect(defaultLength(45.2)).toBe(45);
  });
  it('the cap is the estimate × 1.25 rounded up to the next $0.50', () => {
    expect(capFor(0)).toBe(0);
    expect(capFor(4.7)).toBe(6);
    expect(capFor(0.07)).toBe(0.5);
  });
});

describe('versions word diff', () => {
  it('marks added and removed words', () => {
    expect(wordDiff('a b c', 'a x c')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'x' },
      { op: 'same', text: 'c' },
    ]);
  });
});

describe('keyboard map', () => {
  it('names combinations; Shift is part of punctuation but a modifier for letters and named keys', () => {
    const k = (key: string, m: Partial<KeyboardEvent> = {}) => comboOf({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...m });
    expect(k('r')).toBe('R');
    expect(k('R', { shiftKey: true })).toBe('⇧R');
    expect(k('Enter', { metaKey: true })).toBe('⌘Enter');
    expect(k('?', { shiftKey: true })).toBe('?');
    expect(k(' ')).toBe('Space');
    expect(k('ArrowUp', { altKey: true })).toBe('⌥ArrowUp');
    expect(k('ArrowLeft', { shiftKey: true })).toBe('⇧ArrowLeft');
  });
  it('text fields swallow single keys; checkboxes do not', () => {
    const input = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const area = document.createElement('textarea');
    expect(inTextField(input)).toBe(true);
    expect(inTextField(area)).toBe(true);
    expect(inTextField(box)).toBe(false);
    expect(inTextField(document.createElement('button'))).toBe(false);
  });
});

describe('Run bar', () => {
  it('shows while running or paused, not at Proof or when finished', () => {
    expect(runBarShown({ status: 'running', pausedFor: null })).toBe(true);
    expect(runBarShown({ status: 'needs-you', pausedFor: 'edit' })).toBe(true);
    expect(runBarShown({ status: 'needs-you', pausedFor: 'check' })).toBe(false);
    expect(runBarShown({ status: 'done', pausedFor: null })).toBe(false);
  });
});

describe('labels, never ids', () => {
  it('stepTitle names a run step by its kind title and language', () => {
    expect(stepTitle('voice:fa')).toBe('Voice · Persian');
    expect(stepTitle('post-copy:en')).toBe('Caption and hashtags · English');
    expect(stepTitle('script')).toBe('Script');
    expect(stepTitle('unknown-kind:fa')).toBe('Step · Persian');
  });
  it('providerLine reads connector titles and role labels and leaves unknown ids out', () => {
    const rows = [{ id: 'claude-cli', title: 'Claude Code' }, { id: 'agent-sdk', title: 'Claude Agent SDK' }];
    expect(providerLine({ connectorChain: ['claude-cli', 'mock'], role: 'copywriter', lang: null }, rows)).toBe('Claude Code · Copywriter');
    expect(providerLine({ connectorChain: ['agent-sdk'], role: 'reviewer', lang: null }, rows)).toBe('Claude Agent SDK · Check');
    expect(providerLine({ connectorChain: ['local'], role: 'language-editor', lang: 'en' }, rows)).toBe('On this computer · Language editor');
    expect(providerLine({ connectorChain: ['remotion'], role: null, lang: 'fa' }, rows)).toBe('');
    expect(providerLine({ connectorChain: ['some-vendor'], role: 'some-role', lang: null }, rows)).toBe('');
  });
});
