// Post maker components: the Run bar's pauses and the step card's anatomy
// rendered in jsdom. Live runs through the routes are covered by api-routes.test.ts.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { Today } from '@/app/studio/Studio';
import type { PostmakerHome } from '@/app/studio/postmaker/api';
import { Home } from '@/app/studio/postmaker/Home';
import { RunBar } from '@/app/studio/postmaker/RunBar';
import { StepCard } from '@/app/studio/postmaker/StepCard';
import type { RecipeViewNode, Run, StepVersion } from '@/lib/studio/postmaker/types';

const run = (o: Partial<Run> = {}) =>
  ({
    id: 'run-20261106-100000-abcd',
    status: 'running',
    pausedFor: null,
    capUsd: 6,
    spentUsd: 1.2,
    scope: { nodes: ['script', 'voice:fa', 'captions:fa'] },
    steps: [
      { nodeId: 'script', version: 1, status: 'done', usd: 0, seconds: 1, mode: 'mock', error: null },
      { nodeId: 'voice:fa', version: null, status: 'running', usd: 0, seconds: 0, mode: 'mock', error: null },
      { nodeId: 'captions:fa', version: null, status: 'queued', usd: 0, seconds: 0, mode: 'mock', error: null },
    ],
    ...o,
  }) as unknown as Run;
const studio = () => {
  const host = document.createElement('div');
  host.className = 'studio';
  document.body.appendChild(host);
  return { container: host };
};
const handlers = () => ({ onStop: vi.fn(), onContinue: vi.fn(), onRaise: vi.fn() });

describe('Run bar', () => {
  it('while running: step k of n, the running step, spent of cap, Stop', () => {
    const h = handlers();
    render(<RunBar run={run()} titleOf={(id) => (id === 'voice:fa' ? 'Voice' : id)} {...h} />, studio());
    const bar = screen.getByRole('status', { name: 'Run progress' });
    expect(bar.textContent).toContain('Step 2 of 3');
    expect(bar.textContent).toContain('Voice');
    expect(bar.textContent).toContain('$1.20 of $6.00');
    fireEvent.click(within(bar).getByRole('button', { name: 'Stop' }));
    expect(h.onStop).toHaveBeenCalled();
  });
  it('an edit during the run reads "Paused for your edit" and Continue run resumes', () => {
    const h = handlers();
    render(<RunBar run={run({ status: 'needs-you', pausedFor: 'edit' })} titleOf={(id) => id} {...h} />, studio());
    const bar = screen.getByRole('status', { name: 'Run progress' });
    expect(bar.textContent).toContain('Paused for your edit');
    fireEvent.click(within(bar).getByRole('button', { name: 'Continue run' }));
    expect(h.onContinue).toHaveBeenCalled();
  });
  it('at the cap: "Needs you · cap reached" with Raise cap and Stop', () => {
    render(<RunBar run={run({ status: 'needs-you', pausedFor: 'cap' })} titleOf={(id) => id} {...handlers()} />, studio());
    const bar = screen.getByRole('status', { name: 'Run progress' });
    expect(bar.textContent).toContain('Needs you · cap reached');
    expect(within(bar).getByRole('button', { name: 'Raise cap' })).toBeTruthy();
  });
  it('at Proof or finished, there is no bar', () => {
    const { container } = render(<RunBar run={run({ status: 'needs-you', pausedFor: 'check' })} titleOf={(id) => id} {...handlers()} />, studio());
    expect(container.querySelector('.pm-runbar')).toBeNull();
  });
});

function lane(id: string, o: Partial<RecipeViewNode> = {}): RecipeViewNode {
  const [kind, lang] = id.split(':') as [RecipeViewNode['kind'], 'fa' | 'en' | undefined];
  return {
    id,
    kind,
    lang: lang ?? null,
    title: 'Voice',
    role: 'sound-designer',
    connectorChain: ['elevenlabs', 'mock'],
    params: {},
    instructions: '',
    inputs: [{ port: 'lines', from: 'narration-text:fa', fromPort: 'lines', required: true }],
    expects: [],
    gate: null,
    attendance: 'any',
    status: 'done',
    outOfDate: false,
    lockedButChanged: false,
    reasons: [],
    head: { schema: 'signal.pm.step-head/1', current: 2, locked: false, lockedBy: null, lockedAt: null, skipped: false, pinnedBeats: [], updatedAt: '' },
    current: { n: 2, hash: 'h', mode: 'mock', outputs: [{ port: 'audio', name: 'voice.fa.wav', kind: 'audio', mime: 'audio/wav', sha256: 'a'.repeat(64), bytes: 1 }], cost: { actualUsd: 0, upperBoundUsd: 0 }, seconds: 40, signoffs: [] } as unknown as StepVersion,
    versions: [],
    estimate: { usd: 0.07, seconds: 40 },
    gateState: { kind: 'off', reason: 'ElevenLabs is off. Runs as mock.', fix: 'connections' },
    ...o,
  };
}
const actions = () => ({ onSelect: vi.fn(), onOpen: vi.fn(), onRegenerate: vi.fn(), onVersions: vi.fn(), onLock: vi.fn(), onSkip: vi.fn(), onConnections: vi.fn() });

describe('Step card', () => {
  const nodes = [lane('voice:fa'), lane('voice:en', { gateState: null }), { ...lane('narration-text:fa'), title: 'Narration text' }];
  it('lanes as tabs, In and Out, a dictionary pill plus Mock, the Off line with Open Connections', () => {
    const a = actions();
    render(<StepCard card={{ kind: 'voice', title: 'Voice', lanes: nodes.slice(0, 2) }} index={2} view={{ nodes }} selectedId="voice:fa" busy={false} {...a} />, studio());
    const card = document.querySelector('.pm-card')!;
    expect(within(card as HTMLElement).getAllByRole('tab').map((x) => x.textContent)).toEqual(['Persian', 'English']);
    expect(card.querySelectorAll('.pm-io-label')).toHaveLength(2);
    expect(Array.from(card.querySelectorAll('.pill')).map((p) => p.getAttribute('data-status'))).toEqual(['Done', 'Mock']);
    expect(card.textContent).toContain('ElevenLabs is off. Runs as mock.');
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Open Connections' }));
    expect(a.onConnections).toHaveBeenCalled();
    fireEvent.click(within(card as HTMLElement).getByRole('tab', { name: 'English' }));
    expect(a.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'voice:en' }));
  });
  it('locked shows the Locked pill, aria-pressed, and a disabled Regenerate with "Unlock to regenerate"', () => {
    const locked = lane('voice:fa', { head: { ...lane('voice:fa').head, locked: true } });
    render(<StepCard card={{ kind: 'voice', title: 'Voice', lanes: [locked] }} index={0} view={{ nodes: [locked, nodes[2]!] }} selectedId={null} busy={false} {...actions()} />, studio());
    const card = document.querySelector('.pm-card') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'Unlock Voice' }).getAttribute('aria-pressed')).toBe('true');
    expect((within(card).getByRole('button', { name: 'Regenerate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(card.textContent).toContain('Unlock to regenerate');
    expect(card.querySelector('.pill[data-status="Locked"]')).toBeTruthy();
  });
  it('the provider line names the connector and role by their registry labels, never their ids', () => {
    const connectors = [{ id: 'elevenlabs', title: 'ElevenLabs' }] as never;
    const fa = { ...lane('narration-text:fa'), title: 'Narration text', role: 'language-editor', connectorChain: ['local', 'mock'] };
    const { unmount } = render(<StepCard card={{ kind: 'voice', title: 'Voice', lanes: [nodes[0]!] }} index={0} view={{ nodes, connectors }} selectedId={null} busy={false} {...actions()} />, studio());
    expect(document.querySelector('.pm-card-line')!.textContent).toBe('ElevenLabs · Sound designer');
    unmount();
    render(<StepCard card={{ kind: 'narration-text', title: 'Narration text', lanes: [fa] }} index={0} view={{ nodes: [fa], connectors }} selectedId={null} busy={false} {...actions()} />, studio());
    const line = document.querySelector('.pm-card-line')!.textContent!;
    expect(line).toBe('On this computer · Persian editor');
    expect(line).not.toMatch(/[a-z]+-[a-z]+/);
  });
  it('the More menu offers Regenerate from here, Versions and Skip', () => {
    const a = actions();
    render(<StepCard card={{ kind: 'voice', title: 'Voice', lanes: [nodes[0]!] }} index={0} view={{ nodes }} selectedId={null} busy={false} {...a} />, studio());
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getAllByRole('menuitem').map((x) => x.textContent)).toEqual(['Regenerate from here', 'Versions', 'Skip']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Regenerate from here' }));
    expect(a.onRegenerate).toHaveBeenCalledWith(expect.objectContaining({ id: 'voice:fa' }), true);
  });
});

describe('Today with Post maker runs', () => {
  const NOW = Date.parse('2026-11-06T10:00:00Z');
  const pmRun = (i: number): PostmakerHome['runs'][number] => ({
    id: `run-20261106-1000${String(i).padStart(2, '0')}-abcd`,
    recipeId: `rc-20261106-${String(i + 1).padStart(4, '0')}`, // one recipe each: Today lists the latest run per recipe
    templateId: null,
    trigger: 'run',
    status: 'needs-you',
    pausedFor: 'check',
    startedAt: new Date(NOW - i * 3600_000).toISOString(),
    finishedAt: null,
    spentUsd: 0,
    packageIds: [],
    stepsDone: 3,
    stepsTotal: 3,
    cover: null,
  });
  const home = (n: number): PostmakerHome => ({ recipes: [], templates: [], runs: Array.from({ length: n }, (_, i) => pmRun(i)), connectors: [], paused: false, timeZone: 'Asia/Tehran' });
  const data = { experiment: { id: 'x', destination: '@example.account', maxPosts: 14, posted: 0, open: true, expiresAt: NOW + 10 * 86_400_000, maxPerDay: 1 }, folder: '/tmp/example', packages: [], live: { enabled: false, reason: '' }, scheduling: { enabled: false, reason: '' }, project: { id: 'example', name: 'Example', handle: '@example.account', generator: false } } as never;

  it('run rows show their start in the project zone (en-GB, 24 h); runs past the limit go to Post maker › Runs', () => {
    const go = vi.fn();
    render(<Today data={data} go={go} onMake={() => undefined} pm={home(6)} />, studio());
    const list = screen.getByRole('region', { name: /^Needs you/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    // 10:00 UTC is 13:30 in Tehran; no browser-locale "AM/PM" or seconds.
    expect(list.textContent).toMatch(/Fri 6 Nov( 2026)?, 13:30/);
    expect(list.textContent).not.toMatch(/AM|PM|:\d\d:\d\d/);
    expect(within(list).queryByRole('button', { name: 'See all in Posts' })).toBeNull();
    fireEvent.click(within(list).getByRole('button', { name: 'See all runs' }));
    expect(go).toHaveBeenCalledWith('postmaker', { view: 'runs' });
  });
});

describe('Post maker home empty views', () => {
  const empty: PostmakerHome = { recipes: [], templates: [], runs: [], connectors: [], paused: false, timeZone: 'Asia/Tehran' };
  for (const view of ['drafts', 'proven'] as const) {
    it(`${view}: Make a post sits inside the empty notice and is the one primary`, () => {
      const go = vi.fn();
      const { container } = render(<Home pid="example" data={empty} view={view} runId={null} go={go} say={() => undefined} reload={() => undefined} />, studio());
      const notice = container.querySelector('.notice-empty')!;
      expect(notice).toBeTruthy();
      const inside = within(notice as HTMLElement).getByRole('button', { name: 'Make a post' });
      expect(inside.className).toMatch(/btn-primary/);
      expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
      expect(container.querySelector('.pm-home-head')!.querySelector('button.btn')).toBeNull();
      fireEvent.click(inside);
      expect(go).toHaveBeenCalledWith({ s: 'reference' });
    });
  }
});
