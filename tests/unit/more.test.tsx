// The Studio's "More" disclosure: an accessible button that shows and hides details.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { More } from '@/app/studio/More';
import { firstSentence } from '@/app/studio/Campaigns';

describe('More', () => {
  it('is closed by default, wires aria-expanded and aria-controls, and toggles', () => {
    const onToggle = vi.fn();
    render(
      <More label="Why?" onToggle={onToggle}>
        <span>Because the key is missing.</span>
      </More>,
    );
    const btn = screen.getByRole('button', { name: 'Why?' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(panel).toBeTruthy();
    expect(panel.hidden).toBe(true);
    expect(screen.queryByText('Because the key is missing.')).toBeTruthy(); // in the DOM, hidden
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide' })).toBe(btn);
    expect(onToggle).toHaveBeenCalledWith(true);
    fireEvent.click(btn);
    expect(panel.hidden).toBe(true);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('turns "Show …" into "Hide …", honours openLabel and defaultOpen', () => {
    const { unmount } = render(
      <More label="Show strategy" defaultOpen>
        <span>Pillars</span>
      </More>,
    );
    expect(screen.getByRole('button', { name: 'Hide strategy' }).getAttribute('aria-expanded')).toBe('true');
    unmount();
    render(
      <More label="Show all 8" openLabel="Show fewer" tone="button">
        <span>more slots</span>
      </More>,
    );
    const btn = screen.getByRole('button', { name: 'Show all 8' });
    expect(btn.className).toContain('st-btn');
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeTruthy();
  });
});

describe('strategy one-liner', () => {
  it('keeps the first sentence and caps its length', () => {
    expect(firstSentence('Post puzzles daily. Lean on reels for reach.')).toBe('Post puzzles daily.');
    expect(firstSentence('Is this a question? Yes.')).toBe('Is this a question?');
    expect(firstSentence('no punctuation at all')).toBe('no punctuation at all');
    const long = `${'a'.repeat(200)}. tail`;
    expect(firstSentence(long).length).toBe(158);
    expect(firstSentence(long).endsWith('…')).toBe(true);
  });
});
