// "Move my pipelines" and the release-2 nav in jsdom: the one row on Post maker Home while pipelines are left to move; its dialog (≤ 30 words with
// its buttons, one filled button, the three facts: pause until Repeat is on, backup and exact Undo, pipelines using a
// template stay); postmaker.migrate, then a toast with Undo that calls postmaker.migrate.undo with the move's id; the
// Proven view's "Undo the move"; Moved templates (pill, no Make a post, the $0 budget floor); the nav helpers (10
// items in 4 groups after the move, Pipelines kept for pipelines using a template). Fetches are stubbed.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import type { PostmakerHome } from '@/app/studio/postmaker/api';
import { Home } from '@/app/studio/postmaker/Home';
import { Proven } from '@/app/studio/postmaker/Proven';
import { isMoved, MOVED_MIN_USD, navGroups, pipelinesInNav, repeatErrors, repeatForm, templatePills } from '@/app/studio/postmaker/model';
import { STATUS_WORDS } from '@/app/studio/ui';
import { LEGACY_REPEAT_LIMITS } from '@/lib/studio/postmaker/migrate/legacy';
import type { TemplateSummary } from '@/lib/studio/postmaker/types';

const TPL = 'tpl-20261107-ab12';
const MIG = 'mig-20261107T100000000Z-ab12';
const REPEAT = { enabled: true, perWeek: 4, days: [1, 3], times: ['09:00', '17:30'], makeAheadDays: 2, dailyUsd: 0.2, approve: 'trusted' as const };
const movedTemplate = (o: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: TPL,
  name: 'Codex pictures',
  status: 'proven',
  recipeId: '',
  provenRunId: null,
  premiumStreak: 0,
  skipProofForRepeats: false,
  skipProofAllowed: false,
  campaignIds: [],
  revision: 1,
  variants: [],
  repeat: REPEAT,
  migratedFrom: 'pl-20261102-bbbb',
  ...o,
});
const home = (o: Partial<PostmakerHome> = {}): PostmakerHome => ({ recipes: [], templates: [], runs: [], connectors: [], paused: false, timeZone: 'Europe/Berlin', migration: { pending: 3, kept: 0, undo: null }, ...o });
const studio = () => {
  const host = document.createElement('div');
  host.className = 'studio';
  document.body.appendChild(host);
  return { container: host };
};
const words = (el: Element) => (el.textContent ?? '').replace(/([a-z.])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean).length;

let calls: { url: string; body: Record<string, unknown> | null }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });
      const answer = body?.action === 'postmaker.migrate' ? { migrationId: MIG, backup: '.backup-x', moved: [{}, {}, {}], skipped: [] } : body?.action === 'postmaker.migrate.undo' ? { migrationId: MIG } : url.includes('/campaigns') ? { campaigns: [], plans: {} } : url.includes('/results') ? { byTemplate: [] } : { gates: {} };
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Post maker Home: Move my pipelines', () => {
  it('one row while pipelines are left; none when nothing is left to move', () => {
    const { container, unmount } = render(<Home pid="example" data={home()} view="drafts" runId={null} go={vi.fn()} say={vi.fn()} reload={vi.fn()} />, studio());
    expect(within(container).getAllByRole('button', { name: 'Move my pipelines (3)' })).toHaveLength(1);
    // The row's button is secondary; the screen keeps one filled button.
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    unmount();
    const { container: c2 } = render(<Home pid="example" data={home({ migration: { pending: 0, kept: 1, undo: null } })} view="drafts" runId={null} go={vi.fn()} say={vi.fn()} reload={vi.fn()} />, studio());
    expect(within(c2).queryByRole('button', { name: /Move my pipelines/ })).toBeNull();
  });

  it('the dialog says the three facts within 30 words; Move runs postmaker.migrate; the toast Undo reverts that move', async () => {
    const say = vi.fn();
    const go = vi.fn();
    const reload = vi.fn();
    const { container } = render(<Home pid="example" data={home()} view="drafts" runId={null} go={go} say={say} reload={reload} />, studio());
    fireEvent.click(within(container).getByRole('button', { name: 'Move my pipelines (3)' }));
    const dlg = container.querySelector('dialog.ui-dialog') as HTMLElement;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain('Move your pipelines to Proven?');
    expect(dlg.textContent).toContain('They pause until Repeat is on.');
    expect(dlg.textContent).toContain('A backup is kept. Undo restores it exactly.');
    expect(dlg.textContent).toContain('Pipelines using a template stay as pipelines.');
    expect(dlg.textContent).not.toMatch(/Run now|gate|SIGNAL_|\.json|backup-/);
    expect(words(dlg), dlg.textContent ?? '').toBeLessThanOrEqual(30);
    expect(dlg.querySelectorAll('.btn-primary')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Move pipelines' }));
    });
    expect(calls.find((c) => c.body?.action === 'postmaker.migrate')?.body).toEqual({ project: 'example', action: 'postmaker.migrate' });
    expect(container.querySelector('dialog.ui-dialog')).toBeNull();
    expect(go).toHaveBeenCalledWith({ view: 'proven' });
    expect(reload).toHaveBeenCalled();
    const [text, opts] = say.mock.calls.at(-1)!;
    expect(text).toBe('Moved 3 pipelines. Backup kept.');
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(8);
    await act(async () => {
      opts.onUndo();
    });
    expect(calls.find((c) => c.body?.action === 'postmaker.migrate.undo')?.body).toEqual({ project: 'example', action: 'postmaker.migrate.undo', migrationId: MIG });
    expect(say).toHaveBeenLastCalledWith('Move undone. Pipelines are back.');
  });

  it('a refused move (a run is going) stays in the dialog with the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'A run is going. Try again when it ends.' } }), { status: 409 })));
    const say = vi.fn();
    const { container } = render(<Home pid="example" data={home()} view="drafts" runId={null} go={vi.fn()} say={say} reload={vi.fn()} />, studio());
    fireEvent.click(within(container).getByRole('button', { name: 'Move my pipelines (3)' }));
    await act(async () => {
      fireEvent.click(within(container.querySelector('dialog.ui-dialog') as HTMLElement).getByRole('button', { name: 'Move pipelines' }));
    });
    const dlg = container.querySelector('dialog.ui-dialog') as HTMLElement;
    expect(dlg.textContent).toContain('The pipelines could not move.');
    expect(say).not.toHaveBeenCalled();
  });

  it('Proven: moved templates show Moved and Repeats, no Make a post; "Undo the move" asks, then undoes', async () => {
    const say = vi.fn();
    const { container } = render(<Home pid="example" data={home({ templates: [movedTemplate()], migration: { pending: 0, kept: 0, undo: MIG } })} view="proven" runId={null} go={vi.fn()} say={say} reload={vi.fn()} />, studio());
    const card = container.querySelector(`[data-template="${TPL}"]`) as HTMLElement;
    expect(within(card).getByText('Moved')).toBeTruthy();
    expect(within(card).getByText('Repeats')).toBeTruthy();
    expect(within(card).queryByText('Proven')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Make a post' })).toBeNull();
    // Its fact line is its schedule, never "0 steps" (it has no Post maker steps; the v1 generator makes its posts).
    expect(card.textContent).toContain('4 a week');
    expect(card.textContent).not.toMatch(/\bsteps?\b/);
    fireEvent.click(within(container).getByRole('button', { name: 'Undo the move' }));
    const dlg = container.querySelector('dialog.ui-dialog') as HTMLElement;
    expect(dlg.textContent).toContain('Undo the move?');
    await act(async () => {
      fireEvent.click(within(dlg).getByRole('button', { name: 'Undo the move' }));
    });
    expect(calls.find((c) => c.body?.action === 'postmaker.migrate.undo')?.body).toEqual({ project: 'example', action: 'postmaker.migrate.undo', migrationId: MIG });
    expect(say).toHaveBeenLastCalledWith('Move undone. Pipelines are back.');
  });

  it('the Proven screen of a moved template: Make a post disabled with its reason; no variant, copy or pipeline', () => {
    const x = movedTemplate();
    const data = home({ templates: [x], migration: { pending: 0, kept: 0, undo: MIG } });
    const { container } = render(<Proven pid="example" data={data} templateId={TPL} go={vi.fn()} say={vi.fn()} reload={vi.fn()} onMade={vi.fn()} />, studio());
    const make = within(container).getByRole('button', { name: /Make a post/ });
    expect(make.hasAttribute('disabled') || make.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(container.textContent).toContain('It makes posts on its schedule only.');
    for (const name of ['Add variant', 'Duplicate', 'Open pipeline']) expect(within(container).queryByRole('button', { name })).toBeNull();
    // The header shows no steps, cost or time for it; the schedule is in the Repeat row.
    const head = container.querySelector('.pm-proven-head') as HTMLElement;
    expect(head.textContent).not.toMatch(/\bsteps?\b/);
    expect(within(container).getByTestId('pm-repeat-line').textContent).toBe('4 a week');
  });

  it('a paused moved template shows no fact line on its card; a Post maker template keeps its steps', () => {
    const paused = movedTemplate({ repeat: { ...REPEAT, enabled: false } });
    const own = movedTemplate({ id: 'tpl-20261107-cd34', name: 'Own one', migratedFrom: null, provenRunId: 'run-20261107-100000-abcd', repeat: null });
    const { container } = render(<Home pid="example" data={home({ templates: [paused, own], templateCards: { [own.id]: { steps: 5 } } as unknown as PostmakerHome['templateCards'], migration: { pending: 0, kept: 0, undo: MIG } })} view="proven" runId={null} go={vi.fn()} say={vi.fn()} reload={vi.fn()} />, studio());
    const a = container.querySelector(`[data-template="${TPL}"]`) as HTMLElement;
    expect(a.textContent).not.toMatch(/\bsteps?\b|a week/);
    const b = container.querySelector('[data-template="tpl-20261107-cd34"]') as HTMLElement;
    expect(b.textContent).toContain('5 steps');
  });
});

describe('model: Moved, the nav and the moved budget floor', () => {
  it('Moved is in the dictionary and stands where Proven would', () => {
    expect(STATUS_WORDS.template).toContain('Moved');
    expect(isMoved(movedTemplate())).toBe(true);
    expect(isMoved(movedTemplate({ provenRunId: 'run-20261107-100000-abcd' }))).toBe(false);
    expect(isMoved(movedTemplate({ migratedFrom: null }))).toBe(false);
    expect(templatePills(movedTemplate())).toEqual(['Moved', 'Repeats']);
    expect(templatePills(movedTemplate({ repeat: { ...REPEAT, enabled: false } }))).toEqual(['Moved']);
    expect(templatePills(movedTemplate({ status: 'retired' }))).toEqual(['Retired']);
  });

  it('10 nav items in 4 groups after the move; Pipelines in Work while it is shown', () => {
    const after = navGroups({ postmaker: true, pipelines: false });
    expect(after.map((g) => g.group)).toEqual(['work', 'plan', 'learn', 'setup']);
    expect(after.flatMap((g) => g.items)).toEqual(['today', 'postmaker', 'posts', 'calendar', 'campaigns', 'brand', 'results', 'comments', 'memory', 'connections']);
    expect(navGroups({ postmaker: true, pipelines: true })[0]!.items).toEqual(['today', 'postmaker', 'pipelines', 'posts', 'calendar']);
    expect(navGroups({ postmaker: false, pipelines: true })[0]!.items).toEqual(['today', 'pipelines', 'posts', 'calendar']);
  });

  it('Pipelines stays while any live pipeline is left and whenever Post maker cannot say', () => {
    expect(pipelinesInNav({ pending: 0, kept: 0, undo: MIG })).toBe(false);
    expect(pipelinesInNav({ pending: 2, kept: 0, undo: null })).toBe(true);
    expect(pipelinesInNav({ pending: 0, kept: 1, undo: MIG })).toBe(true);
    expect(pipelinesInNav({ pending: 0, undo: null })).toBe(false);
    expect(pipelinesInNav(undefined)).toBe(true);
    expect(pipelinesInNav(null)).toBe(true);
  });

  it('a moved template keeps the pipeline budget range: $0.20 is fine for it, not for a Post maker template', () => {
    expect(MOVED_MIN_USD).toBe(LEGACY_REPEAT_LIMITS.dailyUsd.min);
    const f = repeatForm(REPEAT);
    expect(repeatErrors(f, { moved: true }).dailyUsd).toBeUndefined();
    expect(repeatErrors(f).dailyUsd).toBe(true);
  });
});

describe('screen reader', () => {
  it('the row is a note and the dialog is labelled by its question', () => {
    render(<Home pid="example" data={home()} view="drafts" runId={null} go={vi.fn()} say={vi.fn()} reload={vi.fn()} />, studio());
    expect(screen.getByRole('note').textContent).toContain('Repeating posts now come from Proven.');
    // The move is a confirm: an alertdialog whose body is described, not a form dialog.
    fireEvent.click(screen.getByRole('button', { name: 'Move my pipelines (3)' }));
    const dlg = document.querySelector('dialog.ui-dialog') as HTMLElement;
    expect(dlg.getAttribute('role')).toBe('alertdialog');
    expect(dlg.getAttribute('aria-describedby')).toBeTruthy();
  });
});
