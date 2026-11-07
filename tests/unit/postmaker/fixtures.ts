// Synthetic fixtures for the Post maker store tests. Every name here is invented; no project, brand or person.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Asset, StepVersionDraft, VoiceProfile } from '@/lib/studio/postmaker/types';

export const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const PROJECT = { id: 'example-project', contentDir: '', timeZone: 'Europe/Berlin' };

export function versionDraft(recipeId: string, nodeId: string, o: Partial<StepVersionDraft> = {}): StepVersionDraft {
  const kind = nodeId.split(/[:#]/)[0];
  return {
    recipeId,
    nodeId,
    createdAt: '2026-11-06T10:00:00.000Z',
    source: 'run',
    runId: null,
    key: sha(`${recipeId}/${nodeId}/${JSON.stringify(o.params ?? {})}`),
    implVersion: `${kind}@1`,
    inputs: [],
    packRefs: [],
    params: {},
    outputs: [],
    provides: {},
    checks: [],
    provenance: { executor: 'local', connector: 'mock', mode: 'mock', model: null, tool: null, requests: [], seed: 1, prompt: null, startedAt: '2026-11-06T10:00:00.000Z', endedAt: '2026-11-06T10:00:01.000Z', by: 'signal-postmaker' },
    cost: { actualUsd: 0, upperBoundUsd: 0 },
    seconds: 1,
    mode: 'mock',
    note: null,
    editedByUser: false,
    status: 'ok',
    signoffs: [],
    ...o,
  };
}

const licence = (o: Partial<Asset['licence']> = {}): Asset['licence'] => ({
  type: 'owned',
  holder: 'Example Studio',
  source: 'internal',
  author: null,
  acquiredAt: '2026-01-01',
  proof: null,
  allowedUses: ['organic', 'paid-ads'],
  territories: 'worldwide',
  expiresAt: null,
  attribution: null,
  aiGenerated: false,
  ...o,
});

export interface FixturePack {
  dir: string;
  write: (rel: string, data: string | Buffer) => void;
  assets: Asset[];
  voices: VoiceProfile[];
  manifest: Record<string, unknown>;
  writeLibrary: () => void;
  writeManifest: () => void;
}

/** Writes a small synthetic pack: 2 assets, 2 voices, a fa lexicon, a glossary, a style guide, a font, a template. */
export function writeFixturePack(dir: string, o: { requires?: string } = {}): FixturePack {
  const write = (rel: string, data: string | Buffer) => {
    const f = path.join(dir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, data);
  };
  const bg = Buffer.from('synthetic background bytes');
  const sticker = Buffer.from('synthetic sticker bytes');
  write('library/backgrounds/bg-room-01.png', bg);
  write('library/stickers/st-star-01.png', sticker);
  const font = Buffer.from('synthetic font bytes');
  write('library/fonts/example-sans/ExampleSans.ttf', font);
  write('library/fonts/example-sans/OFL.txt', 'SIL Open Font License 1.1 (synthetic fixture)');
  write('lexicon/fa.json', JSON.stringify([{ id: 'lx-001', kind: 'brand', status: 'proposed' }]));
  write('glossary.json', JSON.stringify([{ id: 'gl-001' }]));
  write('style/fa.md', '---\nfaAddress: to\n---\n# House style (synthetic)\n');
  write('templates/story-basic.json', JSON.stringify({ id: 'story-basic' }));
  write('brand/brand.json', JSON.stringify({ name: 'Example' }));
  const assets: Asset[] = [
    { id: 'bg-room-01', kind: 'background', file: 'backgrounds/bg-room-01.png', sha256: sha(bg), tags: ['room'], licence: licence(), status: 'approved', approvedBy: 'Reviewer A' },
    { id: 'st-star-01', kind: 'sticker', file: 'stickers/st-star-01.png', sha256: sha(sticker), tags: ['star'], licence: licence({ type: 'ai-generated', aiGenerated: true }), status: 'draft', approvedBy: null },
  ];
  const projection = { diacritics: 'homographs', ezafe: 'kasra', conjO: true, zwnj: 'keep', ipaInline: false, lockedBy: null, lockedAt: null, testId: null } as const;
  const voices: VoiceProfile[] = [
    { id: 'narrator-fa', lang: 'fa', speaker: 'narrator', connector: 'mock', model: 'mock-tts-1', voiceId: 'mock-voice-fa', settings: { stability: 0.5 }, consentRef: null, approvedBy: null, projection: { ...projection }, measuredRate: null },
    { id: 'narrator-en', lang: 'en', speaker: 'narrator', connector: 'mock', model: 'mock-tts-1', voiceId: 'mock-voice-en', settings: {}, consentRef: null, approvedBy: null, projection: null, measuredRate: null },
  ];
  const manifest: Record<string, unknown> = {
    schema: 'signal.pack/1',
    id: 'example-pack',
    version: '1.0.0',
    name: 'Example pack',
    languages: ['fa', 'en'],
    brand: 'brand/brand.json',
    library: 'library/library.json',
    fonts: [{ family: 'Example Sans', file: 'library/fonts/example-sans/ExampleSans.ttf', sha256: sha(font), licence: 'library/fonts/example-sans/OFL.txt', scripts: ['latin'], weights: [400] }],
    voices: 'voices.json',
    lexicon: { fa: 'lexicon/fa.json' },
    glossary: 'glossary.json',
    style: { fa: 'style/fa.md' },
    templates: ['templates/story-basic.json'],
    claims: { allowed: [], denied: ['free'] },
    musicPolicy: { sources: ['library', 'owner-upload'], attribution: false },
    rigTier: { 'char-host': 'B' },
    requires: { signal: o.requires ?? '>=2.0.0 <3' },
  };
  const p: FixturePack = {
    dir,
    write,
    assets,
    voices,
    manifest,
    writeLibrary: () => write('library/library.json', JSON.stringify(p.assets, null, 2)),
    writeManifest: () => write('pack.json', JSON.stringify(p.manifest, null, 2)),
  };
  write('voices.json', JSON.stringify(voices, null, 2));
  p.writeLibrary();
  p.writeManifest();
  return p;
}
