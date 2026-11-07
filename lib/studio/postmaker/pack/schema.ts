// zod schemas for the project pack. Paths inside a pack are relative,
// forward-slash, with no `..`, no absolute prefix and no control characters; load.ts also re-checks every resolved path
// against the pack folder (symlinks included).
import { z } from 'zod';
import { LANGS } from '../types';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const ISO = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Use an ISO date.');

/** A safe relative path: segments of letters, digits, `._-` and spaces; no `.`/`..` segments. */
export const relPath = z
  .string()
  .min(1)
  .max(240)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !/[\u0000-\u001f]/.test(p), 'Use a path inside the pack.')
  .refine((p) => p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && /^[A-Za-z0-9._ -]+$/.test(seg)), 'Use a path inside the pack.');

export const langSchema = z.enum(LANGS);

export const packFontSchema = z.object({
  family: z.string().min(1).max(80),
  file: relPath,
  sha256: z.string().regex(SHA),
  licence: relPath,
  scripts: z.array(z.enum(['latin', 'arabic'])).min(1),
  weights: z.array(z.number().int().min(100).max(1000)).min(1),
});

export const packManifestSchema = z.object({
  schema: z.literal('signal.pack/1'),
  id: z.string().regex(SLUG),
  version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/),
  name: z.string().min(1).max(120),
  languages: z.array(langSchema).min(1),
  brand: relPath.nullable(),
  library: relPath,
  fonts: z.array(packFontSchema),
  voices: relPath,
  lexicon: z.partialRecord(langSchema, relPath),
  glossary: relPath.nullable(),
  style: z.partialRecord(langSchema, relPath),
  templates: z.array(relPath.refine((p) => /^templates\/[a-z0-9][a-z0-9-]{0,63}\.json$/.test(p), 'Templates live in templates/<id>.json.')),
  claims: z.object({ allowed: z.array(z.string().max(120)), denied: z.array(z.string().max(120)) }),
  musicPolicy: z.object({ sources: z.array(z.enum(['library', 'owner-upload', 'elevenlabs-music', 'browser-agent', 'none'])), attribution: z.boolean() }),
  rigTier: z.record(z.string().regex(ASSET_ID), z.enum(['A', 'B', 'C'])),
  requires: z.object({ signal: z.string().min(1).max(200) }),
});

export const assetLicenceSchema = z.object({
  type: z.enum(['owned', 'commissioned', 'ofl-1.1', 'cc-by-4.0', 'cc0', 'stock', 'ai-generated', 'vendor-output']),
  holder: z.string().min(1),
  source: z.string().min(1),
  author: z.string().nullable(),
  acquiredAt: ISO,
  proof: z.string().nullable(),
  // Missing or empty `allowedUses` is caught by the resolver with its own code, so it is optional here.
  allowedUses: z.array(z.enum(['organic', 'paid-ads', 'store-listing'])).optional(),
  territories: z.union([z.array(z.string()), z.literal('worldwide')]),
  expiresAt: ISO.nullable(),
  attribution: z.string().nullable(),
  aiGenerated: z.boolean(),
  vendor: z.object({ name: z.string(), model: z.string(), requestId: z.string(), promptRef: z.string(), c2pa: z.boolean() }).optional(),
  consentRef: z.string().nullable().optional(),
});

export const assetSchema = z.object({
  id: z.string().regex(ASSET_ID),
  kind: z.enum(['character', 'prop', 'background', 'sticker', 'ui', 'font', 'sfx', 'music', 'voice', 'broll']),
  file: relPath,
  sha256: z.string().regex(SHA),
  dims: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }).optional(),
  durationMs: z.number().nonnegative().optional(),
  tags: z.array(z.string().max(40)),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  licence: assetLicenceSchema,
  status: z.enum(['draft', 'approved', 'retired']),
  approvedBy: z.string().nullable(),
});
export const librarySchema = z.array(assetSchema);

export const voiceProjectionSchema = z.object({
  diacritics: z.enum(['all', 'homographs', 'none']),
  ezafe: z.enum(['kasra', 'display']),
  conjO: z.boolean(),
  zwnj: z.enum(['keep', 'space']),
  ipaInline: z.boolean(),
  lockedBy: z.string().nullable(),
  lockedAt: ISO.nullable(),
  testId: z.string().nullable(),
});

/** Voice fields + the Persian projection nested under `projection` + `measuredRate`. */
export const voiceProfileSchema = z
  .object({
    id: z.string().regex(SLUG),
    lang: langSchema,
    speaker: z.string().regex(SLUG),
    connector: z.enum(['elevenlabs', 'azure-speech', 'mock']),
    model: z.string().min(1, 'Pin the voice model; the vendor default is never used.'),
    voiceId: z.string().min(1),
    settings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    consentRef: z.string().nullable(),
    approvedBy: z.string().nullable(),
    projection: voiceProjectionSchema.nullable(),
    measuredRate: z.object({ wordsPerSec: z.number().positive(), syllablesPerSec: z.number().positive(), sampleLines: z.number().int().positive() }).nullable(),
  })
  .refine((v) => v.lang !== 'fa' || v.projection !== null, { message: 'A Persian voice needs its projection settings.', path: ['projection'] });
export const voicesSchema = z.array(voiceProfileSchema);

/** Formats the first zod issue as one short line naming the field. */
export function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Not valid.';
  const where = i.path.length ? i.path.join('.') : 'value';
  return `${where}: ${i.message}`;
}
