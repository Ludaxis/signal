// The Studio UI components: behaviour that screens rely on.
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { en, format, t } from '@/app/studio/copy/en';
import { ALL_STATUS_WORDS, Button, Card, CountBadge, Chip, Dialog, Drawer, FaText, Notice, Pill, Row, STATUS_TONE, STATUS_WORDS, Toast, isStatusWord, toConfirmRequest, useConfirm, useToast, type StatusWord } from '@/app/studio/ui';

const inStudio = () => {
  const host = document.createElement('div');
  host.className = 'studio';
  document.body.appendChild(host);
  return { container: host };
};

describe('Pill and the status dictionary', () => {
  it('shows the status word itself, with the tone of its meaning', () => {
    render(<Pill status="To approve" />);
    const pill = screen.getByText('To approve');
    expect(pill.className).toContain('pill');
    expect(pill.className).toContain('pill-needs-you');
    expect(pill.getAttribute('data-status')).toBe('To approve');
  });

  it('maps every dictionary word to exactly one tone, red only for things that broke', () => {
    expect(Object.keys(STATUS_TONE).sort()).toEqual([...ALL_STATUS_WORDS].sort());
    const failed = ALL_STATUS_WORDS.filter((w) => STATUS_TONE[w] === 'failed');
    expect(failed.sort()).toEqual(['Failed', 'Files changed']);
    for (const w of ['Off', 'Not set up', 'Mock', 'Locked', 'Not run'] as const) expect(STATUS_TONE[w]).toBe('neutral');
  });

  it('lists the dictionary words per object in lifecycle order', () => {
    expect(STATUS_WORDS.post).toEqual(['To approve', 'Approved', 'Scheduled', 'Sending', 'Posted', 'Check status', 'Failed', 'Rejected', 'Files changed']);
    expect(STATUS_WORDS.connection).toEqual(['Ready', 'Needs you', 'Off', 'Not set up']);
    expect(isStatusWord('Needs you')).toBe(true);
    expect(isStatusWord('Review')).toBe(false);
    expect(isStatusWord('Planned')).toBe(false);
  });

  it('rejects a word outside the dictionary at type level', () => {
    // @ts-expect-error "Review" is not a status word: the pill cannot show it.
    const bad: StatusWord = 'Review';
    // @ts-expect-error "Waiting" is not a status word.
    render(<Pill status="Waiting" />);
    expect(bad).toBe('Review');
  });
});

describe('CountBadge', () => {
  it('gives the nav item a spoken "n need you" without aria-label on a plain span', () => {
    render(
      <button type="button">
        Posts <CountBadge count={3} label={t('shell.postsBadge', { count: 3 })} />
      </button>,
    );
    const b = screen.getByRole('button', { name: 'Posts 3 need you' });
    const badge = b.querySelector('.count-badge')!;
    expect(badge.hasAttribute('aria-label')).toBe(false);
    expect(badge.querySelector('[aria-hidden="true"]')!.textContent).toBe('3');
    expect(badge.querySelector('.visually-hidden')!.textContent).toBe('3 need you');
  });

  it('renders nothing for zero', () => {
    const { container } = render(<CountBadge count={0} label="0 need you" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('Button', () => {
  it('renders the level as a class and shows the reason for a disabled button', () => {
    render(
      <Button level="primary" disabled reason="Add a caption first.">
        Approve
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Approve' });
    expect(b.className).toBe('btn btn-primary');
    expect(b.getAttribute('title')).toBe('Add a caption first.');
    expect(screen.getByText('Add a caption first.').id).toBe(b.getAttribute('aria-describedby'));
  });

  it('will not type-check a disabled button without a reason, and warns at run time if one slips through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const maybe = Math.random() > 2;
    render(
      <>
        {/* @ts-expect-error a disabled button needs a visible reason. */}
        <Button disabled>No reason</Button>
        {/* @ts-expect-error a button that may be disabled needs a reason too. */}
        <Button disabled={maybe}>Maybe</Button>
        <Button disabled={false}>Never disabled</Button>
        <Button disabled={maybe} reason="Add a caption first.">
          With reason
        </Button>
      </>,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/needs a visible reason/);
    warn.mockRestore();
  });

  it('marks a busy button with aria-busy and keeps its label', () => {
    render(
      <Button level="secondary" busy>
        Run 4 steps
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Run 4 steps' }).getAttribute('aria-busy')).toBe('true');
  });
});

describe('Chip, Card, Row', () => {
  it('a chip is a choice with aria-pressed', () => {
    render(<Chip selected>Posted</Chip>);
    expect(screen.getByRole('button', { name: 'Posted' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a card has a title, one meta line and a footer', () => {
    render(<Card title="Template A" meta="Updated Wed 18 Nov" footer={<Button>Open</Button>} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Template A' })).toBeTruthy();
    expect(screen.getByText('Updated Wed 18 Nov').className).toBe('card-meta');
  });

  it('a row holds one trailing action', () => {
    render(<Row title="Voice service" line="Needs a key" status={<Pill status="Needs you" />} action={<Button dense>Set up</Button>} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('Needs a key').className).toBe('row-line');
  });
});

describe('Dialog', () => {
  it('is a modal alertdialog titled with the question, Cancel plus the verb; focus starts on Cancel when destructive', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Dialog open title="Reject post 12?" body="It will not be posted." confirmLabel="Reject post" destructive onConfirm={onConfirm} onCancel={onCancel} />, inStudio());
    const d = screen.getByRole('alertdialog', { name: 'Reject post 12?' });
    expect(d.tagName).toBe('DIALOG');
    expect(d.hasAttribute('open')).toBe(true);
    expect(within(d).getByText('It will not be posted.')).toBeTruthy();
    const cancel = within(d).getByRole('button', { name: 'Cancel' });
    const reject = within(d).getByRole('button', { name: 'Reject post' });
    expect(reject.className).toContain('btn-danger');
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(reject);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('focuses the confirm for a non-destructive question; Escape cancels once', async () => {
    const onCancel = vi.fn();
    render(<Dialog open title="Schedule post 03?" confirmLabel="Schedule post" onConfirm={vi.fn()} onCancel={onCancel} />, inStudio());
    const d = screen.getByRole('alertdialog');
    await waitFor(() => expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Schedule post' })));
    fireEvent.keyDown(d, { key: 'Escape' });
    fireEvent(d, new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(<Dialog open={false} title="Remove template X?" confirmLabel="Remove template" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('splits a question string into title and consequence', () => {
    expect(toConfirmRequest('Reject post 12? It will not be posted.', 'Reject post')).toEqual({ title: 'Reject post 12?', body: 'It will not be posted.', confirmLabel: 'Reject post' });
    expect(toConfirmRequest('Send it now')).toEqual({ title: 'Send it now', body: undefined, confirmLabel: undefined });
  });

  it('useConfirm resolves true on the verb and false on Cancel', async () => {
    function Host({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
      const { confirm, node } = useConfirm();
      return (
        <>
          <button type="button" onClick={() => void confirm({ title: 'Remove profile “a”?', confirmLabel: 'Remove profile', destructive: true }).then(onAnswer)}>
            Remove
          </button>
          {node}
        </>
      );
    }
    const answers: boolean[] = [];
    render(<Host onAnswer={(ok) => answers.push(ok)} />, inStudio());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(answers).toEqual([false]));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove profile' }));
    await waitFor(() => expect(answers).toEqual([false, true]));
  });
});

describe('Drawer', () => {
  function Host({ dirty }: { dirty: boolean }) {
    const [open, setOpen] = useState(true);
    return (
      <Drawer open={open} title="Post 12" width="wide" dirty={dirty} onClose={() => setOpen(false)} primary={<Button level="primary">Save</Button>} secondary={<Button>Preview</Button>}>
        <p>Body</p>
      </Drawer>
    );
  }

  it('is a native dialog with a header, a Close button and a footer with one primary', () => {
    render(<Host dirty={false} />, inStudio());
    const d = screen.getByRole('dialog', { name: 'Post 12' });
    expect(d.tagName).toBe('DIALOG');
    expect(d.className).toContain('ui-drawer-wide');
    expect(d.querySelectorAll('.btn-primary')).toHaveLength(1);
    fireEvent.click(within(d).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Post 12' })).toBeNull();
  });

  it('asks "Discard changes?" before closing with unsaved edits', () => {
    render(<Host dirty />, inStudio());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const ask = screen.getByRole('alertdialog', { name: 'Discard changes?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Post 12' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog', { name: 'Post 12' })).toBeNull();
  });
});

describe('Toast', () => {
  it('shows for 3.8 s, or 8 s with Undo', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useToast());
      const view = render(<>{result.current.node}</>);
      act(() => result.current.say('Saved'));
      view.rerender(<>{result.current.node}</>);
      expect(screen.getByRole('status').textContent).toBe('Saved');
      act(() => vi.advanceTimersByTime(3900));
      view.rerender(<>{result.current.node}</>);
      expect(screen.queryByRole('status')).toBeNull();
      const undo = vi.fn();
      act(() => result.current.say('Approved', { onUndo: undo }));
      view.rerender(<>{result.current.node}</>);
      act(() => vi.advanceTimersByTime(5000));
      view.rerender(<>{result.current.node}</>);
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(undo).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing without a message', () => {
    render(<Toast message={null} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Notice: the five state patterns', () => {
  it('error: the plain line first, Try again, and the server message only behind Details', () => {
    const retry = vi.fn();
    render(<Notice kind="error" title="Templates could not load." details="connect ECONNREFUSED 127.0.0.1:3311" onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Templates could not load.')).toBeTruthy();
    const more = within(alert).getByText('connect ECONNREFUSED 127.0.0.1:3311');
    expect(more.hidden).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: 'Details' }));
    expect(more.hidden).toBe(false);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  it('empty, loading, success, and the three gated kinds', () => {
    const { rerender } = render(<Notice kind="empty" title="No templates yet." action={<Button level="primary">Make a post</Button>} />);
    expect(screen.getByText('No templates yet.')).toBeTruthy();
    rerender(<Notice kind="loading" title="Loading templates" />);
    expect(screen.getByRole('status', { name: 'Loading templates' }).getAttribute('aria-busy')).toBe('true');
    rerender(<Notice kind="success" title="Accepted. It's in Posts to approve." />);
    expect(screen.getByRole('status').textContent).toContain('Accepted.');
    rerender(<Notice kind="off" title="Voice service needs a key." action={<Button>Open Connections</Button>} />);
    expect(screen.getByRole('note').className).toContain('notice-off');
    rerender(<Notice kind="paused" title="Posting is paused for all projects." />);
    expect(screen.getByRole('note').className).toContain('notice-paused');
    rerender(<Notice kind="not-allowed" title="Real posting needs your written approval." why="It cannot be given inside the app." action={<Button>Ignored</Button>} />);
    const note = screen.getByRole('note');
    expect(within(note).queryByRole('button', { name: 'Ignored' })).toBeNull();
    expect(within(note).getByRole('button', { name: 'Why?' })).toBeTruthy();
  });
});

describe('FaText', () => {
  it('renders lang="fa" dir="rtl" with the Persian type step', () => {
    render(<FaText variant="lg">سلام</FaText>);
    const p = screen.getByText('سلام');
    expect(p.tagName).toBe('P');
    expect(p.getAttribute('lang')).toBe('fa');
    expect(p.getAttribute('dir')).toBe('rtl');
    expect(p.className).toBe('t-lg fa');
  });

  it('uses the display face only when asked', () => {
    render(
      <FaText as="h2" variant="h2" display>
        عنوان
      </FaText>,
    );
    expect(screen.getByRole('heading', { name: 'عنوان' }).className).toContain('fa-display');
  });
});

describe('copy/en.ts', () => {
  it('fills placeholders and plurals without concatenation', () => {
    expect(t('shell.postsBadge', { count: 3 })).toBe('3 need you');
    expect(t('shell.postsBadge', { count: 1 })).toBe('1 needs you');
    expect(t('notice.couldNotLoad', { thing: 'Templates' })).toBe('Templates could not load.');
    expect(format('{n, plural, one {# step} other {# steps}}', { n: 1 })).toBe('1 step');
    expect(format('Run {n, plural, one {# step} other {# steps}}', { n: 4 })).toBe('Run 4 steps');
    expect(format('{n, plural, =0 {No steps} other {# steps}}', { n: 0 })).toBe('No steps');
    expect(() => format('{thing} could not load.')).toThrow(/Missing value/);
  });

  it('follows the microcopy rules: no Yes/OK/Submit, no exclamation marks, no banned words', () => {
    const BANNED = /\b(package|SHA|fingerprint|runbook|rev|gate|Probabilities|Judge|legacy)\b|\.env|Request failed/i;
    for (const [key, value] of Object.entries(en)) {
      expect(value, key).not.toMatch(/^(Yes|No|OK|Submit)$/);
      expect(value, key).not.toContain('!');
      expect(value, key).not.toMatch(BANNED);
    }
    expect(en['shell.makePost']).toBe('Make a post');
  });
});
