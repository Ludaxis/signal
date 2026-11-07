// @vitest-environment node
// A dropped SFX cue is a warning StepCheck on the mix (`required: false`) and the run's event stream
// carries it as a `check` event with the cue evidence. Fakes only; network guard on.
import { describe, expect, it } from 'vitest';
import { defaultExecutors } from '@/lib/studio/postmaker/executors';
import { newCounters } from '@/lib/studio/postmaker/executors/fakes';
import type { Executor } from '@/lib/studio/postmaker/executors/types';
import { readEvents } from '@/lib/studio/postmaker/store/runs';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';

describe('a runner event for a dropped SFX cue', () => {
  it('the mix warning becomes a check event naming the cue; other warnings do not', async () => {
    const fakes = { counters: newCounters() };
    const base = defaultExecutors({ fakes });
    const mix: Executor = {
      ...base.mix,
      run: async (i) => {
        const r = await base.mix.run(i);
        return { ...r, checks: [...(r.checks ?? []), { id: `mix:${i.lang}:sfx-dropped`, ok: false, required: false, text: 'Dropped 1 SFX cue with no sound in the library: clap', evidence: 'clap@454' }, { id: `mix:${i.lang}:other`, ok: false, required: false, text: 'another note' }] };
      },
    };
    const s = await setup({ langs: ['en'], deps: { executors: { ...base, mix } } });
    const run = await runAll(s.engine, s.recipeId);
    const events = (await readEvents(tmp.root, run.id)).events.filter((e) => e.kind === 'check');
    expect(events).toEqual([expect.objectContaining({ kind: 'check', nodeId: 'mix:en', text: 'Dropped 1 SFX cue with no sound in the library: clap', data: { id: 'mix:en:sfx-dropped', warning: true, evidence: 'clap@454' } })]);
  });
});
