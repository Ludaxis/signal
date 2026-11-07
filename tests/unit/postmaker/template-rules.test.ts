// @vitest-environment node
// Pure template rules (template-rules.ts): the per-variant streak, skip-proof, gatesInherited, Repeat, variant
// drafts, and the read-time migration of an older template file (no revision change).
import './guard';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAction } from '@/lib/studio/postmaker/api/schemas';
import { readTemplate, updateTemplate } from '@/lib/studio/postmaker/store/templates';
import { applyAcceptToTemplate, checkRepeat, checkVariantDraft, CORE_TEMPLATE_LIMITS, gatesInherited, gateHashesOf, retired, setSkipProof, templateSummary, withVariantDefaults } from '@/lib/studio/postmaker/template-rules';
import type { StepVersion, Template, TemplateVariant } from '@/lib/studio/postmaker/types';
import { tmp } from './guard';

const H = (c: string) => c.repeat(64);
const variant = (id: string, o: Partial<TemplateVariant> = {}): TemplateVariant => ({ id, label: id, params: { lengthSec: 60 }, status: 'draft', provenRunId: null, premiumStreak: 0, skipProofForRepeats: false, ...o });
const template = (o: Partial<Template> = {}): Template => ({
  schema: 'signal.pm.template/1',
  id: 'tpl-20261107-0e4c',
  name: 'Story spine',
  status: 'proven',
  recipeId: 'rc-20261107-0001',
  snapshot: { recipeVersion: 1, pipelineVersion: 1, heads: { script: { version: 1, hash: H('a'), locked: false }, 'narration-text:fa': { version: 2, hash: H('b'), locked: false }, 'voice:fa': { version: 1, hash: H('c'), locked: false }, 'narration-text:en': { version: 1, hash: H('d'), locked: false }, 'voice:en': { version: 1, hash: H('e'), locked: false } }, packId: null, packVersion: null },
  provenRunId: 'run-20261107-100000-aaaa',
  provenAt: '2026-11-07T10:00:00.000Z',
  provenBy: 'owner',
  builtIn: false,
  pack: null,
  campaignIds: [],
  inputs: { kind: 'brief', lockedNodes: [] },
  variants: [variant('var-000a'), variant('var-000b')],
  repeat: null,
  skipProofForRepeats: false,
  premiumStreak: 1,
  migratedFrom: null,
  revision: 3,
  ...o,
});
const outcome = { verdict: 'premium' as const, live: true, regenerations: 0, override: false, runId: 'run-20261107-110000-bbbb', at: '2026-11-07T11:00:00.000Z', by: 'owner', gateHashes: { 'voice:en': H('f') }, proveTemplate: true };

describe('the streak moves per template + variant', () => {
  it('a variant accept moves only that variant; the default variant is the template-level fields', () => {
    const t = template();
    const a = applyAcceptToTemplate(t, { ...outcome, variantId: 'var-000a' });
    expect(a.variants.map((v) => [v.id, v.premiumStreak, v.status])).toEqual([['var-000a', 1, 'proven'], ['var-000b', 0, 'draft']]);
    expect(a.variants[0]!.gateHashes).toEqual({ 'voice:en': H('f') });
    expect(a).toMatchObject({ premiumStreak: 1, provenRunId: t.provenRunId });
    const d = applyAcceptToTemplate(t, { ...outcome, variantId: null });
    expect(d).toMatchObject({ premiumStreak: 2, provenRunId: outcome.runId });
    expect(d.variants.map((v) => v.premiumStreak)).toEqual([0, 0]);
    // A post made from an already proven template does not move its proof.
    expect(applyAcceptToTemplate(t, { ...outcome, variantId: null, proveTemplate: false }).provenRunId).toBe(t.provenRunId);
  });

  it('Standard, not live, > 2 regenerations or an override reset to 0; skip-proof turns off below 3; nothing is demoted', () => {
    const on = template({ premiumStreak: 3, skipProofForRepeats: true, variants: [variant('var-000a', { status: 'proven', premiumStreak: 4, skipProofForRepeats: true })] });
    for (const o of [{ verdict: 'standard' as const }, { live: false }, { regenerations: 3 }, { override: true }]) {
      const d = applyAcceptToTemplate(on, { ...outcome, ...o, variantId: null });
      expect(d, JSON.stringify(o)).toMatchObject({ premiumStreak: 0, skipProofForRepeats: false, status: 'proven' });
      expect(d.variants[0]).toMatchObject({ premiumStreak: 4, skipProofForRepeats: true });
      const v = applyAcceptToTemplate(on, { ...outcome, ...o, variantId: 'var-000a' });
      expect(v.variants[0]).toMatchObject({ premiumStreak: 0, skipProofForRepeats: false, status: 'proven' });
      expect(v).toMatchObject({ premiumStreak: 3, skipProofForRepeats: true });
    }
    expect(applyAcceptToTemplate(on, { ...outcome, variantId: null })).toMatchObject({ premiumStreak: 4, skipProofForRepeats: true });
    expect(() => applyAcceptToTemplate(on, { ...outcome, variantId: 'var-dead' })).toThrow(/no longer/);
  });
});

describe('skip-proof', () => {
  it('refused below 3, allowed at 3, off always; retire clears every variant and Repeat', () => {
    expect(() => setSkipProof(template({ premiumStreak: 2 }), null, true)).toThrow('Skip proof unlocks after 3 Premium proofs in a row.');
    expect(setSkipProof(template({ premiumStreak: 3 }), null, true).skipProofForRepeats).toBe(true);
    expect(() => setSkipProof(template({ premiumStreak: 9 }), 'var-000a', true)).toThrow(/unlocks/);
    expect(setSkipProof(template({ variants: [variant('var-000a', { premiumStreak: 3 })] }), 'var-000a', true).variants[0]!.skipProofForRepeats).toBe(true);
    expect(setSkipProof(template({ premiumStreak: 0, skipProofForRepeats: true }), null, false).skipProofForRepeats).toBe(false);
    expect(() => setSkipProof(template(), 'var-dead', false)).toThrow('Unknown variant.');
    expect(() => setSkipProof(template({ status: 'retired', premiumStreak: 3 }), null, true)).toThrow('This template is retired.');
    const r = retired(template({ skipProofForRepeats: true, variants: [variant('var-000a', { skipProofForRepeats: true })], repeat: { enabled: true, perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 2, dailyUsd: 3, approve: 'ask' } }));
    expect(r).toMatchObject({ status: 'retired', skipProofForRepeats: false, variants: [{ skipProofForRepeats: false }], repeat: { enabled: false, perWeek: 3 } });
    expect(templateSummary(template({ premiumStreak: 3 }))).toMatchObject({ skipProofAllowed: true, variants: [{ skipProofAllowed: false }, { skipProofAllowed: false }] });
  });
});

describe('gatesInherited', () => {
  const v = (hash: string, from?: string): Pick<StepVersion, 'hash' | 'forkedFrom'> => ({ hash, ...(from ? { forkedFrom: { recipeId: 'rc-20261107-0001', nodeId: 'x', n: 1, hash: from } } : {}) });
  const fork = { 'narration-text:fa': v(H('1'), H('b')), 'voice:fa': v(H('2'), H('c')), script: v(H('3')) };
  it('true only when every narration-text and voice version is the template one', () => {
    const t = template();
    expect(gatesInherited(t, null, { current: fork, languages: ['fa'] })).toBe(true);
    expect(gatesInherited(t, null, { current: { ...fork, 'narration-text:fa': v(H('9')) }, languages: ['fa'] })).toBe(false); // narration text edited
    expect(gatesInherited(t, null, { current: { ...fork, 'voice:fa': v(H('9'), H('8')) }, languages: ['fa'] })).toBe(false); // voice forked from another
    expect(gatesInherited(t, null, { current: { ...fork, 'voice:fa': null }, languages: ['fa'] })).toBe(false);
    expect(gatesInherited(t, null, { current: { 'narration-text:fa': fork['narration-text:fa'] }, languages: ['fa'] })).toBe(false); // voice missing
    expect(gatesInherited(t, null, { current: { ...fork, script: v(H('7')) }, languages: ['fa'] })).toBe(true); // other steps do not matter
    expect(gatesInherited(t, null, { current: fork, languages: ['fa', 'en'] })).toBe(false); // the en lane is not there
  });
  it('a variant inherits from its own accepted proof, and nothing before it is proven', () => {
    const hashes = gateHashesOf({ 'narration-text:fa': v(H('5')), 'voice:fa': v(H('6'), H('c')), script: v(H('3')) });
    expect(hashes).toEqual({ 'narration-text:fa': H('5'), 'voice:fa': H('c') });
    const t = template({ variants: [variant('var-000a', { status: 'proven', gateHashes: hashes }), variant('var-000b')] });
    expect(gatesInherited(t, 'var-000a', { current: { 'narration-text:fa': v(H('x'), H('5')), 'voice:fa': v(H('y'), H('c')) }, languages: ['fa'] })).toBe(true);
    expect(gatesInherited(t, 'var-000a', { current: fork, languages: ['fa'] })).toBe(false);
    expect(gatesInherited(t, 'var-000b', { current: fork, languages: ['fa'] })).toBe(false);
    expect(gatesInherited(t, 'var-dead', { current: fork, languages: ['fa'] })).toBe(false);
  });
});

describe('Repeat and variant drafts', () => {
  it('Repeat is off unless asked; days and times come back sorted', () => {
    expect(checkRepeat({ perWeek: 3, days: [5, 1], times: ['18:00', '08:00'], makeAheadDays: 3, dailyUsd: 2.5, approve: 'trusted' })).toEqual({ enabled: false, perWeek: 3, days: [1, 5], times: ['08:00', '18:00'], makeAheadDays: 3, dailyUsd: 2.5, approve: 'trusted' });
    expect(() => checkRepeat({ perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 3, dailyUsd: 2.555, approve: 'ask' })).toThrow('The daily budget is in whole cents.');
    expect(() => checkRepeat({ perWeek: 3.5, days: [1], times: ['18:00'], makeAheadDays: 3, dailyUsd: 2, approve: 'ask' })).toThrow(/Posts a week/);
    expect(() => checkRepeat({ perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 3, dailyUsd: 19.999, approve: 'ask' })).toThrow('The daily budget is in whole cents.');
    for (const dailyUsd of [0.57, 1.1, 19.99]) expect(checkRepeat({ perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 3, dailyUsd, approve: 'ask' }).dailyUsd, String(dailyUsd)).toBe(dailyUsd);
  });
  it('every whole-cent budget from $0.50 to $20 is accepted (no float drift)', () => {
    const refused: number[] = [];
    for (let c = 50; c <= 2000; c++) {
      const dailyUsd = c / 100;
      try { checkRepeat({ perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 3, dailyUsd, approve: 'ask' }); } catch { refused.push(dailyUsd); }
    }
    expect(refused).toEqual([]);
  });
  it('a variant names only declared parameters the template can make', () => {
    const o = { limits: CORE_TEMPLATE_LIMITS, languages: ['fa' as const, 'en' as const] };
    expect(checkVariantDraft({ label: '  Long  ', params: { lengthSec: 90, lang: 'fa', dualCaptions: true } }, o)).toEqual({ label: 'Long', params: { lengthSec: 90, lang: 'fa', dualCaptions: true } });
    expect(() => checkVariantDraft({ label: 'x', params: { lengthSec: 91 } }, o)).toThrow('This template makes 30-90 s videos.');
    expect(() => checkVariantDraft({ label: 'x', params: { shape: '4:5' } }, o)).toThrow('This template makes 9:16 videos only.');
    expect(() => checkVariantDraft({ label: 'x', params: { hook: '   ' } }, o)).toThrow(/hook/);
    expect(() => checkVariantDraft({ label: '', params: { lengthSec: 60 } }, o)).toThrow(/name/);
    expect(() => checkVariantDraft({ label: 'x', params: { fps: 60 } as never }, o)).toThrow(/only the language/);
    expect(checkVariantDraft({ label: 'x', params: { shape: '4:5' } }, { ...o, limits: { ...CORE_TEMPLATE_LIMITS, canvases: ['9:16', '4:5'] } }).params).toEqual({ shape: '4:5' });
  });
});

describe('the action schemas of the new template actions', () => {
  it('parse; a client cannot send a variant status, a streak, an unknown key or a path-like id', () => {
    const T = 'tpl-20261107-0e4c';
    for (const a of [
      { action: 'template.make-post', templateId: T, brief: { topic: 'x' }, capUsd: 2 },
      { action: 'template.make-post', templateId: T, campaignSlot: { campaignId: 'c-20261107-ab12', slotId: 's-01' } },
      { action: 'template.variant.save', templateId: T, variant: { label: 'Long', params: { lengthSec: 60 } } },
      { action: 'template.repeat.set', templateId: T, repeat: { perWeek: 3, days: [1], times: ['18:00'], makeAheadDays: 3, dailyUsd: 3, approve: 'ask' } },
      { action: 'template.skip-proof.set', templateId: T, variantId: null, on: true },
      { action: 'template.campaign.attach', templateId: T, campaignId: 'c-20261107-ab12' },
      { action: 'template.campaign.detach', templateId: T, campaignId: 'c-20261107-ab12' },
      { action: 'template.duplicate', templateId: T },
    ]) expect(parseAction({ project: 'p', ...a }).action).toBe(a.action);
    const bad = (b: unknown) => expect(() => parseAction(b)).toThrow();
    bad({ action: 'template.make-post', templateId: T });
    bad({ action: 'template.variant.save', templateId: T, variant: { label: 'x', params: { lengthSec: 60 }, status: 'proven', provenRunId: null } });
    bad({ action: 'template.variant.save', templateId: T, variant: { label: 'x', params: { lengthSec: 60 }, premiumStreak: 3 } });
    bad({ action: 'template.variant.save', templateId: T, variant: { label: 'x', params: { fps: 60 } } });
    bad({ action: 'template.skip-proof.set', templateId: T, on: true });
    bad({ action: 'template.campaign.attach', templateId: T, campaignId: '../c' });
    bad({ action: 'template.duplicate', templateId: '../../etc' });
  });
});

describe('an older template file', () => {
  it('reads with streak 0 and skip-proof off on each variant, without changing its revision; the next write keeps them', async () => {
    const file = path.join(tmp.root, 'templates', 'tpl-20261107-0e4c.json');
    mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { ...template({ revision: 4 }), variants: [{ id: 'var-000a', label: '30 s', params: { lengthSec: 30 }, status: 'proven', provenRunId: 'run-20261107-100000-aaaa' }] };
    writeFileSync(file, JSON.stringify(legacy));
    const t = (await readTemplate(tmp.root, legacy.id))!;
    expect(t.revision).toBe(4);
    expect(t.variants[0]).toMatchObject({ status: 'proven', premiumStreak: 0, skipProofForRepeats: false });
    expect(withVariantDefaults(t)).toBe(t); // already normal: unchanged object
    const next = await updateTemplate(tmp.root, legacy.id, (x) => ({ ...x, name: 'Renamed' }));
    expect(next).toMatchObject({ revision: 5, variants: [{ premiumStreak: 0, skipProofForRepeats: false }] });
  });
});
