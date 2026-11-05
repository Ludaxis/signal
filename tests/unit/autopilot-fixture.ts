// EXAMPLE DATA for local development only. Used by Autopilot.tsx when GET /api/studio/autopilot
// answers 404 (the route is not built yet). Everything here is marked "Example" in the UI and
// nothing is saved. The integrator deletes this file and the fallback in useAutopilot().
import type { AutopilotAction, AutopilotPayload, AutopilotRun, AutopilotSettings } from '@/lib/studio/autopilot/types';
import { addDays, zonedToUtc, todayInZone } from '@/lib/time';

const at = (date: string, time: string): string => {
  const r = zonedToUtc(date, time);
  return r.ok ? r.iso : new Date(`${date}T${time}:00Z`).toISOString();
};

function settings(campaign: string, over: Partial<AutopilotSettings> = {}): AutopilotSettings {
  return { campaign, enabled: false, makeAheadDays: 3, autoPlan: true, review: true, autoPublish: 'never', formats: null, dailyBudgetUsd: 3, updatedAt: at(todayInZone(), '07:40'), updatedBy: 'you', ...over };
}

export function demoAutopilotPayload(now = Date.now()): AutopilotPayload {
  const today = todayInZone(now);
  const d1 = addDays(today, -1);
  const d2 = addDays(today, -2);
  const tomorrow = addDays(today, 1);
  const runs: AutopilotRun[] = [
    {
      id: 'ap_example_3',
      project: 'example',
      day: today,
      trigger: 'manual',
      startedAt: at(today, '09:12'),
      endedAt: at(today, '09:16'),
      status: 'done',
      costUsd: 0.41,
      note: null,
      steps: [
        { kind: 'make', campaign: 'c_holiday', slot: `${tomorrow}-18:00`, package: '14', format: 'website-card', costUsd: 0.02 },
        { kind: 'review', package: '14', verdict: 'Looks good: clear hook, the AI label is on, nothing to fix.', costUsd: 0.05 },
        { kind: 'auto-approve', package: '14', format: 'website-card', scheduledFor: at(tomorrow, '18:00'), via: 'meta' },
        { kind: 'make', campaign: 'c_holiday', slot: `${addDays(today, 2)}-18:00`, package: '15', format: 'higgsfield-reel', costUsd: 0.09 },
        { kind: 'review', package: '15', verdict: 'Wait for you: the caption promises something the product does not have yet.', costUsd: 0.25 },
      ],
    },
    {
      id: 'ap_example_2',
      project: 'example',
      day: d1,
      trigger: 'daily',
      startedAt: at(d1, '08:00'),
      endedAt: at(d1, '08:21'),
      status: 'stopped',
      costUsd: 3.04,
      note: 'Stopped: the daily budget of $3.00 was reached.',
      steps: [
        { kind: 'plan', campaign: 'c_holiday', slots: 4, costUsd: 1.9 },
        { kind: 'make', campaign: 'c_holiday', slot: `${today}-18:00`, package: '13', format: 'codex-post', costUsd: 1.1 },
        { kind: 'review', package: '13', verdict: 'Looks good.', costUsd: 0.04 },
        { kind: 'skip', campaign: 'c_launch', reason: 'the daily budget of $3.00 is used up' },
      ],
    },
    {
      id: 'ap_example_1',
      project: 'example',
      day: d2,
      trigger: 'daily',
      startedAt: at(d2, '08:00'),
      endedAt: at(d2, '08:03'),
      status: 'done',
      costUsd: 0.07,
      note: null,
      steps: [
        { kind: 'skip', campaign: 'c_launch', reason: 'autopilot is off for this campaign' },
        { kind: 'make', campaign: 'c_holiday', slot: `${d1}-18:00`, package: '12', format: 'website-card', costUsd: 0.07 },
        { kind: 'review', package: '12', verdict: 'Looks good.', costUsd: null },
        { kind: 'make', campaign: 'c_holiday', slot: `${today}-18:00`, package: null, format: 'higgsfield-reel', costUsd: null, error: 'the video encoder ran out of memory' },
      ],
    },
  ];
  return {
    switches: {
      autopilot: { enabled: true, reason: '' },
      trustedPublish: { enabled: false, reason: 'Publishing without your approval needs the feature switch first.' },
      higgsfield: { enabled: false, reason: 'Higgsfield images are not approved for this account.' },
    },
    paused: { paused: false, reason: '' },
    schedule: { time: '08:00', timeZone: 'Europe/Amsterdam', window: '08:00–09:00', nextRunAt: at(tomorrow, '08:00'), schedulerRunning: true },
    campaigns: [
      { id: 'c_holiday', name: 'Holiday puzzles', status: 'active', formats: ['website-card', 'higgsfield-reel', 'codex-post', 'higgsfield-image'], settings: settings('c_holiday', { enabled: true, formats: ['website-card', 'higgsfield-reel', 'codex-post'] }) },
      { id: 'c_launch', name: 'Launch week', status: 'paused', formats: ['higgsfield-reel', 'codex-post'], settings: settings('c_launch') },
    ],
    trust: {
      version: 1,
      project: 'example',
      threshold: 5,
      updatedAt: at(today, '09:16'),
      formats: [
        { format: 'website-card', approvedInARow: 6, approvedTotal: 9, rejectedTotal: 1, lastDecisionAt: at(d1, '19:02'), trusted: true, revoked: false },
        { format: 'higgsfield-reel', approvedInARow: 2, approvedTotal: 4, rejectedTotal: 2, lastDecisionAt: at(d2, '20:15'), trusted: false, revoked: false },
        { format: 'codex-post', approvedInARow: 0, approvedTotal: 3, rejectedTotal: 1, lastDecisionAt: at(d1, '21:40'), trusted: false, revoked: false },
        { format: 'website-card', approvedInARow: 5, approvedTotal: 5, rejectedTotal: 0, lastDecisionAt: at(d2, '18:30'), trusted: false, revoked: true },
      ],
    },
    runs,
    spendToday: 0.41,
  };
}

// One shared example state so every screen sees the same thing while the route is missing.
let state: AutopilotPayload | null = null;
export function demoState(): AutopilotPayload {
  return (state ??= demoAutopilotPayload());
}

/** Applies an action to the example state in memory (nothing is saved anywhere). */
export function demoApply(action: AutopilotAction, now = Date.now()): AutopilotPayload {
  const p = demoState();
  const stamp = new Date(now).toISOString();
  if (action.action === 'settings') {
    const known = p.campaigns.some((c) => c.id === action.campaign);
    const campaigns = known
      ? p.campaigns.map((c) => (c.id === action.campaign ? { ...c, settings: { ...c.settings, ...action.patch, updatedAt: stamp, updatedBy: 'you' } } : c))
      : [...p.campaigns, { id: action.campaign, name: action.campaign, status: 'active', formats: [], settings: settings(action.campaign, { ...action.patch, updatedAt: stamp, updatedBy: 'you' }) }];
    state = { ...p, campaigns };
  } else if (action.action === 'trust') {
    state = {
      ...p,
      trust: { ...p.trust, updatedAt: stamp, formats: p.trust.formats.map((f) => (f.format === action.format ? { ...f, revoked: !action.trusted, trusted: action.trusted && f.approvedInARow >= p.trust.threshold } : f)) },
    };
  } else if (action.action === 'run-now') {
    if (p.runs[0]?.status === 'running') return p;
    const run: AutopilotRun = { id: `ap_example_${Date.now()}`, project: 'example', day: todayInZone(now), trigger: 'manual', startedAt: stamp, endedAt: null, status: 'running', steps: [], costUsd: 0, note: null };
    state = { ...p, runs: [run, ...p.runs].slice(0, 20) };
  } else if (action.action === 'pull') {
    state = { ...p, runs: p.runs.map((r) => ({ ...r, steps: r.steps.map((s) => (s.kind === 'auto-approve' && s.package === action.package ? { ...s, scheduledFor: null, error: 'you pulled this post' } : s)) })) };
  }
  return state ?? p;
}

/** Moves the example run one step forward on each poll, so the live view has something to show. */
export function demoAdvance(now = Date.now()): AutopilotPayload {
  const p = demoState();
  const run = p.runs[0];
  if (!run || run.status !== 'running') return p;
  const today = todayInZone(now);
  const script: AutopilotRun['steps'] = [
    { kind: 'make', campaign: 'c_holiday', slot: `${addDays(today, 3)}-18:00`, package: '16', format: 'website-card', costUsd: 0.02 },
    { kind: 'review', package: '16', verdict: 'Looks good: the label is on and the claims are true.', costUsd: 0.05 },
    { kind: 'auto-approve', package: '16', format: 'website-card', scheduledFor: at(addDays(today, 3), '18:00'), via: 'meta' },
    { kind: 'skip', campaign: 'c_launch', reason: 'autopilot is off for this campaign' },
  ];
  const n = run.steps.length;
  const next = script[n];
  const updated: AutopilotRun = next ? { ...run, steps: [...run.steps, next], costUsd: Math.round((run.costUsd + ('costUsd' in next && next.costUsd ? next.costUsd : 0)) * 100) / 100 } : { ...run, status: 'done', endedAt: new Date(now).toISOString() };
  state = { ...p, runs: [updated, ...p.runs.slice(1)], spendToday: Math.round((p.spendToday + (updated.costUsd - run.costUsd)) * 100) / 100 };
  return state;
}
