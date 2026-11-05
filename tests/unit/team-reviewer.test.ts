// Reviewer agent: review.json next to the package, status untouched, downscaled images for the reviewer only.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPackage } from '@/lib/studio/content';
import { listEvents } from '@/lib/studio/memory/store';
import { reviewPackage } from '@/lib/studio/team/reviewer';
import { REVIEW_OUTPUT_SCHEMA } from '@/lib/studio/team/schemas';
import { signalTools } from '@/lib/studio/team/tools';
import { SAMPLE_REVIEW, cleanupTeamEnv, fakeQuery, makePackage, setupTeamRoot } from './team-helpers';

const NOW = Date.parse('2026-11-04T12:00:00+01:00');
let root = '';
afterEach(() => {
  cleanupTeamEnv();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const imagesOf = (content: Block[]) => content.filter((c) => c.type === 'image');

describe('reviewPackage', () => {
  it('stores review.json, records post.reviewed and leaves the package status and approval untouched', async () => {
    root = setupTeamRoot();
    await makePackage(root, '01', { slides: 2 });
    const { queryFn, calls } = fakeQuery({ structured_output: SAMPLE_REVIEW, total_cost_usd: 0.09, num_turns: 4 });
    const before = await loadPackage('01');
    const { review, run } = await reviewPackage('01', { queryFn, now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.outputFormat).toEqual({ type: 'json_schema', schema: REVIEW_OUTPUT_SCHEMA });
    expect(calls[0]!.options.maxBudgetUsd).toBe(0.3);
    expect(calls[0]!.prompt).toContain('get_post');
    expect(calls[0]!.prompt).toMatch(/<untrusted_data>[\s\S]*Answer in the comments[\s\S]*<\/untrusted_data>/);
    expect(review).toMatchObject({ packageId: '01', verdict: 'ready', briefMatch: 4, answerUnambiguous: 0.92, visualQuality: 4, by: 'agent:reviewer', run: run.id, costUsd: 0.09 });
    expect(Object.keys(review.hashes).sort()).toEqual(['slide-1.png', 'slide-2.png']);
    const onDisk = JSON.parse(readFileSync(`${root}/posts/01/review.json`, 'utf8')) as { verdict: string; aiLabel: { pass: boolean } };
    expect(onDisk.verdict).toBe('ready');
    expect(onDisk.aiLabel.pass).toBe(true);
    const after = await loadPackage('01');
    expect(after.status).toBe(before.status);
    expect(after.status).toBe('ready');
    expect(after.approval).toBeNull();
    expect(existsSync(`${root}/posts/01/approval.json`)).toBe(false);
    const ev = await listEvents({ types: ['post.reviewed'] });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ by: 'agent:reviewer', refs: { package: '01', run: run.id }, data: { verdict: 'ready', briefMatch: 4 } });
  });
  it('rejects a review in the wrong shape and keeps the package clean', async () => {
    root = setupTeamRoot();
    await makePackage(root, '02');
    const { queryFn } = fakeQuery({ structured_output: { ...SAMPLE_REVIEW, verdict: 'ship it' } });
    await expect(reviewPackage('02', { queryFn, now: NOW })).rejects.toThrow(/wrong shape/);
    expect(existsSync(`${root}/posts/02/review.json`)).toBe(false);
  });
  it('refuses unknown or invalid packages before spending anything', async () => {
    root = setupTeamRoot();
    const { queryFn, calls } = fakeQuery({ structured_output: SAMPLE_REVIEW });
    await expect(reviewPackage('99', { queryFn, now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });
});

describe('get_post images', () => {
  it('gives the reviewer every slide downscaled to 768 px, as PNG image blocks', async () => {
    root = setupTeamRoot();
    await makePackage(root, '03', { slides: 3, width: 1080, height: 1350 });
    const getPost = signalTools({ role: 'reviewer', campaign: null, now: NOW }).find((t) => t.name === 'get_post')!;
    const r = await getPost.handler({ id: '03' }, {});
    expect(r.isError).toBeFalsy();
    const images = imagesOf(r.content as Block[]);
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(img.mimeType).toBe('image/png');
      const meta = await sharp(Buffer.from(img.data!, 'base64')).metadata();
      expect(meta.height).toBe(768);
      expect(meta.width).toBe(614);
    }
    const body = JSON.parse((r.content[0] as Block).text!) as { caption: string; files: { name: string; role: string }[]; status: string };
    expect(body.caption).toContain('Answer in the comments');
    expect(body.files.map((f) => f.name)).toEqual(['slide-1.png', 'slide-2.png', 'slide-3.png', 'caption.txt']);
    expect(JSON.stringify(body)).not.toMatch(/sha256|\/posts\//);
  });
  it('sends only the cover for a reel, never the video, and no images to other roles', async () => {
    root = setupTeamRoot();
    await makePackage(root, '04', { format: 'reel' });
    const reviewer = signalTools({ role: 'reviewer', campaign: null, now: NOW }).find((t) => t.name === 'get_post')!;
    const r = await reviewer.handler({ id: '04' }, {});
    const images = imagesOf(r.content as Block[]);
    expect(images).toHaveLength(1);
    expect((r.content as Block[]).some((c) => c.type === 'text' && c.text?.includes('cover.png'))).toBe(true);
    expect((r.content as Block[]).some((c) => c.text?.startsWith('Image: reel.mp4'))).toBe(false);
    const producer = signalTools({ role: 'creative-producer', campaign: null, now: NOW }).find((t) => t.name === 'get_post')!;
    const p = await producer.handler({ id: '04' }, {});
    expect(imagesOf(p.content as Block[])).toHaveLength(0);
    expect(p.isError).toBeFalsy();
  });
  it('write_review stores a review for the reviewer role and refuses personal-data-free drafts elsewhere', async () => {
    root = setupTeamRoot();
    await makePackage(root, '05');
    const tools = signalTools({ role: 'reviewer', campaign: null, now: NOW });
    const w = tools.find((t) => t.name === 'write_review')!;
    const r = await w.handler({ id: '05', review: SAMPLE_REVIEW }, {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content[0] as Block).text!)).toMatchObject({ ok: true, verdict: 'ready', status: 'ready' });
    expect((await loadPackage('05')).status).toBe('ready');
    const cm = signalTools({ role: 'community-manager', campaign: null, now: NOW }).find((t) => t.name === 'draft_reply')!;
    const blocked = await cm.handler({ themeId: 'q-levels', text: 'Thanks @someone, see https://example.com' }, {});
    expect(blocked.isError).toBe(true);
    const ok = await cm.handler({ themeId: 'q-levels', text: 'Thanks for asking! New levels land every two weeks.' }, {});
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(`${root}/memory/drafts/replies.jsonl`, 'utf8')).toContain('"status":"draft"');
  });
});
