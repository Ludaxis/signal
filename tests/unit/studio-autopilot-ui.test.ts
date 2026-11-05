import { describe, expect, it } from 'vitest';
import { describeStep } from '@/app/studio/Autopilot';
import { demoAutopilotPayload } from './autopilot-fixture';

const name = (id: string | null) => (id === 'c1' ? 'Holiday puzzles' : id ?? 'a campaign');

describe('Autopilot UI: run steps in plain words', () => {
  it('describes every kind of step without jargon', () => {
    expect(describeStep({ kind: 'plan', campaign: 'c1', slots: 4, costUsd: 1.9 }, name)).toBe('Planned 4 more posts for Holiday puzzles ($1.90).');
    expect(describeStep({ kind: 'make', campaign: 'c1', slot: '2026-11-07-18:00', package: '14', format: 'website-card', costUsd: 0.02 }, name)).toBe('Made post 14 (Website post) for Sat 7 Nov, 18:00, Holiday puzzles ($0.02).');
    expect(describeStep({ kind: 'make', campaign: 'c1', slot: 's9', package: null, format: 'higgsfield-reel', costUsd: null, error: 'the encoder failed' }, name)).toMatch(/^Could not make the higgsfield reel for s9 \(Holiday puzzles\): the encoder failed\./);
    expect(describeStep({ kind: 'review', package: '14', verdict: 'Looks good.', costUsd: null }, name)).toBe('The reviewer looked at post 14: Looks good.');
    expect(describeStep({ kind: 'auto-approve', package: '14', format: 'website-card', scheduledFor: '2026-11-07T17:00:00.000Z', via: 'meta' }, name)).toBe('Approved post 14 automatically (Website post is trusted) and scheduled it for Sat 7 Nov, 18:00 via Instagram.');
    expect(describeStep({ kind: 'skip', campaign: null, reason: 'the daily budget is used up' }, name)).toBe('Skipped the run because the daily budget is used up.');
  });

  it('ships an example payload that matches the contract shape', () => {
    const p = demoAutopilotPayload(Date.parse('2026-11-05T10:00:00Z'));
    expect(p.campaigns).toHaveLength(2);
    expect(p.trust.formats).toHaveLength(4);
    expect(p.trust.formats.filter((f) => f.trusted)).toHaveLength(1);
    expect(p.runs).toHaveLength(3);
    expect(p.runs.some((r) => r.steps.some((s) => s.kind === 'auto-approve'))).toBe(true);
    expect(p.runs.some((r) => r.status === 'stopped' && /budget/.test(r.note ?? ''))).toBe(true);
    expect(p.runs[0]!.day).toBe('2026-11-05');
  });
});
