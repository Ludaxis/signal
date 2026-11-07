// AI disclosure and provenance (C11): the on-video AI label is present on the first and the
// last frame (and every measured frame) inside the text rectangle; the post's AI flag agrees with the provenance (any
// AI-generated layer ⇒ flag on); every asset has a complete licence record; every synthetic voice has a consent or
// design reference. Label wording is the project's; this check only sees presence and position.
import { t } from '@/app/studio/copy/en';
import type { AssetLicence } from '../types';
import type { Box } from './safeZoneReport';

export interface LabelFrame {
  frame: number;
  present: boolean;
  box?: Box;
}

export interface AiLabelInput {
  totalFrames: number;
  frames: LabelFrame[];
  /** The text rectangle the label must sit inside (from safeZones.ts); omitted = position not checked. */
  textRect?: Box;
  /** The post's AI flag (post-copy `meta.aiGenerated`). */
  metaFlag: boolean | null;
  /** Did any layer come from an AI generator or a synthetic voice (provenance)? */
  aiUsed: boolean | null;
}

export interface AiLabelReport {
  ok: boolean;
  reasons: string[];
}

const inside = (b: Box, r: Box) => b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;

export function aiLabelCheck(i: AiLabelInput): AiLabelReport {
  const reasons: string[] = [];
  const at = new Map(i.frames.map((f) => [f.frame, f]));
  const needed = [0, Math.max(0, i.totalFrames - 1)];
  for (const f of needed) if (!at.get(f)?.present) reasons.push(t('check.aiLabel.missing', { frame: f }));
  for (const f of i.frames) {
    if (needed.includes(f.frame)) continue;
    if (!f.present) reasons.push(t('check.aiLabel.missing', { frame: f.frame }));
  }
  if (i.textRect)
    for (const f of i.frames) if (f.present && f.box && !inside(f.box, i.textRect)) reasons.push(t('check.aiLabel.outside', { frame: f.frame }));
  if (i.aiUsed === null || i.metaFlag === null || (i.aiUsed && !i.metaFlag)) reasons.push(t('check.aiLabel.flag'));
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export interface ProvenanceAsset {
  id: string;
  kind: string;
  licence: Partial<AssetLicence> | null;
}

/** Asset ids whose licence record is incomplete (C11 = 3 or lower), and synthetic voices without consent or design. */
export function provenanceGaps(assets: readonly ProvenanceAsset[]): string[] {
  const gaps: string[] = [];
  for (const a of assets) {
    const l = a.licence;
    const complete = !!l && !!l.type && !!l.holder && !!l.source && !!l.acquiredAt && Array.isArray(l.allowedUses) && l.allowedUses.length > 0 && typeof l.aiGenerated === 'boolean';
    if (!complete) gaps.push(a.id);
    else if (a.kind === 'voice' && !l!.consentRef) gaps.push(a.id);
  }
  return gaps;
}
