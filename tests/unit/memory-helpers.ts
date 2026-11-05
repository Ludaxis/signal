// Fixtures for the project-memory tests: a temp project with two campaigns, plans and posts.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestProjectEnv, writeTestConfig } from './studio-helpers';
import type { Campaign, Slot } from '@/lib/studio/campaigns';

export const T0 = Date.parse('2026-11-04T12:00:00Z');
export const DAY = 86_400_000;
export let root = '';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

export const A = 'c-20261101-aaaa';
export const B = 'c-20261102-bbbb';

export function writeCampaign(c: Partial<Campaign> & { id: string; name: string; goal: Campaign['goal'] }, slots: Slot[] = []): void {
  const dir = path.join(root, 'campaigns', c.id);
  mkdirSync(dir, { recursive: true });
  const full: Campaign = {
    brief: 'Grow saves with daily puzzles.',
    formats: ['higgsfield-reel', 'website-card'],
    startDate: '2026-11-01',
    endDate: null,
    perWeek: 4,
    priority: 2,
    status: 'active',
    createdAt: '2026-10-30T10:00:00.000Z',
    createdBy: 'owner',
    strategy: null,
    proposal: null,
    ...c,
  };
  writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify(full));
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ madeAt: '2026-10-31T10:00:00.000Z', meta: null, slots }));
}

export const strategy = (pillars: { name: string; weight: number }[]): Campaign['strategy'] => ({
  summary: 'Daily bite-size puzzles people answer in the comments.',
  audience: 'Casual puzzle players',
  positioning: 'The calm puzzle',
  pillars: pillars.map((p) => ({ ...p, why: 'because' })),
  postTypes: [{ format: 'higgsfield-reel', role: 'Reach', hooks: ['Which 3 belong together?'], captionStyle: 'short', visualDirection: 'bold', hashtags: ['#puzzle'], bestTimes: ['18:00'], dos: [], donts: ['No real brands'] }],
  experiments: [{ hypothesis: 'Question hooks raise saves', measure: 'saves per reach +30%' }],
  kpis: [],
  research: [],
  risks: [],
  approvedBy: 'owner',
  approvedAt: '2026-10-31T09:00:00.000Z',
  meta: { agent: 'strategist', cli: 'test', seconds: 1, at: '2026-10-31T09:00:00.000Z' },
});

export const slot = (campaign: string, date: string, pillar: string, hook: string, format: Slot['format'] = 'higgsfield-reel', packageId: string | null = null): Slot => ({
  id: `${date}-${format}`,
  date,
  time: '18:00',
  at: `${date}T17:00:00.000Z`,
  format,
  pillar,
  hook,
  angle: 'angle',
  captionLead: hook,
  prompt: '',
  headline: '',
  articleUrl: null,
  packageId,
  status: packageId ? 'made' : 'planned',
});

export interface Pkg { caption: string; format?: 'reel' | 'carousel' | 'image'; postedAt?: string; metrics?: { reach: number; saves: number; comments?: number }; fetchedAt?: string; campaign?: { id: string; slot: string } }
export function writePackage(id: string, p: Pkg): void {
  const dir = path.join(root, 'posts', id);
  mkdirSync(dir, { recursive: true });
  const slide = Buffer.from(`slide-${id}`);
  writeFileSync(path.join(dir, 'slide-1.png'), slide);
  writeFileSync(path.join(dir, 'caption.txt'), p.caption);
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      id,
      title: `Post ${id}`,
      format: p.format ?? 'reel',
      destination: '@signal.demo',
      
      files: [{ name: 'slide-1.png', role: 'slide', sha256: sha(slide) }, { name: 'caption.txt', role: 'caption', sha256: sha(p.caption) }],
      source: { generator: 'signal-higgsfield-v1', format: (p.format ?? 'reel') === 'reel' ? 'higgsfield-reel' : 'website-card', category: 'Fruit', items: [], distractors: [], levels: [], seed: id },
    }),
  );
  if (p.postedAt) writeFileSync(path.join(dir, 'posted.json'), JSON.stringify({ url: `https://www.instagram.com/reel/abc${id}xyz/`, posted_at: p.postedAt, ai_label_confirmed: true, recorded_by: 'owner', via: 'manual' }));
  if (p.metrics) writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ fetched_at: p.fetchedAt ?? new Date(T0).toISOString(), metrics: { views: p.metrics.reach * 2, reach: p.metrics.reach, impressions: null, likes: 10, comments: p.metrics.comments ?? 1, saves: p.metrics.saves, shares: 0 } }));
  if (p.campaign) writeFileSync(path.join(dir, 'campaign.json'), JSON.stringify({ campaign: p.campaign.id, campaign_name: p.campaign.id === A ? 'Grow saves' : 'Reach', slot: p.campaign.slot, made_by: 'owner', made_at: p.postedAt ?? '2026-11-01T10:00:00.000Z' }));
}

/** Campaign A: four question-hook posts in "Guess the link" doing well, two statement-hook Seasonal posts doing badly. */
export function seedProject(opts: { questionPosts: number } = { questionPosts: 4 }): void {
  const q = ['Which 3 belong together?', 'Guess the link', 'Spot the odd one?', 'What links these three?'].slice(0, opts.questionPosts);
  const slotsA: Slot[] = [];
  let n = 1;
  for (const [i, hook] of q.entries()) {
    const date = `2026-10-${28 + i}`;
    const id = String(n++).padStart(2, '0');
    slotsA.push(slot(A, date, 'Guess the link', hook, 'higgsfield-reel', id));
    writePackage(id, { caption: `${hook}\n\nSwipe to see.`, postedAt: `${date}T17:00:00.000Z`, metrics: { reach: 1000, saves: 50 + i * 3 }, campaign: { id: A, slot: `${date}-higgsfield-reel` } });
  }
  for (const [i, hook] of ['Most people miss #2', 'Three frames from a cold morning'].entries()) {
    const date = `2026-11-0${1 + i}`;
    const id = String(n++).padStart(2, '0');
    slotsA.push(slot(A, date, 'Seasonal', hook, 'higgsfield-reel', id));
    writePackage(id, { caption: hook, postedAt: `${date}T17:00:00.000Z`, metrics: { reach: 1000, saves: 15 + i }, campaign: { id: A, slot: `${date}-higgsfield-reel` } });
  }
  slotsA.push(slot(A, '2026-11-06', 'Guess the link', 'Can you find the pair?'));
  writeCampaign({ id: A, name: 'Grow saves', goal: 'engagement', strategy: strategy([{ name: 'Guess the link', weight: 60 }, { name: 'Seasonal', weight: 40 }]) }, slotsA);
  // Campaign B: one made, unposted post.
  writePackage(String(n++).padStart(2, '0'), { caption: 'New levels this week', campaign: { id: B, slot: '2026-11-05-higgsfield-reel' } });
  writeCampaign({ id: B, name: 'Reach', goal: 'awareness', strategy: strategy([{ name: 'Launch moments', weight: 100 }]) }, [slot(B, '2026-11-05', 'Launch moments', 'New levels this week', 'higgsfield-reel', String(n - 1).padStart(2, '0'))]);
  // A post outside any campaign.
  writePackage(String(n++).padStart(2, '0'), { caption: 'A calm puzzle for your evening', postedAt: '2026-11-03T17:00:00.000Z', metrics: { reach: 800, saves: 20 } });
}

export function setupMemoryProject(): void {
  root = mkdtempSync(path.join(os.tmpdir(), 'signal-mem-'));
  setTestProjectEnv(path.join(root, 'posts'));
  process.env.SIGNAL_CONFIG_FILE = path.join(root, 'signal.config.json');
  process.env.SIGNAL_PROJECTS_FILE = path.join(root, 'no-projects.json');
  process.env.SIGNAL_PROMPTS_DIR = root;
  mkdirSync(path.join(root, 'posts'));
  writeTestConfig(path.join(root, 'signal.config.json'), { memoryTeam: true });
}
export function teardownMemoryProject(): void {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['SIGNAL_CONTENT_DIR', 'SIGNAL_CONFIG_FILE', 'SIGNAL_PROJECTS_FILE', 'SIGNAL_PROMPTS_DIR']) delete process.env[k];
}
