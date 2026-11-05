// Example project memory for the Memory tab ("Preview with example data"). Deterministic and
// self-consistent: every parent exists, every evidence id is an event in the payload, every learning
// a node links to is in `learnings`. Mirrors the design doc's worked example (a daily-puzzle brand, two weeks in: goal →
// strategy v1 → four pillars → hypotheses → variants, a learning set, a proposed and approved pivot,
// strategy v2). Nothing here is read from or written to disk.
import type { AgentRunRecord, BranchStatus, DecisionId, DecisionKind, DecisionRecord, EventType, Goal, GraphNode, Learning, MemEvent, MemoryPayload, NodeType, Role } from './types';

const C1 = 'c-20261104-ead3'; // Let'sGrow (engagement)
const C2 = 'c-20261110-b2f1'; // Sint-Maarten week (awareness)
const ME = 'owner';

// ---- events --------------------------------------------------------------------------------------
interface EvIn { at: string; type: EventType; by?: string; campaign?: string | null; refs?: MemEvent['refs']; data?: Record<string, unknown> }
function buildEvents(project: string, rows: EvIn[]): MemEvent[] {
  return rows.map((r, i) => ({
    id: `ev_${String(i + 1).padStart(3, '0')}`,
    at: r.at,
    project,
    campaign: r.campaign === undefined ? C1 : r.campaign,
    type: r.type,
    by: r.by ?? ME,
    refs: r.refs ?? {},
    data: r.data ?? {},
  }));
}

const T = (d: string, hm: string) => `2026-11-${d}T${hm}:00.000Z`;

const EVENTS: EvIn[] = [
  // 4 Nov · campaign, research, strategy v1, plan
  { at: T('04', '08:02'), type: 'campaign.created', data: { name: "Let'sGrow", goal: 'engagement', perWeek: 5, formats: ['reel', 'which3', 'odd-one-out'] } },
  { at: T('04', '08:40'), type: 'research.finding', by: 'agent:researcher', refs: { run: 'run_01' }, data: { finding: 'Puzzle Reels with a reveal in the last second get 2× saves vs static carousels in puzzle and brain-teaser accounts.', source: 'https://example.com/ig-puzzle-benchmarks-2026' } },
  { at: T('04', '08:41'), type: 'research.finding', by: 'agent:researcher', refs: { run: 'run_01' }, data: { finding: 'Question openers lift comment rate by 30–50% for quiz formats.', source: 'https://example.com/hook-study' } },
  { at: T('04', '08:43'), type: 'research.finding', by: 'agent:researcher', refs: { run: 'run_01' }, data: { finding: 'Sint-Maarten (11 Nov) is a lantern walk in NL/BE; seasonal posts peak 9–11 Nov.', source: 'https://example.com/nl-seasonal-calendar' } },
  { at: T('04', '08:50'), type: 'agent.run', by: 'agent:researcher', refs: { run: 'run_01' }, data: { role: 'researcher', model: 'claude-sonnet-4-5', costUsd: 0.18, seconds: 94, status: 'done' } },
  { at: T('04', '09:05'), type: 'decision.made', by: 'system', refs: { decision: 'dc_003' }, data: { decision: 'research-relevant', answer: false, text: 'Dropped a finding about TikTok duets (not relevant to this project).' } },
  { at: T('04', '09:30'), type: 'strategy.proposed', by: 'agent:strategist', refs: { strategy: 'st:v1', run: 'run_02' }, data: { version: 1, summary: 'Daily puzzle Reels with a reveal; four pillars weighted 40/25/20/15.', pillars: [['Guess the link', 40], ['Odd one out', 25], ['Music moments', 20], ['Seasonal', 15]] } },
  { at: T('04', '09:31'), type: 'agent.run', by: 'agent:strategist', refs: { run: 'run_02' }, data: { role: 'strategist', model: 'claude-opus-4-1', costUsd: 1.12, seconds: 212, status: 'done' } },
  { at: T('04', '10:30'), type: 'strategy.approved', refs: { strategy: 'st:v1' }, data: { version: 1, note: 'Approved as proposed; keep Seasonal small until we see reach.' } },
  { at: T('04', '11:00'), type: 'plan.made', by: 'agent:planner', refs: { run: 'run_03' }, data: { slots: 10, from: '2026-11-05', to: '2026-11-18' } },
  { at: T('04', '11:01'), type: 'agent.run', by: 'agent:planner', refs: { run: 'run_03' }, data: { role: 'planner', model: 'claude-sonnet-4-5', costUsd: 0.41, seconds: 58, status: 'done' } },
  { at: T('04', '11:02'), type: 'decision.made', by: 'system', refs: { decision: 'dc_006', branch: 'hy:question' }, data: { decision: 'explore-exploit', answer: 'explore', text: 'First slot explores Guess the link / question hook.' } },
  { at: T('04', '17:10'), type: 'brief.created', by: 'agent:planner', refs: { package: '12', slot: '2026-11-05-reel', branch: 'hy:question' }, data: { format: 'reel', pillar: 'Guess the link', hook: 'Most people miss #2', hookStyle: 'question' } },
  // 5 Nov · post 12 made, reviewed, approved, published; brief 13
  { at: T('05', '07:20'), type: 'post.made', by: 'system', refs: { package: '12', slot: '2026-11-05-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Most people miss #2', seconds: 41 } },
  { at: T('05', '07:24'), type: 'post.reviewed', by: 'agent:reviewer', refs: { package: '12', branch: 'hy:question', run: 'run_04' }, data: { briefMatch: 4.3, unambiguous: 0.93, visual: 4, brandRules: 'pass', verdict: 'ready' } },
  { at: T('05', '07:25'), type: 'agent.run', by: 'agent:reviewer', refs: { run: 'run_04' }, data: { role: 'reviewer', model: 'claude-sonnet-4-5', costUsd: 0.22, seconds: 36, status: 'done' } },
  { at: T('05', '10:31'), type: 'post.approved', refs: { package: '12', slot: '2026-11-05-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Most people miss #2', pillar: 'Guess the link' } },
  { at: T('05', '17:30'), type: 'post.published', by: 'system', refs: { package: '12', slot: '2026-11-05-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Most people miss #2', permalink: 'https://www.instagram.com/reel/DEMO12/' } },
  { at: T('05', '18:05'), type: 'brief.created', by: 'agent:planner', refs: { package: '13', slot: '2026-11-06-reel', branch: 'hy:trick' }, data: { format: 'reel', pillar: 'Odd one out', hook: 'Spot the impostor', hookStyle: 'statement' } },
  // 6 Nov · post 13, first results for 12
  { at: T('06', '07:10'), type: 'post.made', by: 'system', refs: { package: '13', slot: '2026-11-06-reel', branch: 'hy:trick' }, data: { format: 'reel', hook: 'Spot the impostor', seconds: 39 } },
  { at: T('06', '09:02'), type: 'post.approved', refs: { package: '13', slot: '2026-11-06-reel', branch: 'hy:trick' }, data: { format: 'reel', hook: 'Spot the impostor', pillar: 'Odd one out' } },
  { at: T('06', '17:30'), type: 'post.published', by: 'system', refs: { package: '13', slot: '2026-11-06-reel', branch: 'hy:trick' }, data: { format: 'reel', hook: 'Spot the impostor' } },
  { at: T('06', '19:40'), type: 'metrics.snapshot', by: 'system', refs: { package: '12', branch: 'hy:question' }, data: { views: 5200, reach: 2140, likes: 96, saves: 18, shares: 7, comments: 21, ageHours: 26 } },
  { at: T('06', '19:41'), type: 'comments.theme', by: 'agent:community-manager', refs: { package: '12', branch: 'hy:question' }, data: { themes: { 'answer guesses': 14, praise: 5, 'asks where to play': 2 } } },
  // 7 Nov · post 14 (statement hook) rejected then edited; first learning
  { at: T('07', '06:50'), type: 'brief.created', by: 'agent:planner', refs: { package: '14', slot: '2026-11-07-reel', branch: 'hy:statement' }, data: { format: 'reel', pillar: 'Guess the link', hook: 'Three items, one link', hookStyle: 'statement' } },
  { at: T('07', '07:30'), type: 'post.made', by: 'system', refs: { package: '14', slot: '2026-11-07-reel', branch: 'hy:statement' }, data: { format: 'reel', hook: 'Three items, one link', seconds: 44 } },
  { at: T('07', '08:12'), type: 'post.rejected', refs: { package: '14', branch: 'hy:statement' }, data: { reason: 'The first frame is too dark and the hook reads flat. Brighten the frame, keep the statement hook so we can still compare.' } },
  { at: T('07', '08:40'), type: 'post.edited', by: 'system', refs: { package: '14', branch: 'hy:statement' }, data: { changed: ['first frame contrast', 'caption lead'] } },
  { at: T('07', '09:05'), type: 'post.approved', refs: { package: '14', slot: '2026-11-07-reel', branch: 'hy:statement' }, data: { format: 'reel', hook: 'Three items, one link', pillar: 'Guess the link' } },
  { at: T('07', '17:30'), type: 'post.published', by: 'system', refs: { package: '14', slot: '2026-11-07-reel', branch: 'hy:statement' }, data: { format: 'reel', hook: 'Three items, one link' } },
  { at: T('07', '19:10'), type: 'metrics.snapshot', by: 'system', refs: { package: '13', branch: 'hy:trick' }, data: { views: 3900, reach: 1760, likes: 71, saves: 9, shares: 4, comments: 26, ageHours: 26 } },
  { at: T('07', '19:12'), type: 'decision.made', by: 'system', refs: { decision: 'dc_017', branch: 'hy:question' }, data: { decision: 'significant-change', answer: false, text: 'Learning updated: question hooks ×1.6 saves (n 3, too little data).' } },
  // 8 Nov · post 15, followers
  { at: T('08', '06:55'), type: 'brief.created', by: 'agent:planner', refs: { package: '15', slot: '2026-11-08-reel', branch: 'hy:question' }, data: { format: 'reel', pillar: 'Guess the link', hook: 'Which 3 belong together?', hookStyle: 'question' } },
  { at: T('08', '07:35'), type: 'post.made', by: 'system', refs: { package: '15', slot: '2026-11-08-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Which 3 belong together?', seconds: 40 } },
  { at: T('08', '09:20'), type: 'post.approved', refs: { package: '15', slot: '2026-11-08-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Which 3 belong together?', pillar: 'Guess the link' } },
  { at: T('08', '17:30'), type: 'post.published', by: 'system', refs: { package: '15', slot: '2026-11-08-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Which 3 belong together?' } },
  { at: T('08', '18:00'), type: 'account.snapshot', by: 'system', data: { followers: 1284, following: 12, posts: 41 } },
  { at: T('08', '19:30'), type: 'metrics.snapshot', by: 'system', refs: { package: '14', branch: 'hy:statement' }, data: { views: 3100, reach: 1480, likes: 58, saves: 7, shares: 3, comments: 9, ageHours: 26 } },
  // 9 Nov · post 16 scheduled on Upload-Post; results 15; a question from the audience
  { at: T('09', '08:00'), type: 'brief.created', by: 'agent:planner', refs: { package: '16', slot: '2026-11-09-reel', branch: 'hy:statement' }, data: { format: 'reel', pillar: 'Guess the link', hook: 'This one trips everyone up', hookStyle: 'statement' } },
  { at: T('09', '08:35'), type: 'post.made', by: 'system', refs: { package: '16', slot: '2026-11-09-reel', branch: 'hy:statement' }, data: { format: 'reel', hook: 'This one trips everyone up', seconds: 43 } },
  { at: T('09', '09:10'), type: 'post.scheduled', refs: { package: '16', slot: '2026-11-09-reel', branch: 'hy:statement' }, data: { at: '2026-11-09T17:30:00.000Z', via: 'upload-post' } },
  { at: T('09', '17:31'), type: 'post.published', by: 'system', refs: { package: '16', slot: '2026-11-09-reel', branch: 'hy:statement' }, data: { format: 'reel', hook: 'This one trips everyone up' } },
  { at: T('09', '19:35'), type: 'metrics.snapshot', by: 'system', refs: { package: '15', branch: 'hy:question' }, data: { views: 6100, reach: 2560, likes: 118, saves: 24, shares: 11, comments: 33, ageHours: 26 } },
  { at: T('09', '20:02'), type: 'comment.question', by: 'agent:community-manager', refs: { package: '15', branch: 'hy:question' }, data: { question: 'Where can I play these?', draftReply: 'Every puzzle is on our site — link in bio.' } },
  // 10 Nov · question hooks → promising; analyst report; note; post 17 (music)
  { at: T('10', '07:00'), type: 'decision.made', by: 'system', refs: { decision: 'dc_023', branch: 'hy:question' }, data: { decision: 'branch-status', answer: 'promising', text: 'Question hooks → promising (n 6, nEff 4.8, conf 0.71).' } },
  { at: T('10', '07:30'), type: 'agent.run', by: 'agent:analyst', refs: { run: 'run_05' }, data: { role: 'analyst', model: 'claude-sonnet-4-5', costUsd: 0.63, seconds: 121, status: 'done', summary: 'Week 1: question hooks lead on saves; Odd one out leads on comments.' } },
  { at: T('10', '08:15'), type: 'note.added', refs: { branch: 'hy:question' }, data: { note: 'Keep hooks under 8 words; the second item should be the trap.' } },
  { at: T('10', '08:30'), type: 'brief.created', by: 'agent:planner', refs: { package: '17', slot: '2026-11-10-reel', branch: 'hy:beat' }, data: { format: 'reel', pillar: 'Music moments', hook: 'Drop on the beat', hookStyle: 'statement' } },
  { at: T('10', '09:05'), type: 'post.made', by: 'system', refs: { package: '17', slot: '2026-11-10-reel', branch: 'hy:beat' }, data: { format: 'reel', hook: 'Drop on the beat', seconds: 52 } },
  { at: T('10', '10:40'), type: 'post.approved', refs: { package: '17', slot: '2026-11-10-reel', branch: 'hy:beat' }, data: { format: 'reel', hook: 'Drop on the beat', pillar: 'Music moments' } },
  { at: T('10', '17:30'), type: 'post.published', by: 'system', refs: { package: '17', slot: '2026-11-10-reel', branch: 'hy:beat' }, data: { format: 'reel', hook: 'Drop on the beat' } },
  // 11 Nov · results 16 and 17; Sint-Maarten campaign; statement hooks → weak
  { at: T('11', '07:00'), type: 'metrics.snapshot', by: 'system', refs: { package: '16', branch: 'hy:statement' }, data: { views: 2800, reach: 1390, likes: 49, saves: 6, shares: 2, comments: 8, ageHours: 38 } },
  { at: T('11', '07:05'), type: 'decision.made', by: 'system', refs: { decision: 'dc_027', branch: 'hy:statement' }, data: { decision: 'branch-status', answer: 'weak', text: 'Statement hooks → weak (saves ×0.78, nEff 3.1).' } },
  { at: T('11', '08:10'), type: 'campaign.created', campaign: C2, data: { name: 'Sint-Maarten week', goal: 'awareness', perWeek: 2 } },
  { at: T('11', '08:30'), type: 'brief.created', by: 'agent:planner', campaign: C2, refs: { package: '19', slot: '2026-11-11-reel', branch: 'hy:sint' }, data: { format: 'reel', pillar: 'Seasonal', hook: 'Lantern sort', hookStyle: 'statement' } },
  { at: T('11', '09:15'), type: 'post.made', by: 'system', campaign: C2, refs: { package: '19', slot: '2026-11-11-reel', branch: 'hy:sint' }, data: { format: 'reel', hook: 'Lantern sort', seconds: 47 } },
  { at: T('11', '10:02'), type: 'post.approved', campaign: C2, refs: { package: '19', slot: '2026-11-11-reel', branch: 'hy:sint' }, data: { format: 'reel', hook: 'Lantern sort', pillar: 'Seasonal' } },
  { at: T('11', '16:30'), type: 'post.published', by: 'system', campaign: C2, refs: { package: '19', slot: '2026-11-11-reel', branch: 'hy:sint' }, data: { format: 'reel', hook: 'Lantern sort' } },
  { at: T('11', '19:20'), type: 'metrics.snapshot', by: 'system', refs: { package: '17', branch: 'hy:beat' }, data: { views: 4400, reach: 1950, likes: 88, saves: 12, shares: 9, comments: 11, ageHours: 26 } },
  // 12 Nov · seasonal results; pivot proposed; brief 18
  { at: T('12', '18:45'), type: 'metrics.snapshot', by: 'system', campaign: C2, refs: { package: '19', branch: 'hy:sint' }, data: { views: 7300, reach: 3010, likes: 102, saves: 11, shares: 19, comments: 14, ageHours: 26 } },
  { at: T('12', '19:00'), type: 'decision.made', by: 'system', refs: { decision: 'dc_030', branch: 'hy:sint' }, data: { decision: 'branch-status', answer: 'weak', text: 'Seasonal → weak for saves (reach ×1.4, saves ×0.9); would be promising under Awareness.' } },
  { at: T('12', '19:30'), type: 'agent.run', by: 'agent:lead', refs: { run: 'run_06' }, data: { role: 'lead', model: 'claude-opus-4-1', costUsd: 2.4, seconds: 341, status: 'done', summary: 'Proposed moving 10% from Seasonal to Guess the link.' } },
  { at: T('12', '19:32'), type: 'pivot.proposed', by: 'agent:lead', refs: { branch: 'pv:1', run: 'run_06', decision: 'dc_031' }, data: { title: 'Move 10% Seasonal → Guess the link', why: 'Question hooks ×1.58 saves at nEff 5.6; Seasonal lifts reach, not saves.', probability: 0.86 } },
  { at: T('12', '20:00'), type: 'brief.created', by: 'agent:planner', refs: { package: '18', slot: '2026-11-13-reel', branch: 'hy:question' }, data: { format: 'reel', pillar: 'Guess the link', hook: 'Can you link these in 5 s?', hookStyle: 'question' } },
  // 13 Nov · pivot approved; post 18
  { at: T('13', '08:05'), type: 'pivot.approved', refs: { branch: 'pv:1' }, data: { title: 'Move 10% Seasonal → Guess the link', note: 'Approved. Keep one seasonal slot for reach.' } },
  { at: T('13', '08:40'), type: 'post.made', by: 'system', refs: { package: '18', slot: '2026-11-13-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Can you link these in 5 s?', seconds: 38 } },
  { at: T('13', '09:30'), type: 'post.approved', refs: { package: '18', slot: '2026-11-13-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Can you link these in 5 s?', pillar: 'Guess the link' } },
  { at: T('13', '17:30'), type: 'post.published', by: 'system', refs: { package: '18', slot: '2026-11-13-reel', branch: 'hy:question' }, data: { format: 'reel', hook: 'Can you link these in 5 s?' } },
  // 14 Nov · strategy v2; statement hooks pruned; brand updated
  { at: T('14', '09:00'), type: 'strategy.proposed', by: 'agent:strategist', refs: { strategy: 'st:v2', run: 'run_07' }, data: { version: 2, summary: 'Guess the link 50%, Odd one out 25%, Music 25% with a beat-sync test; Seasonal only on calendar days.' } },
  { at: T('14', '09:01'), type: 'agent.run', by: 'agent:strategist', refs: { run: 'run_07' }, data: { role: 'strategist', model: 'claude-opus-4-1', costUsd: 1.05, seconds: 198, status: 'done' } },
  { at: T('14', '10:00'), type: 'strategy.approved', refs: { strategy: 'st:v2' }, data: { version: 2 } },
  { at: T('14', '10:05'), type: 'decision.made', by: 'system', refs: { decision: 'dc_034', branch: 'hy:statement' }, data: { decision: 'branch-status', answer: 'pruned', text: 'Statement hooks pruned (saves ×0.78, interval excludes 1, nEff 3.4).' } },
  { at: T('14', '11:20'), type: 'brand.updated', data: { changed: ['accent colour', 'claims policy: no "addictive"'] } },
  { at: T('14', '19:15'), type: 'metrics.snapshot', by: 'system', refs: { package: '18', branch: 'hy:question' }, data: { views: 5900, reach: 2420, likes: 104, saves: 19, shares: 8, comments: 24, ageHours: 26 } },
  // 15 Nov · 48 h results for 18; comment themes
  { at: T('15', '18:00'), type: 'metrics.snapshot', by: 'system', refs: { package: '18', branch: 'hy:question' }, data: { views: 8100, reach: 3260, likes: 141, saves: 27, shares: 12, comments: 31, ageHours: 48 } },
  { at: T('15', '18:02'), type: 'comments.theme', by: 'agent:community-manager', refs: { package: '18', branch: 'hy:question' }, data: { themes: { 'answer guesses': 19, 'too easy': 4, praise: 6 } } },
  // 16 Nov · question hooks → winning; post 20 fails on Upload-Post, rescheduled
  { at: T('16', '07:00'), type: 'decision.made', by: 'system', refs: { decision: 'dc_035', branch: 'hy:question' }, data: { decision: 'branch-status', answer: 'winning', text: 'Question hooks → winning (nEff 8.1, conf 0.84).' } },
  { at: T('16', '08:00'), type: 'brief.created', by: 'agent:planner', refs: { package: '20', slot: '2026-11-16-reel', branch: 'hy:beatsync' }, data: { format: 'reel', pillar: 'Music moments', hook: 'Which beat drops first?', hookStyle: 'question' } },
  { at: T('16', '08:50'), type: 'post.made', by: 'system', refs: { package: '20', slot: '2026-11-16-reel', branch: 'hy:beatsync' }, data: { format: 'reel', hook: 'Which beat drops first?', seconds: 55 } },
  { at: T('16', '10:10'), type: 'post.approved', refs: { package: '20', slot: '2026-11-16-reel', branch: 'hy:beatsync' }, data: { format: 'reel', hook: 'Which beat drops first?', pillar: 'Music moments' } },
  { at: T('16', '17:31'), type: 'post.failed', by: 'system', refs: { package: '20', slot: '2026-11-16-reel', branch: 'hy:beatsync' }, data: { error: 'Upload-Post returned 502 while fetching the video.' } },
  { at: T('16', '18:20'), type: 'post.scheduled', refs: { package: '20', slot: '2026-11-17-reel', branch: 'hy:beatsync' }, data: { at: '2026-11-17T17:30:00.000Z', via: 'signal' } },
  // 17 Nov · post 20 published; catalog
  { at: T('17', '17:30'), type: 'post.published', by: 'system', refs: { package: '20', slot: '2026-11-17-reel', branch: 'hy:beatsync' }, data: { format: 'reel', hook: 'Which beat drops first?' } },
  { at: T('17', '18:00'), type: 'catalog.updated', by: 'system', data: { categories: 128, items: 1930, added: ['Winter drinks', 'Lanterns'] } },
  // 18 Nov · results 20; label confirmed; a discarded draft; analyst running
  { at: T('18', '07:45'), type: 'post.label-confirmed', refs: { package: '18' }, data: { label: 'AI-generated', where: 'Instagram' } },
  { at: T('18', '08:30'), type: 'post.discarded', refs: { package: '21' }, data: { reason: 'Duplicate of post 15.' } },
  { at: T('18', '19:40'), type: 'metrics.snapshot', by: 'system', refs: { package: '20', branch: 'hy:beatsync' }, data: { views: 4700, reach: 2080, likes: 93, saves: 15, shares: 10, comments: 13, ageHours: 26 } },
  { at: T('18', '20:00'), type: 'agent.run', by: 'agent:analyst', refs: { run: 'run_08' }, data: { role: 'analyst', model: 'claude-sonnet-4-5', status: 'running' } },
];

/** Event ids that reference a package or a branch, for wiring node evidence. */
function evidenceFor(events: MemEvent[], match: (e: MemEvent) => boolean): string[] {
  return events.filter(match).map((e) => e.id);
}

// ---- graph ---------------------------------------------------------------------------------------
interface NodeIn {
  id: string;
  type: NodeType;
  parent: string | null;
  label: string;
  campaign?: string | null;
  status?: BranchStatus | null;
  weight?: number | null;
  created: string;
  updated?: string;
  evidence?: string[];
  learning?: string | null;
  goalWeight?: Partial<Record<Goal, number>>;
  meta?: Record<string, unknown>;
  history?: { at: string; status: BranchStatus | null }[];
}
function node(n: NodeIn): GraphNode {
  const history = n.history ?? (n.status !== undefined && n.status !== null ? [{ at: n.created, status: n.status }] : undefined);
  const status = n.status === undefined ? (history ? (history[history.length - 1]?.status ?? null) : null) : n.status;
  return {
    id: n.id,
    type: n.type,
    parent: n.parent,
    label: n.label,
    campaign: n.campaign === undefined ? C1 : n.campaign,
    status,
    weight: n.weight ?? null,
    created: n.created,
    updated: n.updated ?? (history ? (history[history.length - 1]?.at ?? n.created) : n.created),
    evidence: n.evidence ?? [],
    learning: n.learning ?? null,
    goalWeight: n.goalWeight ?? { engagement: 1 },
    meta: { ...(n.meta ?? {}), ...(history ? { statusHistory: history } : {}) },
  };
}

const pkg = (events: MemEvent[], id: string) => evidenceFor(events, (e) => e.refs.package === id);
const branch = (events: MemEvent[], id: string) => evidenceFor(events, (e) => e.refs.branch === id);
const metricsOf = (events: MemEvent[], id: string): Record<string, unknown> | null => {
  const snaps = events.filter((e) => e.type === 'metrics.snapshot' && e.refs.package === id);
  const last = snaps[snaps.length - 1];
  return last ? last.data : null;
};

function buildNodes(events: MemEvent[]): GraphNode[] {
  const D = (d: string, hm = '10:30') => `2026-11-${d}T${hm}:00.000Z`;
  const variant = (id: string, parent: string, label: string, created: string, history: NodeIn['history'], extra: Partial<NodeIn> = {}): GraphNode =>
    node({ id, type: 'variant', parent, label: `“${label}”`, created, history, evidence: pkg(events, id.replace('var:pkg-', '')), meta: { packageId: id.replace('var:pkg-', ''), format: 'reel', hook: label, metrics: metricsOf(events, id.replace('var:pkg-', '')) }, ...extra });

  return [
    node({ id: 'goal:c1', type: 'goal', parent: null, label: 'Grow engagement · saves ≥ 15 per post', created: D('04', '08:02'), evidence: evidenceFor(events, (e) => e.type === 'campaign.created' && e.campaign === C1), goalWeight: { engagement: 1 }, meta: { metric: 'saves per post', target: 15, goal: 'engagement' } }),
    node({ id: 'st:v1', type: 'strategy', parent: 'goal:c1', label: "Let'sGrow v1 · puzzle Reels", created: D('04', '10:30'), evidence: evidenceFor(events, (e) => e.refs.strategy === 'st:v1' || e.type === 'research.finding' || e.type === 'plan.made'), meta: { version: 1, approvedBy: ME, approvedAt: D('04', '10:30'), supersededBy: 'st:v2' } }),
    node({ id: 'pl:guess', type: 'pillar', parent: 'st:v1', label: 'Guess the link', weight: 40, created: D('04', '10:30'), history: [{ at: D('04', '10:30'), status: 'exploring' }, { at: D('10', '07:00'), status: 'promising' }, { at: D('16', '07:00'), status: 'winning' }], evidence: [], meta: { why: 'Core puzzle format; a reveal in the last second.' } }),
    node({ id: 'pl:odd', type: 'pillar', parent: 'st:v1', label: 'Odd one out', weight: 25, created: D('04', '10:30'), history: [{ at: D('04', '10:30'), status: 'exploring' }], meta: { why: 'Fast to read; drives comments.' } }),
    node({ id: 'pl:music', type: 'pillar', parent: 'st:v1', label: 'Music moments', weight: 20, created: D('04', '10:30'), history: [{ at: D('04', '10:30'), status: 'exploring' }], meta: { why: 'Shows the music moments people remember.' } }),
    node({ id: 'pl:seasonal', type: 'pillar', parent: 'st:v1', label: 'Seasonal', weight: 15, created: D('04', '10:30'), history: [{ at: D('04', '10:30'), status: 'exploring' }, { at: D('12', '19:00'), status: 'weak' }], goalWeight: { engagement: 0.4, awareness: 1 }, meta: { why: 'Calendar moments for reach.' } }),

    node({ id: 'hy:question', type: 'hypothesis', parent: 'pl:guess', label: 'Question hooks raise saves', created: D('04', '11:00'), history: [{ at: D('04', '11:00'), status: 'exploring' }, { at: D('10', '07:00'), status: 'promising' }, { at: D('16', '07:00'), status: 'winning' }], evidence: branch(events, 'hy:question'), learning: 'lr:hook-question', goalWeight: { engagement: 1, installs: 0.4 }, meta: { hookStyle: 'question', metrics: { posts: 3, views: 19400, reach: 7960, saves: 69, comments: 85, savesPerReach: 0.0087 } } }),
    node({ id: 'hy:statement', type: 'hypothesis', parent: 'pl:guess', label: 'Statement hooks', created: D('04', '11:00'), history: [{ at: D('04', '11:00'), status: 'exploring' }, { at: D('11', '07:05'), status: 'weak' }, { at: D('14', '10:05'), status: 'pruned' }], evidence: branch(events, 'hy:statement'), learning: 'lr:hook-statement', meta: { hookStyle: 'statement', metrics: { posts: 2, views: 5900, reach: 2870, saves: 13, comments: 17, savesPerReach: 0.0045 } } }),
    variant('var:pkg-12', 'hy:question', 'Most people miss #2', D('04', '17:10'), [{ at: D('04', '17:10'), status: 'exploring' }, { at: D('06', '19:40'), status: 'promising' }, { at: D('10', '07:00'), status: 'winning' }]),
    variant('var:pkg-15', 'hy:question', 'Which 3 belong together?', D('08', '06:55'), [{ at: D('08', '06:55'), status: 'exploring' }, { at: D('09', '19:35'), status: 'winning' }]),
    variant('var:pkg-18', 'hy:question', 'Can you link these in 5 s?', D('12', '20:00'), [{ at: D('12', '20:00'), status: 'exploring' }, { at: D('15', '18:00'), status: 'promising' }]),
    node({ id: 'out:question', type: 'outcome', parent: 'hy:question', label: 'Saves ×1.58 · n 6', created: D('10', '07:00'), updated: D('16', '07:00'), evidence: evidenceFor(events, (e) => e.type === 'metrics.snapshot' && e.refs.branch === 'hy:question'), meta: { effect: 1.58, interval: [1.12, 2.2], n: 6, nEff: 8.1 } }),
    node({ id: 'lrn:question', type: 'learning', parent: 'hy:question', label: 'Question hooks work for Reels', created: D('07', '19:12'), learning: 'lr:hook-question', evidence: evidenceFor(events, (e) => e.refs.decision === 'dc_017') }),
    variant('var:pkg-14', 'hy:statement', 'Three items, one link', D('07', '06:50'), [{ at: D('07', '06:50'), status: 'exploring' }, { at: D('08', '19:30'), status: 'weak' }]),
    variant('var:pkg-16', 'hy:statement', 'This one trips everyone up', D('09', '08:00'), [{ at: D('09', '08:00'), status: 'exploring' }, { at: D('11', '07:00'), status: 'weak' }, { at: D('14', '10:05'), status: 'pruned' }]),

    node({ id: 'hy:trick', type: 'hypothesis', parent: 'pl:odd', label: 'Trick categories', created: D('04', '11:00'), history: [{ at: D('04', '11:00'), status: 'exploring' }], evidence: branch(events, 'hy:trick'), learning: 'lr:trick-cat', goalWeight: { engagement: 0.8, community: 1 }, meta: { metrics: { posts: 1, views: 3900, reach: 1760, saves: 9, comments: 26 } } }),
    variant('var:pkg-13', 'hy:trick', 'Spot the impostor', D('05', '18:05'), [{ at: D('05', '18:05'), status: 'exploring' }]),

    node({ id: 'hy:beat', type: 'hypothesis', parent: 'pl:music', label: 'Beat drop reveal', created: D('04', '11:00'), history: [{ at: D('04', '11:00'), status: 'exploring' }], evidence: branch(events, 'hy:beat'), learning: 'lr:beat-drop', meta: { metrics: { posts: 1, views: 4400, reach: 1950, saves: 12, comments: 11 } } }),
    variant('var:pkg-17', 'hy:beat', 'Drop on the beat', D('10', '08:30'), [{ at: D('10', '08:30'), status: 'exploring' }]),

    node({ id: 'hy:sint', type: 'hypothesis', parent: 'pl:seasonal', label: 'Sint-Maarten lanterns', campaign: C2, created: D('11', '08:10'), history: [{ at: D('11', '08:10'), status: 'exploring' }, { at: D('12', '19:00'), status: 'weak' }], evidence: branch(events, 'hy:sint'), learning: 'lr:seasonal-reach', goalWeight: { awareness: 1, engagement: 0.4 }, meta: { metrics: { posts: 1, views: 7300, reach: 3010, saves: 11, shares: 19 } } }),
    variant('var:pkg-19', 'hy:sint', 'Lantern sort', D('11', '08:30'), [{ at: D('11', '08:30'), status: 'exploring' }, { at: D('12', '19:00'), status: 'weak' }], { campaign: C2 }),
    node({ id: 'out:sint', type: 'outcome', parent: 'hy:sint', label: 'Reach ×1.4 · saves ×0.9', campaign: C2, created: D('12', '18:45'), evidence: evidenceFor(events, (e) => e.type === 'metrics.snapshot' && e.refs.package === '19'), meta: { effect: 1.4, metric: 'reach', n: 1 } }),

    node({ id: 'lrn:reels', type: 'learning', parent: 'st:v1', label: 'Reels beat carousels on reach', created: D('07', '19:12'), learning: 'lr:reels-reach', evidence: evidenceFor(events, (e) => e.type === 'metrics.snapshot').slice(0, 4) }),
    node({ id: 'lrn:time', type: 'learning', parent: 'st:v1', label: '18:30 beats 12:30', created: D('09', '19:35'), learning: 'lr:time-1830', evidence: evidenceFor(events, (e) => e.type === 'metrics.snapshot').slice(2, 5) }),
    node({ id: 'pv:1', type: 'pivot', parent: 'st:v1', label: 'Move 10% Seasonal → Guess the link', created: D('12', '19:32'), history: [{ at: D('12', '19:32'), status: 'proposed' }, { at: D('13', '08:05'), status: null }], evidence: branch(events, 'pv:1'), meta: { approvedAt: D('13', '08:05'), approvedBy: ME, probability: 0.86, from: 'pl:seasonal', to: 'pl:guess', percent: 10 } }),

    node({ id: 'st:v2', type: 'strategy', parent: 'goal:c1', label: "Let'sGrow v2 · after pivot", created: D('14', '10:00'), evidence: evidenceFor(events, (e) => e.refs.strategy === 'st:v2' || e.refs.branch === 'pv:1'), meta: { version: 2, approvedBy: ME, approvedAt: D('14', '10:00'), supersedes: 'st:v1' } }),
    node({ id: 'pl2:guess', type: 'pillar', parent: 'st:v2', label: 'Guess the link', weight: 50, created: D('14', '10:00'), history: [{ at: D('14', '10:00'), status: 'winning' }], evidence: branch(events, 'hy:question').slice(-3), learning: 'lr:hook-question', meta: { continues: 'pl:guess' } }),
    node({ id: 'pl2:odd', type: 'pillar', parent: 'st:v2', label: 'Odd one out', weight: 25, created: D('14', '10:00'), history: [{ at: D('14', '10:00'), status: 'exploring' }], meta: { continues: 'pl:odd' } }),
    node({ id: 'pl2:music', type: 'pillar', parent: 'st:v2', label: 'Music moments', weight: 25, created: D('14', '10:00'), history: [{ at: D('14', '10:00'), status: 'exploring' }], meta: { continues: 'pl:music' } }),
    node({ id: 'hy:beatsync', type: 'hypothesis', parent: 'pl2:music', label: 'Beat-sync hooks', created: D('14', '10:00'), history: [{ at: D('14', '10:00'), status: 'proposed' }, { at: D('17', '17:30'), status: 'exploring' }], evidence: branch(events, 'hy:beatsync'), meta: { hookStyle: 'question', metrics: { posts: 1, views: 4700, reach: 2080, saves: 15, comments: 13 } } }),
    variant('var:pkg-20', 'hy:beatsync', 'Which beat drops first?', D('16', '08:00'), [{ at: D('16', '08:00'), status: 'exploring' }]),
  ];
}

// ---- learnings -----------------------------------------------------------------------------------
function buildLearnings(): Learning[] {
  const L = (l: Omit<Learning, 'halfLifeDays' | 'updatedAt'> & { halfLifeDays?: number; updatedAt?: string }): Learning => ({ halfLifeDays: 14, updatedAt: l.lastEvidence ?? '2026-11-18T00:00:00.000Z', ...l });
  return [
    L({ id: 'lr:hook-question', text: 'Question hooks on Reels get more saves than statement hooks.', metric: 'saves_per_reach', scope: { campaign: C1, branch: 'hy:question', format: 'reel', hookStyle: 'question' }, effect: 1.58, interval: [1.12, 2.2], mean: 0.0087, baseline: 0.0055, n: 6, nEff: 8.1, confidence: 0.84, status: 'active', lastEvidence: '2026-11-15T18:00:00.000Z', branch: 'hy:question' }),
    L({ id: 'lr:reels-reach', text: 'Reels reach about a third more accounts than carousels.', metric: 'reach', scope: { format: 'reel' }, effect: 1.35, interval: [1.05, 1.7], mean: 2140, baseline: 1590, n: 9, nEff: 6.2, confidence: 0.64, status: 'active', lastEvidence: '2026-11-18T19:40:00.000Z', branch: null }),
    L({ id: 'lr:hook-statement', text: 'Statement hooks get fewer saves than the project baseline.', metric: 'saves_per_reach', scope: { campaign: C1, branch: 'hy:statement', format: 'reel', hookStyle: 'statement' }, effect: 0.78, interval: [0.55, 0.98], mean: 0.0045, baseline: 0.0055, n: 2, nEff: 3.4, confidence: 0.62, status: 'active', lastEvidence: '2026-11-11T07:00:00.000Z', branch: 'hy:statement' }),
    L({ id: 'lr:seasonal-reach', text: 'Seasonal posts lift reach but not saves.', metric: 'reach', scope: { campaign: C2, branch: 'hy:sint' }, effect: 1.4, interval: [0.9, 2.1], mean: 3010, baseline: 2150, n: 1, nEff: 1.6, confidence: 0.58, status: 'too-little-data', lastEvidence: '2026-11-12T18:45:00.000Z', branch: 'hy:sint' }),
    L({ id: 'lr:trick-cat', text: 'Trick categories get more comments per reach.', metric: 'comments_per_reach', scope: { branch: 'hy:trick', format: 'reel' }, effect: 1.21, interval: [0.7, 2.0], mean: 0.0148, baseline: 0.0122, n: 1, nEff: 1.4, confidence: 0.55, status: 'too-little-data', lastEvidence: '2026-11-07T19:10:00.000Z', branch: 'hy:trick' }),
    L({ id: 'lr:time-1830', text: 'Posting at 18:30 beats 12:30 for saves.', metric: 'saves_per_reach', scope: { hour: 18 }, effect: 1.12, interval: [0.8, 1.6], mean: 0.0061, baseline: 0.0055, n: 3, nEff: 1.9, confidence: 0.55, status: 'too-little-data', lastEvidence: '2026-11-09T19:35:00.000Z', branch: null }),
    L({ id: 'lr:beat-drop', text: 'A reveal on the beat drop keeps people to the end.', metric: 'views', scope: { branch: 'hy:beat', format: 'reel' }, effect: 1.12, interval: [0.6, 1.9], mean: 4400, baseline: 3920, n: 1, nEff: 0.6, confidence: 0.52, status: 'too-little-data', lastEvidence: '2026-11-11T19:20:00.000Z', branch: 'hy:beat' }),
    L({ id: 'lr:carousel-oct', text: 'Carousels got more saves than Reels in October.', metric: 'saves_per_reach', scope: { format: 'carousel' }, effect: 1.1, interval: [0.9, 1.35], mean: 0.0058, baseline: 0.0053, n: 5, nEff: 1.1, confidence: 0.5, status: 'retired', lastEvidence: '2026-10-22T18:00:00.000Z', branch: null, halfLifeDays: 14 }),
  ];
}

// ---- decisions -----------------------------------------------------------------------------------
interface DcIn { at: string; decision: DecisionId; kind: DecisionKind; via: DecisionRecord['via']; answer: DecisionRecord['answer']; p?: Record<string, number> | null; confidence?: number | null; threshold?: number | null; cost?: number | null; outcome?: DecisionRecord['outcome']; note?: string | null; campaign?: string | null }
const JUDGE = 'claude-haiku-4-5';
function buildDecisions(project: string): DecisionRecord[] {
  const rows: DcIn[] = [
    { at: T('04', '08:45'), decision: 'research-relevant', kind: 'predicate', via: 'judge', answer: true, p: { yes: 0.91, no: 0.09 }, confidence: 0.91, threshold: 0.6, cost: 0.0003, outcome: 'right', note: 'Puzzle Reels benchmark → strategist pack' },
    { at: T('04', '08:46'), decision: 'research-relevant', kind: 'predicate', via: 'judge', answer: true, p: { yes: 0.84, no: 0.16 }, confidence: 0.84, threshold: 0.6, cost: 0.0003, outcome: 'right', note: 'Question openers study → strategist pack' },
    { at: T('04', '09:04'), decision: 'research-relevant', kind: 'predicate', via: 'judge', answer: false, p: { yes: 0.32, no: 0.68 }, confidence: 0.68, threshold: 0.6, cost: 0.0003, outcome: null, note: 'TikTok duets finding dropped' },
    { at: T('04', '09:20'), decision: 'pack-areas', kind: 'choice', via: 'rule', answer: 'goal,strategy,learnings,branches', p: null, confidence: 1, threshold: null, cost: null, note: 'Strategist pack areas by rule' },
    { at: T('04', '11:00'), decision: 'slot-format', kind: 'choice', via: 'rule', answer: 'reel', p: { reel: 0.7, which3: 0.2, 'odd-one-out': 0.1 }, confidence: 1, threshold: null, cost: null, note: 'Slot 2026-11-05 → reel (strategy weights)' },
    { at: T('04', '11:02'), decision: 'explore-exploit', kind: 'choice', via: 'rule', answer: 'explore', p: { explore: 0.8, exploit: 0.2 }, confidence: 1, threshold: null, cost: null, note: 'No posteriors yet → explore hy:question' },
    { at: T('04', '11:05'), decision: 'hook-style', kind: 'choice', via: 'judge', answer: 'question', p: { question: 0.82, statement: 0.13, challenge: 0.05 }, confidence: 0.82, threshold: 0.6, cost: 0.0004, outcome: 'right', note: 'Slot 2026-11-05 · hy:question' },
    { at: T('04', '17:12'), decision: 'new-or-variant', kind: 'choice', via: 'judge', answer: 'variant of hy:question', p: { 'variant of hy:question': 0.88, new: 0.12 }, confidence: 0.88, threshold: 0.75, cost: 0.0005, outcome: 'right', note: 'Brief 12 filed as a variant → var:pkg-12' },
    { at: T('05', '07:23'), decision: 'brief-match', kind: 'score', via: 'judge', answer: 4.3, p: null, confidence: 0.86, threshold: 3, cost: 0.0011, outcome: 'right', note: 'Post 12 matches its brief · hy:question' },
    { at: T('05', '07:23'), decision: 'answer-unambiguous', kind: 'predicate', via: 'judge', answer: true, p: { yes: 0.93, no: 0.07 }, confidence: 0.93, threshold: 0.85, cost: 0.0009, outcome: 'right', note: 'Post 12 · one correct answer' },
    { at: T('05', '07:24'), decision: 'brand-rules', kind: 'predicate', via: 'rule', answer: true, p: null, confidence: 1, threshold: 0.8, cost: null, note: 'Post 12 · no banned claims' },
    { at: T('05', '07:24'), decision: 'visual-quality', kind: 'score', via: 'judge', answer: 4, p: null, confidence: 0.8, threshold: 4, cost: 0.0014, outcome: 'right', note: 'Post 12 first frame · hy:question' },
    { at: T('05', '07:24'), decision: 'ai-label', kind: 'predicate', via: 'rule', answer: true, p: null, confidence: 1, threshold: null, cost: null, note: 'Post 12 · AI label present' },
    { at: T('06', '19:40'), decision: 'file-branch', kind: 'choice', via: 'rule', answer: 'hy:question', p: null, confidence: 1, threshold: 0.7, cost: null, note: 'Metrics for post 12 → slot → hy:question' },
    { at: T('06', '19:41'), decision: 'comment-theme', kind: 'choice', via: 'judge', answer: 'answer guesses', p: { 'answer guesses': 0.77, praise: 0.15, other: 0.08 }, confidence: 0.77, threshold: 0.7, cost: 0.0002, note: 'Post 12 comments · hy:question' },
    { at: T('07', '07:28'), decision: 'visual-quality', kind: 'score', via: 'judge', answer: 2.5, p: null, confidence: 0.74, threshold: 4, cost: 0.0014, outcome: 'right', note: 'Post 14 first frame too dark → second draft · hy:statement' },
    { at: T('07', '19:12'), decision: 'significant-change', kind: 'predicate', via: 'rule', answer: false, p: null, confidence: null, threshold: null, cost: null, note: 'lr:hook-question · nEff 2.4 < 3 · hy:question' },
    { at: T('08', '06:50'), decision: 'hook-too-similar', kind: 'predicate', via: 'judge', answer: false, p: { yes: 0.31, no: 0.69 }, confidence: 0.69, threshold: 0.7, cost: 0.0003, outcome: 'right', note: '“Which 3 belong together?” vs last 20 hooks · hy:question' },
    { at: T('08', '06:52'), decision: 'similar-posts', kind: 'score', via: 'judge', answer: '12, 9, 4', p: null, confidence: 0.7, threshold: null, cost: 0.0016, note: 'Top 3 similar past posts for brief 15' },
    { at: T('08', '06:53'), decision: 'catalog-fit', kind: 'score', via: 'cache', answer: 'Kitchen, Tools, Garden', p: null, confidence: 0.7, threshold: null, cost: null, note: 'Catalog shortlist reused from brief 12' },
    { at: T('09', '20:01'), decision: 'comment-kind', kind: 'choice', via: 'judge', answer: 'question', p: { question: 0.91, praise: 0.04, complaint: 0.02, bug: 0.02, spam: 0.01 }, confidence: 0.91, threshold: 0.8, cost: 0.0002, outcome: 'right', note: '“Where can I play these?” · hy:question' },
    { at: T('09', '20:01'), decision: 'personal-data', kind: 'predicate', via: 'judge', answer: false, p: { yes: 0.02, no: 0.98 }, confidence: 0.98, threshold: 0.2, cost: 0.0002, note: 'Draft reply · none' },
    { at: T('10', '07:00'), decision: 'branch-status', kind: 'choice', via: 'rule', answer: 'promising', p: { promising: 0.71, exploring: 0.22, winning: 0.07 }, confidence: 0.71, threshold: null, cost: null, outcome: 'right', note: 'hy:question · nEff 4.8, interval excludes 1' },
    { at: T('10', '07:02'), decision: 'explore-exploit', kind: 'choice', via: 'rule', answer: 'exploit', p: { exploit: 0.78, explore: 0.22 }, confidence: 1, threshold: null, cost: null, note: 'Thompson draw → hy:question; this draw explores hy:beat' },
    { at: T('10', '07:03'), decision: 'best-time', kind: 'choice', via: 'rule', answer: '18:30', p: null, confidence: null, threshold: null, cost: null, note: 'From lr:time-1830 (too little data → default kept)' },
    { at: T('10', '08:16'), decision: 'prompt-injection', kind: 'predicate', via: 'judge', answer: false, p: { yes: 0.04, no: 0.96 }, confidence: 0.96, threshold: 0.3, cost: 0.0002, note: 'Your note · hy:question' },
    { at: T('11', '07:05'), decision: 'branch-status', kind: 'choice', via: 'rule', answer: 'weak', p: { weak: 0.62, exploring: 0.3, pruned: 0.08 }, confidence: 0.62, threshold: null, cost: null, outcome: 'right', note: 'hy:statement · saves ×0.78' },
    { at: T('11', '08:32'), decision: 'learning-valid', kind: 'predicate', via: 'cache', answer: true, p: { yes: 0.8, no: 0.2 }, confidence: 0.8, threshold: 0.6, cost: null, note: 'lr:hook-question still valid for Sint-Maarten reel', campaign: C2 },
    { at: T('11', '08:33'), decision: 'experiment-goal', kind: 'choice', via: 'judge', answer: 'awareness', p: { awareness: 0.74, engagement: 0.2, launch: 0.06 }, confidence: 0.74, threshold: 0.7, cost: 0.0004, note: 'hy:sint serves awareness', campaign: C2 },
    { at: T('12', '19:00'), decision: 'branch-status', kind: 'choice', via: 'rule', answer: 'weak', p: { weak: 0.58, promising: 0.3, exploring: 0.12 }, confidence: 0.58, threshold: null, cost: null, note: 'hy:sint · under Engagement; promising under Awareness', campaign: C2 },
    { at: T('12', '19:31'), decision: 'pivot-needed', kind: 'predicate', via: 'judge', answer: true, p: { yes: 0.86, no: 0.14 }, confidence: 0.86, threshold: 0.8, cost: 0.0021, outcome: 'right', note: 'Stats gate passed → proposal pv:1' },
    { at: T('12', '19:32'), decision: 'pivot-needed', kind: 'predicate', via: 'escalated', answer: null, p: null, confidence: null, threshold: 0.8, cost: null, note: 'Changes direction → you (pv:1)' },
    { at: T('13', '08:39'), decision: 'file-branch', kind: 'choice', via: 'judge', answer: 'hy:question', p: { 'hy:question': 0.84, 'hy:statement': 0.11, 'hy:trick': 0.05 }, confidence: 0.84, threshold: 0.7, cost: 0.0004, outcome: 'right', note: 'Edited brief 18 refiled → hy:question' },
    { at: T('14', '10:05'), decision: 'branch-status', kind: 'choice', via: 'rule', answer: 'pruned', p: { pruned: 0.66, weak: 0.34 }, confidence: 0.66, threshold: null, cost: null, note: 'hy:statement · interval excludes 1, nEff 3.4' },
    { at: T('16', '07:00'), decision: 'branch-status', kind: 'choice', via: 'rule', answer: 'winning', p: { winning: 0.84, promising: 0.16 }, confidence: 0.84, threshold: null, cost: null, note: 'hy:question · nEff 8.1' },
    { at: T('16', '08:02'), decision: 'hook-style', kind: 'choice', via: 'judge', answer: 'question', p: { question: 0.58, statement: 0.3, challenge: 0.12 }, confidence: 0.58, threshold: 0.6, cost: 0.0004, outcome: 'wrong', note: 'Below threshold → explore kept the question style · hy:beatsync' },
    { at: T('16', '08:49'), decision: 'brief-match', kind: 'score', via: 'judge', answer: 4.6, p: null, confidence: 0.88, threshold: 3, cost: 0.0011, note: 'Post 20 · hy:beatsync' },
    { at: T('18', '19:40'), decision: 'file-branch', kind: 'choice', via: 'cache', answer: 'hy:beatsync', p: { 'hy:beatsync': 0.9, 'hy:beat': 0.1 }, confidence: 0.9, threshold: 0.7, cost: null, note: 'Metrics for post 20 · hy:beatsync' },
  ];
  return rows.map((r, i) => ({
    id: `dc_${String(i + 1).padStart(3, '0')}`,
    at: r.at,
    project,
    campaign: r.campaign === undefined ? C1 : r.campaign,
    decision: r.decision,
    kind: r.kind,
    inputsHash: `sha256:${(0x9e3779b1 * (i + 7)).toString(16).padStart(8, '0').slice(-8)}…`,
    via: r.via,
    answer: r.answer,
    probabilities: r.p ?? null,
    confidence: r.confidence ?? null,
    threshold: r.threshold ?? null,
    judge: r.via === 'judge' ? JUDGE : null,
    costUsd: r.cost ?? null,
    outcome: r.outcome ?? null,
    note: r.note ?? null,
  }));
}

// ---- agent runs ----------------------------------------------------------------------------------
function buildRuns(project: string): AgentRunRecord[] {
  const R = (id: string, role: Role, startedAt: string, seconds: number | null, status: AgentRunRecord['status'], model: string, costUsd: number | null, turns: number | null, summary: string | null, error: string | null = null, campaign: string | null = C1): AgentRunRecord => ({
    id, role, project, campaign, startedAt, endedAt: seconds === null ? null : new Date(Date.parse(startedAt) + seconds * 1000).toISOString(), status, model, costUsd, turns, summary, error,
  });
  return [
    R('run_01', 'researcher', T('04', '08:10'), 94, 'done', 'claude-sonnet-4-5', 0.18, 7, 'Three findings with sources: puzzle Reels benchmark, question openers, Sint-Maarten timing.'),
    R('run_02', 'strategist', T('04', '09:05'), 212, 'done', 'claude-opus-4-1', 1.12, 9, "Let'sGrow v1: daily puzzle Reels; pillars 40/25/20/15; two experiments on hooks and posting time."),
    R('run_03', 'planner', T('04', '10:35'), 58, 'done', 'claude-sonnet-4-5', 0.41, 6, '10 slots from 5 to 18 Nov; first week explores every pillar once.'),
    R('run_04', 'reviewer', T('05', '07:22'), 36, 'done', 'claude-sonnet-4-5', 0.22, 4, 'Post 12 ready: brief match 4.3, answer unambiguous 0.93, visual 4/5.'),
    R('run_05', 'analyst', T('10', '07:05'), 121, 'done', 'claude-sonnet-4-5', 0.63, 8, 'Week 1: question hooks lead on saves (×1.6); Odd one out leads on comments; 18:30 looks better but too little data.'),
    R('run_06', 'lead', T('12', '19:00'), 341, 'done', 'claude-opus-4-1', 2.4, 14, 'Proposed pv:1 (move 10% Seasonal → Guess the link) with evidence links; next week keeps one seasonal slot.'),
    R('run_07', 'strategist', T('14', '08:55'), 198, 'done', 'claude-opus-4-1', 1.05, 9, "Let'sGrow v2: Guess the link 50%, Odd one out 25%, Music 25% with a beat-sync hook test."),
    R('run_09', 'researcher', T('14', '08:20'), 21, 'error', 'claude-sonnet-4-5', 0.06, 2, null, 'Web fetch blocked by the allow-list (example.org/trends).'),
    R('run_10', 'reviewer', T('16', '08:45'), 44, 'stopped-budget', 'claude-sonnet-4-5', 0.3, 5, 'Stopped at the $0.30 cap after two revision rounds on post 20; best draft kept.'),
    R('run_08', 'analyst', T('18', '20:00'), null, 'running', 'claude-sonnet-4-5', null, null, null),
  ];
}

export function demoPayload(project: { id: string; name: string; handle: string }): MemoryPayload {
  const events = buildEvents(project.id, EVENTS);
  const nodes = buildNodes(events);
  const learnings = buildLearnings();
  const decisions = buildDecisions(project.id);
  const runs = buildRuns(project.id);
  const judgeCostUsd = decisions.reduce((s, d) => s + (d.costUsd ?? 0), 0);
  const agentCostUsd = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  return {
    enabled: true,
    reason: '',
    project,
    campaigns: [
      { id: C1, name: "Let'sGrow", goal: 'engagement', status: 'active' },
      { id: C2, name: 'Sint-Maarten week', goal: 'awareness', status: 'done' },
    ],
    graph: { version: 1, project: project.id, nodes, updatedAt: '2026-11-18T20:00:00.000Z' },
    learnings,
    events: [...events].reverse(),
    decisions: [...decisions].reverse(),
    runs: [...runs].reverse(),
    stats: { events: events.length, decisions: decisions.length, judgeCostUsd: Math.round(judgeCostUsd * 10000) / 10000, agentCostUsd: Math.round(agentCostUsd * 100) / 100 },
  };
}
