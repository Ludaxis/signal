// Fonts (C4, rule "bundled files only"): every family in the render log is a
// bundled file (the pack's fonts, or the core pairing) with a matching sha256; a system fallback fails C4. The allowed
// list comes from the pack lock and the core font lock; this file names no font.
import { t } from '@/app/studio/copy/en';

export interface FontUse {
  family: string;
  sha256: string | null; // null = the renderer fell back to a system face
}

export interface FontsReport {
  ok: boolean;
  reasons: string[];
  families: string[];
}

export function fontsCheck(used: readonly FontUse[], allowed: readonly { family: string; sha256: string }[]): FontsReport {
  if (!used.length) return { ok: false, reasons: [t('check.fonts.none')], families: [] };
  const reasons: string[] = [];
  for (const u of used) {
    const ok = u.sha256 !== null && allowed.some((a) => a.family === u.family && a.sha256 === u.sha256);
    if (!ok) reasons.push(t('check.fonts.fallback', { family: u.family }));
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], families: [...new Set(used.map((u) => u.family))] };
}

/** Frame count: the video, the timeline and the master agree (the master within ±1 frame, T `mix.durationFrames`). */
export function frameCountCheck(f: { video: number | null; timeline: number | null; master: number | null }): { ok: boolean; measured: boolean; reason: string | null } {
  if (f.video === null || f.timeline === null) return { ok: false, measured: false, reason: null };
  if (f.video !== f.timeline) return { ok: false, measured: true, reason: t('check.frames.mismatch', { video: f.video, timeline: f.timeline }) };
  if (f.master !== null && Math.abs(f.master - f.video) > 1) return { ok: false, measured: true, reason: t('check.frames.audio', { audio: f.master, video: f.video }) };
  return { ok: true, measured: true, reason: null };
}
