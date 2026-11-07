// The slice report: the filled report template written into the output folder by the local slice run
// (slice-run.test.ts). The template's blank fields ("Name", "Date", "Machine") are for the person who runs it; an
// automated run says so at the top.

export interface SliceRender {
  probe: { codec: string | null; pixelFormat: string | null; width: number; height: number; fps: number; audioCodec: string | null; sampleRate: number; frames: number };
  loudness: { integratedLufs: number; truePeakDbtp: number; lra?: number };
  mockShareMin: number;
  aiLabel: number[];
  renderTimings: Record<string, number>;
  bytes: number;
  sha256: string;
  fonts: string[];
}

export interface SliceReport {
  marking: string;
  date: string;
  command: string;
  host: { platform: string; arch: string; cpus: number; cpuModel: string | null; memoryGb: number; node: string };
  browser: string | null;
  langs: string[];
  timings: Record<string, number | string>;
  run: { id: string; status: string; pausedFor: string | null; spentUsd: number; steps: { nodeId: string; status: string; mode: string | null; seconds: number | null }[] } | null;
  renders: Record<string, SliceRender>;
  frames: { lang: string; name: string; frame: number; file: string; sha256: string; width: number; height: number }[];
  networkGuard: { what: string; at: string }[];
  results: Record<string, boolean>;
  notes: string[];
  /** The creative chain (step → executor version), the pacing marks, the character frames and the rows. */
  creative?: {
    executors: Record<string, string>;
    pacing: Record<string, { hookComplete: number | null; endCardFrames: number | null; violations: string[] }>;
    characters: { lang: string; what: string; frame: number; detail: string }[];
    rubric: Record<string, { criterion: string; evidence: string[]; note: string }[]>;
    music: string | null;
    sfx: Record<string, string>;
  };
}

const yes = (v: boolean | undefined) => (v === undefined ? 'not run' : v ? 'pass' : 'FAIL');
const sec = (ms: unknown) => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : 'not measured');

export function reportMarkdown(r: SliceReport): string {
  const L: string[] = [];
  L.push(`# Post maker slice run`, '');
  L.push(`**${r.marking}**`, '');
  L.push('Mock providers only: no paid call, no account, no post. A person who runs the same command fills in the section below.', '');
  L.push('## Run', '');
  L.push(`- Date (UTC): ${r.date}`);
  L.push(`- Command: \`${r.command}\``);
  L.push(`- Machine: ${r.host.platform} ${r.host.arch}, ${r.host.cpus} CPUs (${r.host.cpuModel ?? 'unknown'}), ${r.host.memoryGb} GB, Node ${r.host.node}`);
  L.push(`- Render browser: ${r.browser ?? "Remotion's own install"}`);
  L.push(`- Languages: ${r.langs.join(', ')}`);
  L.push(`- Run: ${r.run ? `${r.run.id}, ${r.run.status}${r.run.pausedFor ? ` · ${r.run.pausedFor}` : ''}, spent $${r.run.spentUsd.toFixed(2)}` : 'did not start'}`, '');
  L.push('## Person who ran it', '');
  L.push('- Name:', '- Date:', '- Machine:', '- Native reader for the frames:', '');
  L.push('## Results', '');
  L.push('| Id | Criterion | Result | Evidence |', '|---|---|---|---|');
  L.push(`| Proof | make-it with mock providers reaches Proof; every node mock; $0 | ${r.run ? yes(r.run.status === 'needs-you' && r.run.pausedFor === 'check' && r.run.spentUsd === 0 && r.run.steps.every((s) => s.mode === 'mock')) : 'not run'} | run.json, events.json |`);
  for (const lang of r.langs) {
    const x = r.renders[lang];
    const ev = x ? `${x.probe.width}×${x.probe.height}, ${x.probe.fps} fps, ${x.probe.frames} frames, ${x.probe.codec}/${x.probe.pixelFormat}, ${x.probe.audioCodec} ${x.probe.sampleRate} Hz; ${x.loudness.integratedLufs.toFixed(1)} LUFS, ${x.loudness.truePeakDbtp.toFixed(1)} dBTP` : 'no render';
    L.push(`| Format (${lang}) | 1080×1920, 30 fps, 900 ± 1 frames, H.264 yuv420p, AAC 48 kHz; −14 ± 1 LUFS; true peak ≤ −1.0 dBTP | ${yes(r.results[`format ${lang}`])} | ${ev}; loudness.json |`);
  }
  L.push(`| Persian frames | Persian frames at the hook word-pop, a chant card and the reveal; letters joined, right to left | awaiting a native reader | frames/fa-*.png (this run); goldens compared by the @render suite render-golden.test.ts |`);
  for (const lang of r.langs) {
    const x = r.renders[lang];
    L.push(`| Mock marks (${lang}) | MOCK on every frame; the AI label on the first and last frames | ${yes(r.results[`mock ${lang}`])} | ${x ? `MOCK band share min ${x.mockShareMin.toFixed(3)} over every frame; AI label ${x.aiLabel.map((v) => v.toFixed(2)).join(' / ')}` : 'no render'} |`);
  }
  L.push(`| Wall time | Wall time of make-it to Proof with two 30 s renders (target ≤ 8 min, measured not promised) | ${sec(r.timings.makeItToProofMs)} (${yes(r.results['wall time'])}) | stats.json |`);
  L.push(`| Network | No network attempt from the run's process | ${r.networkGuard.length === 0 ? 'pass (log empty)' : `FAIL (${r.networkGuard.length} attempts)`} | network-guard.json |`);
  const c = r.creative;
  if (c) {
    for (const lang of r.langs) {
      const p = c.pacing[lang];
      L.push(`| Pacing (${lang}) | Pacing lint clean: hook complete ≤ frame 60; end card 180-270 frames | ${yes(r.results[`pacing ${lang}`])} | ${p ? `hook complete at ${p.hookComplete ?? 'never'}, end card ${p.endCardFrames ?? '?'} frames${p.violations.length ? `; ${p.violations.join('; ')}` : ''}` : 'not measured'}; timeline.${lang}.json |`);
    }
    L.push(`| Loudness | The loudness target holds with the pack music and SFX in the mix | ${yes(r.langs.every((l) => r.results[`format ${l}`]))} | loudness.json; ${Object.entries(c.sfx).map(([l, t]) => `${l}: ${t}`).join('; ')} |`);
    L.push(`| Characters | Frame grabs show the character in breath/blink and a gesture at a word onset | ${yes(r.results['characters'])} | ${c.characters.map((x) => `${x.lang} ${x.what} @${x.frame} (${x.detail})`).join('; ')}; frames/*-char-*.png |`);
    L.push(`| Check rows | The check's C5 and C9 rows cite measurements (no "Not measured yet") | ${yes(r.results['rubric C5 C9'])} | score.json |`);
  }
  L.push('');
  L.push('## Renders', '');
  L.push('| Lang | sha256 | Bytes | Render timings |', '|---|---|---|---|');
  for (const [lang, x] of Object.entries(r.renders)) L.push(`| ${lang} | \`${x.sha256}\` | ${x.bytes} | ${Object.entries(x.renderTimings ?? {}).map(([k, v]) => `${k} ${sec(v)}`).join(', ')} |`);
  L.push('', 'The video, cover and frame files stay in this folder on the machine that made them; they are not committed (binary media).', '');
  L.push('## Frame grabs', '');
  L.push('| Lang | Point | Frame | File | sha256 |', '|---|---|---|---|---|');
  for (const f of r.frames) L.push(`| ${f.lang} | ${f.name} | ${f.frame} | ${f.file} | \`${f.sha256.slice(0, 16)}…\` |`);
  L.push('', '## Timings', '');
  for (const [k, v] of Object.entries(r.timings)) L.push(`- ${k}: ${typeof v === 'number' ? sec(v) : v}`);
  if (r.run) {
    L.push('', '## Steps', '', '| Step | Status | Mode | Seconds |', '|---|---|---|---|');
    for (const s of r.run.steps) L.push(`| ${s.nodeId} | ${s.status} | ${s.mode ?? ''} | ${s.seconds ?? ''} |`);
  }
  if (c) {
    L.push('', '## Creative chain', '');
    L.push('| Step | Executor |', '|---|---|');
    for (const [k, v] of Object.entries(c.executors)) L.push(`| ${k} | ${v} |`);
    L.push('', `- Music: ${c.music ?? 'not recorded'}`);
    for (const [lang, rows] of Object.entries(c.rubric)) for (const x of rows) L.push(`- ${lang} ${x.criterion}: ${x.evidence.join('; ') || 'no evidence'}${x.note ? ` (${x.note})` : ''}`);
  }
  L.push('', '## What this run does not show', '');
  L.push('- Persian pronunciation, live vendors, vendor lip-sync (its compositing is proven on a mock by lipsync-composite.test.ts), costs and the browser agent.');
  L.push('- The scores themselves: in mock mode no reviewer runs, so the verdict stays Unscored; the rows carry the measured evidence a reviewer or you score from.');
  L.push('- Art is the pack library only (background, the Tier A rig, a Tier B still); no Codex image was made and no sticker exists in the pack, so the plan records sticker requests that wait for a person.');
  for (const n of r.notes) L.push(`- ${n}`);
  L.push('');
  return L.join('\n');
}
