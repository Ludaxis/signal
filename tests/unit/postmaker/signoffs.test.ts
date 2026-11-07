// @vitest-environment node
// sign-off storage: records live outside the write-once step versions,
// reach the engine through deps.signoffs, are bound to one exact version hash, and are never made by an agent or mock.
import './guard';
import { appendFileSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPostmakerError } from '@/lib/studio/postmaker/errors';
import { isAgentIdentity, readSignOffs, recordSignOff, signoffsDep } from '@/lib/studio/postmaker/signoffs';
import { signoffsFile } from '@/lib/studio/postmaker/store/paths';
import { readVersion } from '@/lib/studio/postmaker/store/versions';
import { runAll, setup } from './engine-fixtures';
import { tmp } from './guard';

const RID = 'rc-20261106-0001';
const sign = (o: Partial<Parameters<typeof recordSignOff>[1]> = {}) => recordSignOff(tmp.root, { recipeId: RID, nodeId: 'narration-text:fa', version: 1, gate: 'fa-native-editor', name: 'Editor A', verdict: 'pass', by: 'editor@example.test', ...o });

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(isPostmakerError(e), String(e)).toBe(true);
    const x = e as { status: number; code: string; message: string };
    return { status: x.status, code: x.code, message: x.message };
  }
  throw new Error('expected a refusal');
}

describe('agent identities', () => {
  it('names agents, workers, mock and Signal itself; people pass', () => {
    for (const v of ['mock', 'MOCK', 'reviewer', 'qa-agent', 'language-editor', 'agent:copywriter', 'worker-7', 'signal-postmaker', 'claude', 'codex:exec', 'helper-bot', 'x@agents.example', '  ']) expect(isAgentIdentity(v), v).toBe(true);
    for (const v of ['Editor A', 'owner@example.test', 'Reader B', 'someone']) expect(isAgentIdentity(v), v).toBe(false);
  });
});

describe('recordSignOff', () => {
  it('signs the current version, bound to its hash, outside the version file; the engine then reports the gate signed', async () => {
    const { engine, recipeId } = await setup({ deps: { signoffs: signoffsDep(tmp.root) } });
    await runAll(engine, recipeId);
    const before = (await readVersion(tmp.root, RID, 'narration-text:fa', 1))!;
    expect((await engine.status(recipeId))['narration-text:fa']!.gate).toMatchObject({ signed: false, mock: true });
    const { signoff } = await sign({ perLine: [{ lineId: 'l01', ok: true }] });
    expect(signoff).toMatchObject({ gate: 'fa-native-editor', nodeId: 'narration-text:fa', version: 1, hash: before.hash, by: 'editor@example.test', name: 'Editor A', verdict: 'pass', perLine: [{ lineId: 'l01', ok: true }] });
    // The write-once version file is untouched; the record is a line in signoffs.jsonl.
    expect(await readVersion(tmp.root, RID, 'narration-text:fa', 1)).toEqual(before);
    expect(readFileSync(signoffsFile(tmp.root, RID), 'utf8').trim().split('\n')).toHaveLength(1);
    expect((await engine.status(recipeId))['narration-text:fa']!.gate).toMatchObject({ signed: true, mock: false });
    // A later fail by a person wins (the last record decides).
    await sign({ verdict: 'fail', perLine: [{ lineId: 'l01', ok: false, note: 'ezafe' }] });
    expect((await engine.status(recipeId))['narration-text:fa']!.gate!.signed).toBe(false);
  });

  it('an edit makes a new version that needs its own sign-off (the old record stays bound to v1)', async () => {
    const { engine, recipeId } = await setup({ langs: ['fa'], deps: { signoffs: signoffsDep(tmp.root) } });
    await runAll(engine, recipeId);
    await sign();
    expect((await engine.status(recipeId))['narration-text:fa']!.gate!.signed).toBe(true);
    const v1 = (await readVersion(tmp.root, RID, 'narration-text:fa', 1))!;
    const { getJson } = await import('@/lib/studio/postmaker/store/objects');
    const lines = await getJson<Record<string, unknown>>(tmp.root, v1.outputs[0]!.sha256);
    await engine.edit({ recipeId, nodeId: 'narration-text:fa', baseVersion: 1, output: { json: { lines: { ...lines, editedNote: 'x' } } }, by: 'editor@example.test' });
    expect((await engine.status(recipeId))['narration-text:fa']!.gate!.signed).toBe(false);
    expect(await refusal(sign({ version: 1 }))).toMatchObject({ status: 409, message: 'Changed since you opened it' });
    await sign({ version: 2 });
    expect((await engine.status(recipeId))['narration-text:fa']!.gate!.signed).toBe(true);
  });

  it('refuses mock and agent signers and names, the proof gate, a step without that gate, unknown lines and a pass with a wrong line', async () => {
    const { engine, recipeId } = await setup({ deps: { signoffs: signoffsDep(tmp.root) } });
    await runAll(engine, recipeId);
    expect(await refusal(sign({ name: 'mock' }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ name: 'language-editor' }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ name: 'x' }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ by: 'agent:reviewer' }))).toMatchObject({ status: 403 });
    expect(await refusal(sign({ by: 'mock' }))).toMatchObject({ status: 403 });
    expect(await refusal(sign({ nodeId: 'check', gate: 'proof' }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ nodeId: 'script', gate: 'fa-native-editor' }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ gate: 'fa-native-listener' }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ perLine: [{ lineId: 'l99', ok: true }] }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ perLine: [{ lineId: 'l01', ok: false }] }))).toMatchObject({ status: 400 });
    expect(await refusal(sign({ nodeId: 'voice:xx' }))).toMatchObject({ status: 404 });
    expect(await readSignOffs(tmp.root, recipeId)).toEqual([]);
    expect((await engine.status(recipeId))['narration-text:fa']!.gate!.signed).toBe(false);
  });

  it('a hand-written agent or mock line in signoffs.jsonl is ignored on read', async () => {
    const { engine, recipeId } = await setup({ deps: { signoffs: signoffsDep(tmp.root) } });
    await runAll(engine, recipeId);
    const v = (await readVersion(tmp.root, RID, 'narration-text:fa', 1))!;
    const rec = (by: string, name: string) => JSON.stringify({ gate: 'fa-native-editor', nodeId: 'narration-text:fa', version: 1, hash: v.hash, by, name, at: '2026-11-06T10:00:00.000Z', verdict: 'pass' });
    appendFileSync(signoffsFile(tmp.root, RID), `${rec('agent:language-editor', 'Editor A')}\n${rec('editor@example.test', 'mock')}\nnot json\n`);
    expect(await readSignOffs(tmp.root, RID)).toEqual([]);
    expect((await engine.status(recipeId))['narration-text:fa']!.gate!.signed).toBe(false);
  });
});
