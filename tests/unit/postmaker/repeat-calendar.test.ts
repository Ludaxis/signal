// Calendar repeat slots ("Repeat templates' slots appear as they do today for pipelines"):
// the open slots of Repeat templates, moved pipelines included, listed only while Post maker and the Repeat switch are
// on; a slot whose post was made (package mark under the old `pl-…` id) or started (slot ledger) is left out; campaign
// templates and templates with Repeat off are not listed; only future slots. Temp folders only; nothing runs.
import './guard';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PackageView } from '@/lib/studio/content';
import { currentProject, withProject } from '@/lib/studio/projects';
import { migratePipelines } from '@/lib/studio/postmaker/migrate/pipelines';
import { repeatSlotsIn } from '@/lib/studio/postmaker/repeat-calendar';
import { REPEAT_ENV } from '@/lib/studio/postmaker/repeat-state';
import { listTemplates } from '@/lib/studio/postmaker/store/templates';
import { NOW, root, setupAutopilotProject, teardownAutopilotProject } from '../autopilot-helpers';
import { P1, P2, writePipeline } from '../pipelines-helpers';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const ON = env({ SIGNAL_FEATURE_POSTMAKER: '1', [REPEAT_ENV]: '1' });
const P3 = 'pl-20261103-cccc';
const project = () => currentProject();
const slots = (pkgs: Partial<PackageView>[] = [], env = ON, from = '2026-11-05', to = '2026-11-08') => withProject(project(), () => repeatSlotsIn(project(), from, to, pkgs as PackageView[], NOW, env));

beforeEach(() => {
  setupAutopilotProject();
  process.env.SIGNAL_DATA_DIR = path.join(root, 'data');
  process.env.SIGNAL_SECRETS_DIR = path.join(root, 'secrets');
});
afterEach(() => {
  delete process.env.SIGNAL_DATA_DIR;
  delete process.env.SIGNAL_SECRETS_DIR;
  teardownAutopilotProject();
});

/** Thursday 5 Nov 2026, 08:30 Berlin (NOW). A daily 18:00 pipeline, one with Repeat off, one for a campaign. */
async function moved() {
  writePipeline(P1, { name: 'Daily', enabled: true, steps: { source: { kind: 'list', list: ['A', 'B'] }, make: { format: 'website-card' }, schedule: { perWeek: 14, days: [0, 1, 2, 3, 4, 5, 6], times: ['18:00'], makeAheadDays: 2 } } });
  writePipeline(P2, { name: 'Resting', enabled: false, steps: { source: { kind: 'list', list: ['A'] }, make: { format: 'website-card' } } });
  writePipeline(P3, { name: 'Campaign', enabled: true, steps: { source: { kind: 'campaign', campaign: 'c-20261101-aaaa' }, make: { format: 'website-card' } } });
  await migratePipelines(project(), { by: 'owner@example.test', now: NOW });
  return (await listTemplates(path.join(root, 'postmaker'))).find((t) => t.migratedFrom === P1)!;
}

describe('repeatSlotsIn', () => {
  it('lists nothing while Repeat (or Post maker) is off: moved pipelines pause until Repeat is on', async () => {
    await moved();
    expect(await slots([], env({}))).toEqual([]);
    expect(await slots([], env({ SIGNAL_FEATURE_POSTMAKER: '1' }))).toEqual([]);
  });

  it('lists the future open slots of templates with Repeat on and their own schedule', async () => {
    const t = await moved();
    const s = await slots();
    // 5…8 Nov at 18:00 Berlin (17:00 UTC); only the daily template (Repeat off and campaign templates are not listed).
    expect(s).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((d) => ({ template: t.id, name: 'Daily', at: `${d}T17:00:00.000Z` })));
    // Past days are never listed.
    expect(await slots([], ON, '2026-11-02', '2026-11-04')).toEqual([]);
  });

  it('leaves out a slot whose post was made under the old pipeline id, and one made for another time that day', async () => {
    const t = await moved();
    const made: Partial<PackageView>[] = [
      { id: '12', pipeline: { id: P1, name: 'Daily', slotAt: '2026-11-05T17:00:00.000Z', article: null } },
      { id: '13', pipeline: { id: t.id, name: 'Daily', slotAt: '2026-11-06T08:00:00.000Z', article: null } },
      { id: '14', pipeline: { id: 'pl-20261109-zzzz', name: 'Other', slotAt: '2026-11-07T17:00:00.000Z', article: null } },
    ];
    expect((await slots(made)).map((x) => x.at)).toEqual(['2026-11-07T17:00:00.000Z', '2026-11-08T17:00:00.000Z']);
  });
});
