// Strings that used to sit inline in the Studio screens live in copy/ now: partialText() and the move refusals in
// posts-rules.ts, the TaskProgress footer in loaders.tsx, AutopilotMarkView in Autopilot.tsx and the Campaigns
// make steps. The scan reads every source file under app/studio outside copy/ for the old literals.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/app/studio/copy/en';
import { partialText, planMove } from '@/app/studio/posts-rules';
import { MAKE_STEPS } from '@/app/studio/Campaigns';

const STUDIO = path.resolve(__dirname, '../../app/studio');
/** The listed strings (fragments that only the inline versions contained). */
export const MOVED = [
  'was approved`',
  'was cancelled`',
  'was updated`',
  "'not recorded as posted'",
  'moved on its own. The board was refreshed.',
  'is already posted. Take it down on Instagram.',
  'stays rejected. Make a new post.',
  'is sending. Check its status first.',
  'is approved. Reject it to stop it.',
  'failed. Open it to check its status.',
  'is scheduled. Unschedule it first.',
  'Taking longer than usual',
  'Usually about ${',
  'Made by autopilot',
  'Auto-approved (',
  'unless you pull it.',
  'Not scheduled yet: it will not go out until it is.',
  'Pull this post',
  'Pull post ${',
  'pulled. It will not be published.',
  'Approved automatically {',
  "'Reading the brief'",
  "'Choosing the content'",
  "'Adding headline and labels'",
  "'Adding text and answer'",
] as const;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === 'copy' ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('former inline strings are in copy/', () => {
  it('none of the listed strings appears in app/studio outside copy/', () => {
    const hits: string[] = [];
    for (const f of files(STUDIO)) {
      const src = readFileSync(f, 'utf8');
      for (const s of MOVED) if (src.includes(s)) hits.push(`${path.relative(STUDIO, f)}: ${s}`);
    }
    expect(hits).toEqual([]);
  });

  it('the dictionary holds them, and the rules still say the same words', () => {
    for (const k of ['posts.refuse.sending', 'posts.partial.withError', 'task.slow', 'task.usuallySeconds', 'autopilot.mark.badge', 'make.step.brief'] as const) expect(en[k]).toBeTruthy();
    expect(partialText('07', { action: 'approve' }, { action: 'posted', url: '', aiLabel: true }, '')).toBe('Post 07 was approved, but not recorded as posted.');
    const plan = planMove('posted', 'review', { id: '07', status: 'posted', plannedFor: null, scheduled: null }, { live: true, scheduling: true });
    expect(plan).toEqual({ kind: 'refuse', message: 'Post 07 is already posted. Take it down on Instagram.' });
    expect(MAKE_STEPS['codex-post']).toEqual(['Reading the brief', 'Codex is drawing the image', 'Adding headline and labels', 'Saving the post']);
  });
});
