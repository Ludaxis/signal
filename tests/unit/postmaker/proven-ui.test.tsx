// Proven components in jsdom: the template card on Home (one Make a post,
// a link to the screen), the Proven screen's one primary, the skip-proof switches locked with their reason until the
// variant's streak reaches 3, the Repeat switch off and locked until Autopilot and Repeat are on in Connections, the field
// errors of the Repeat drawer, and the 15 s chip disabled with its reason. Fetches are stubbed.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import type { PostmakerHome } from '@/app/studio/postmaker/api';
import { Home } from '@/app/studio/postmaker/Home';
import { Proven, RepeatDrawer } from '@/app/studio/postmaker/Proven';
import type { TemplateSummary } from '@/lib/studio/postmaker/types';

const TPL = 'tpl-20261107-ab12';
const summary = (o: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: TPL,
  name: 'Story spine',
  status: 'proven',
  recipeId: 'rc-20261107-ab12',
  provenRunId: 'run-20261107-100000-abcd',
  premiumStreak: 1,
  skipProofForRepeats: false,
  skipProofAllowed: false,
  campaignIds: [],
  revision: 2,
  variants: [{ id: 'var-0a0b', label: 'Thirty', params: { lengthSec: 30 }, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false, skipProofAllowed: false }],
  repeat: null,
  ...o,
});
const data = (x: TemplateSummary): PostmakerHome => ({
  recipes: [],
  templates: [x],
  templateCards: { [x.id]: { steps: 12, usd: 4.7, seconds: 540, lastRunAt: '2026-11-07T09:00:00Z', languages: ['en'], lengthSec: 45, shape: '9:16', cover: null } },
  runs: [],
  connectors: [],
  paused: false,
  timeZone: 'Europe/Berlin',
});
const studio = () => {
  const host = document.createElement('div');
  host.className = 'studio';
  document.body.appendChild(host);
  return { container: host };
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/campaigns') ? { campaigns: [{ id: 'c-20261101-aaaa', name: 'Autumn series', status: 'active' }], plans: {} } : url.includes('/results') ? { byTemplate: [] } : { switches: { autopilot: { enabled: false }, repeat: { enabled: false }, trustedPublish: { enabled: false } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Home › Proven template card', () => {
  it('cover, name link, pills, steps · ~$ · ~min and one secondary Make a post; the name opens the screen', () => {
    const go = vi.fn();
    const { container } = render(<Home pid="example" data={data(summary({ repeat: { enabled: true, perWeek: 3, days: [0], times: ['18:00'], makeAheadDays: 3, dailyUsd: 2, approve: 'ask' } }))} view="proven" runId={null} go={go} say={() => undefined} reload={() => undefined} />, studio());
    const card = container.querySelector(`.pm-tcard[data-template="${TPL}"]`) as HTMLElement;
    expect(card.textContent).toContain('12 steps · ~$4.70 · ~9 min');
    expect(within(card).getAllByText(/^(Proven|Repeats)$/).map((e) => e.textContent)).toEqual(['Proven', 'Repeats']);
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Story spine', 'Make a post']);
    expect(buttons[1]!.className).not.toMatch(/btn-primary/);
    expect(card.textContent!.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(40);
    fireEvent.click(within(card).getByRole('button', { name: 'Open Story spine' }));
    expect(go).toHaveBeenCalledWith({ t: TPL });
    fireEvent.click(buttons[1]!);
    expect(screen.getByRole('dialog', { name: 'Make a post from Story spine?' })).toBeTruthy();
  });
});

describe('Proven screen', () => {
  it('one primary Make a post; variants with Run proof on drafts; Repeat Off; a retired template cannot make a post', async () => {
    const { container, unmount } = render(<Proven pid="example" data={data(summary())} templateId={TPL} go={vi.fn()} say={vi.fn()} reload={vi.fn()} onMade={vi.fn()} />, studio());
    await act(async () => undefined);
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Make a post' }).className).toMatch(/btn-primary/);
    expect(container.querySelector('[data-variant="var-0a0b"]')!.textContent).toContain('English · 30 s · 9:16');
    expect(within(container.querySelector('[data-variant="var-0a0b"]') as HTMLElement).getByRole('button', { name: 'Run proof' })).toBeTruthy();
    expect(screen.getByTestId('pm-repeat-line').textContent).toBe('Off');
    unmount();
    render(<Proven pid="example" data={data(summary({ status: 'retired' }))} templateId={TPL} go={vi.fn()} say={vi.fn()} reload={vi.fn()} onMade={vi.fn()} />, studio());
    await act(async () => undefined);
    const make = screen.getByRole('button', { name: 'Make a post' }) as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    expect(make.title).toBe('This template is retired.');
  });

  it('an unknown template is the error pattern with Try again', () => {
    render(<Proven pid="example" data={data(summary())} templateId="tpl-20261107-ffff" go={vi.fn()} say={vi.fn()} reload={vi.fn()} onMade={vi.fn()} />, studio());
    expect(screen.getByRole('alert').textContent).toContain('The template could not load.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('Add variant offers 15 s disabled with its reason', async () => {
    render(<Proven pid="example" data={data(summary())} templateId={TPL} go={vi.fn()} say={vi.fn()} reload={vi.fn()} onMade={vi.fn()} />, studio());
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Add variant' }));
    const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
    const chip = within(drawer).getByRole('button', { name: '15 s' }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.title).toBe('This template makes 30 to 90 s.');
    expect(drawer.textContent).toContain('This template makes 30 to 90 s.');
    expect(drawer.querySelectorAll('.btn-primary')).toHaveLength(1);
  });
});

describe('Repeat drawer', () => {
  const skipSwitch = (label: string) => within(screen.getByTestId('pm-skip-proof')).getByRole('switch', { name: label }) as HTMLButtonElement;
  for (const streak of [0, 1, 2]) {
    it(`at streak ${streak} skip-proof is disabled with "Needs 3 Premium proofs in a row"`, () => {
      render(<RepeatDrawer pid="example" template={summary({ premiumStreak: streak })} automation={{ repeat: false, trusted: false }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
      const sw = skipSwitch('Original');
      expect(sw.disabled).toBe(true);
      expect(sw.title).toBe('Needs 3 Premium proofs in a row');
      expect(sw.getAttribute('aria-checked')).toBe('false');
    });
  }
  it('at streak 3 the switch is enabled (per variant: the draft variant stays locked)', () => {
    render(<RepeatDrawer pid="example" template={summary({ premiumStreak: 3, skipProofAllowed: true })} automation={{ repeat: false, trusted: false }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    expect(skipSwitch('Original').disabled).toBe(false);
    expect(skipSwitch('Original').getAttribute('aria-checked')).toBe('false');
    expect(skipSwitch('Thirty').disabled).toBe(true);
  });
  it('the Repeat switch is off by default and locked with the note until Autopilot and Repeat are on', () => {
    const { unmount } = render(<RepeatDrawer pid="example" template={summary()} automation={{ repeat: false, trusted: false }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    const sw = screen.getByRole('switch', { name: 'Repeat this template' }) as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.disabled).toBe(true);
    expect(sw.title).toBe('Turn on Autopilot and Repeat in Connections first.');
    expect(screen.getByRole('note').textContent).toContain('Repeat is off in Connections.');
    expect((screen.getByRole('radio', { name: 'Post by itself after 5 approvals in a row' }) as HTMLInputElement).disabled).toBe(true);
    unmount();
    render(<RepeatDrawer pid="example" template={summary()} automation={{ repeat: true, trusted: true }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    expect((screen.getByRole('switch', { name: 'Repeat this template' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('a Draft template cannot repeat: "Prove this template first."', () => {
    render(<RepeatDrawer pid="example" template={summary({ status: 'draft' })} automation={{ repeat: true, trusted: true }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    expect((screen.getByRole('switch', { name: 'Repeat this template' }) as HTMLButtonElement).title).toBe('Prove this template first.');
  });
  it('invalid ranges show field errors and Save is disabled with its reason', () => {
    render(<RepeatDrawer pid="example" template={summary()} automation={{ repeat: false, trusted: false }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    fireEvent.change(screen.getByLabelText('Posts a week'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Daily budget, in dollars'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Time 1'), { target: { value: '7pm' } });
    fireEvent.blur(screen.getByLabelText('Posts a week'));
    const alerts = screen.getAllByRole('alert').map((a) => a.textContent);
    expect(alerts).toEqual(expect.arrayContaining(['Use 1 to 14.', 'Use $0.50 to $20.', 'Use HH:MM, for example 18:00.']));
    expect(screen.getByLabelText('Posts a week').getAttribute('aria-invalid')).toBe('true');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Fix the marked fields.');
  });
});

// ---- Review fixes (after review) -------------------------------------------------------------------------------

type Call = { url: string; body: Record<string, unknown> | null };
const SLOT_AT = new Date(Date.now() + 3 * 86_400_000).toISOString();
/** fetch with a campaign that has a future planned slot for TPL, a By template row, and every POST recorded. */
function stubFetch(o: { campaigns?: { id: string; name: string; status: string }[]; avgViews?: number } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      const body = url.includes('/campaigns')
        ? { campaigns: o.campaigns ?? [{ id: 'c-20261101-aaaa', name: 'Autumn series', status: 'active' }], plans: { 'c-20261101-aaaa': { slots: [{ id: 's1', at: SLOT_AT, status: 'planned', templateId: TPL, angle: 'Three calm habits' }] } } }
        : url.includes('/results')
          ? { byTemplate: o.avgViews != null ? [{ key: `template:${TPL}`, posts: 2, avgViews: o.avgViews }] : [] }
          : init?.method === 'POST'
            ? { runId: 'run-20261107-120000-abcd', recipeId: 'rc-20261107-cd34' }
            : { switches: { autopilot: { enabled: false }, repeat: { enabled: false }, trustedPublish: { enabled: false } } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}
const renderProven = (x: TemplateSummary) => render(<Proven pid="example" data={data(x)} templateId={TPL} go={vi.fn()} say={vi.fn()} reload={vi.fn()} onMade={vi.fn()} />, studio());

describe('review fixes', () => {
  it('a campaign that is gone shows "Campaign no longer here", never its id; the value stays the id for Detach', async () => {
    stubFetch({ campaigns: [] });
    const { container } = renderProven(summary({ campaignIds: ['c-20261107-dead'] }));
    await act(async () => undefined);
    const select = screen.getByRole('combobox', { name: 'Campaign' }) as HTMLSelectElement;
    expect(select.value).toBe('c-20261107-dead');
    expect(select.selectedOptions[0]!.textContent).toBe('Campaign no longer here');
    expect(container.textContent).not.toContain('c-20261107-dead');
    expect(screen.getByRole('button', { name: 'Detach' })).toBeTruthy();
  });

  it('average views use the Results number format (9,500, not 9500)', async () => {
    stubFetch({ avgViews: 9500 });
    const { container } = renderProven(summary());
    await act(async () => undefined);
    expect(container.textContent).toContain('2 posts · 9,500 avg views');
  });

  it('Make a post opens with focus in the topic field (its confirm starts disabled)', async () => {
    stubFetch();
    renderProven(summary());
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Make a post' }));
    await act(async () => undefined);
    const d = screen.getByRole('dialog', { name: 'Make a post from Story spine?' });
    expect((within(d).getByRole('button', { name: 'Make a post' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(within(d).getByRole('textbox', { name: 'Topic or brief' }));
  });

  it('a template attached to a campaign fills its next slot by default; unticking the slot makes a one-off post', async () => {
    for (const keep of [true, false]) {
      const calls = stubFetch();
      const { unmount } = renderProven(summary({ campaignIds: ['c-20261101-aaaa'] }));
      await act(async () => undefined);
      fireEvent.click(screen.getByRole('button', { name: 'Make a post' }));
      await act(async () => undefined);
      const d = screen.getByRole('dialog', { name: 'Make a post from Story spine?' });
      expect((within(d).getByRole('textbox', { name: 'Topic or brief' }) as HTMLTextAreaElement).value).toBe('Three calm habits');
      const box = within(d).getByRole('checkbox', { name: /^For Autumn series · / }) as HTMLInputElement;
      expect(box.checked).toBe(true);
      if (!keep) fireEvent.click(box);
      await act(async () => {
        fireEvent.click(within(d).getByRole('button', { name: 'Make a post' }));
      });
      const post = calls.find((c) => c.body?.action === 'template.make-post')!;
      expect(post.body).toMatchObject({ templateId: TPL, brief: { topic: 'Three calm habits' } });
      if (keep) expect(post.body!.campaignSlot).toEqual({ campaignId: 'c-20261101-aaaa', slotId: 's1' });
      else expect(post.body).not.toHaveProperty('campaignSlot');
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it('Home › Proven hides retired templates under a "Retired (n)" filter', () => {
    const live = summary();
    const old = summary({ id: 'tpl-20261107-old1', name: 'Old spine', status: 'retired' });
    const both: PostmakerHome = { ...data(live), templates: [live, old] };
    const { container, unmount } = render(<Home pid="example" data={both} view="proven" runId={null} go={vi.fn()} say={() => undefined} reload={() => undefined} />, studio());
    const names = () => Array.from(container.querySelectorAll('.pm-tcard')).map((c) => c.getAttribute('data-template'));
    expect(names()).toEqual([TPL]);
    const chip = screen.getByRole('button', { name: 'Retired (1)' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(names()).toEqual(['tpl-20261107-old1']);
    expect(screen.getByRole('button', { name: 'Retired (1)' }).getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('.btn-primary')).toHaveLength(1);
    unmount();
    // Every template retired: the empty notice says so and carries the one Make a post.
    const { container: c2 } = render(<Home pid="example" data={{ ...data(old), templates: [old] }} view="proven" runId={null} go={vi.fn()} say={() => undefined} reload={() => undefined} />, studio());
    expect(c2.textContent).toContain('Every template is retired.');
    expect(c2.querySelectorAll('.pm-tcard')).toHaveLength(0);
    expect(c2.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('the Repeat drawer states the approval gate once (the notice); the switch and "Post by itself" point at it', () => {
    const { unmount } = render(<RepeatDrawer pid="example" template={summary()} automation={{ repeat: false, trusted: false }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    const drawer = document.querySelector('dialog.ui-drawer') as HTMLElement;
    expect(drawer.textContent!.split('Repeat is off in Connections').length - 1).toBe(1);
    const sw = screen.getByRole('switch', { name: 'Repeat this template' });
    const gate = document.getElementById(sw.getAttribute('aria-describedby')!)!;
    expect(gate.textContent).toContain('Repeat is off in Connections.');
    expect(screen.getByRole('radio', { name: 'Post by itself after 5 approvals in a row' }).getAttribute('aria-describedby')).toBe(gate.id);
    unmount();
    // Repeat on but trusted posting off: that one option shows its own reason.
    render(<RepeatDrawer pid="example" template={summary()} automation={{ repeat: true, trusted: false }} onClose={vi.fn()} onSaved={vi.fn()} />, studio());
    const radio = screen.getByRole('radio', { name: 'Post by itself after 5 approvals in a row' }) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(document.getElementById(radio.getAttribute('aria-describedby')!)!.textContent).toBe('Turn on trusted posting in Connections first.');
  });
});
