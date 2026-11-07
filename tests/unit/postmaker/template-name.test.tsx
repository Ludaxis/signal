// Ruling D-3: Accept asks for a template name (prefilled from the reference or the recipe's title line; required, at
// most 60 characters) instead of a silent default. The pure rule, the Dialog's disabled confirm and the server limit.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/app/studio/ui/Dialog';
import { t } from '@/app/studio/copy/en';
import { parseAction } from '@/lib/studio/postmaker/api/schemas';
import { TEMPLATE_NAME_MAX, clipName, suggestedTemplateName, templateNameOk } from '@/lib/studio/postmaker/template-name';
import type { Recipe, RecipeBeat } from '@/lib/studio/postmaker/types';

const beat = (o: Partial<RecipeBeat>): RecipeBeat => ({ id: 'b01', start: 0, end: 2, segment: 'hook', name: 'Hook', purpose: '', visual: '', techniques: [], onScreenText: {}, audio: '', motion: '', ...o });
const recipe = (beats: RecipeBeat[], languages: Recipe['languages'] = ['fa', 'en']) => ({ beats, languages });

describe('the suggested template name', () => {
  it("prefers a link reference's address, then the hook's on-screen words (English first), then the first beat's name", () => {
    const r = recipe([beat({ segment: 'story', id: 'b01', name: 'Setup' }), beat({ id: 'b02', onScreenText: { fa: 'فقط یک حرکت', en: 'One move left' } })]);
    expect(suggestedTemplateName(r, { url: 'https://www.example.com/videos/pov-story/' })).toBe('example.com/videos/pov-story');
    expect(suggestedTemplateName(r, { url: null })).toBe('One move left');
    expect(suggestedTemplateName(r, null)).toBe('One move left');
    expect(suggestedTemplateName(recipe([beat({ onScreenText: { fa: 'فقط یک حرکت' } })]), null)).toBe('فقط یک حرکت');
    expect(suggestedTemplateName(recipe([beat({ segment: 'story', name: 'Setup' })]), null)).toBe('Setup');
    expect(suggestedTemplateName(recipe([]), null)).toBe('');
  });

  it('never suggests more than 60 characters and cuts at a word', () => {
    const long = 'A very long hook line that keeps on going well past the sixty character limit';
    const s = suggestedTemplateName(recipe([beat({ onScreenText: { en: long } })]), null);
    expect(s.length).toBeLessThanOrEqual(TEMPLATE_NAME_MAX);
    expect(long.startsWith(s)).toBe(true);
    expect(long[s.length]).toBe(' ');
    expect(clipName('x'.repeat(80))).toHaveLength(60);
  });

  it('is required and at most 60 characters, on the screen and on the server', () => {
    expect(TEMPLATE_NAME_MAX).toBe(60);
    expect(templateNameOk('   ')).toBe(false);
    expect(templateNameOk('x'.repeat(60))).toBe(true);
    expect(templateNameOk('x'.repeat(61))).toBe(false);
    const base = { project: 'p', action: 'proof.accept', runId: 'run-20261106-100000-abcd', asDraft: true };
    expect(() => parseAction({ ...base, templateName: 'x'.repeat(60) })).not.toThrow();
    expect(() => parseAction({ ...base, templateName: 'x'.repeat(61) })).toThrow();
    expect(() => parseAction({ ...base, templateName: '  ' })).toThrow();
  });
});

describe('Dialog confirmDisabled', () => {
  it('disables the confirm with its one-line reason and ignores the click', () => {
    const onConfirm = vi.fn();
    const reason = t('pm.proof.nameNeeded', { max: TEMPLATE_NAME_MAX });
    expect(reason).toBe('Name the template, up to 60 characters.');
    render(<Dialog open role="dialog" title="Accept this proof?" confirmLabel="Accept" confirmDisabled={reason} onConfirm={onConfirm} onCancel={() => undefined} />);
    const btn = screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(reason);
  });
});
