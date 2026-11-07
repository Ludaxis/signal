// Loads the timeline's faces from the bundle (staticFile, bundled files only) and holds the render until every face
// and document.fonts.ready resolve (quality: highlight boxes come from the laid-out DOM after fonts load).
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';
import type { TimelineFont } from '../timeline';

const started = new Set<string>();

export function loadTimelineFonts(fonts: TimelineFont[]): void {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  const todo = fonts.filter((f) => !started.has(`${f.family}#${f.sha256}`));
  if (!todo.length) return;
  for (const f of todo) started.add(`${f.family}#${f.sha256}`);
  const handle = delayRender(`Loading ${todo.map((f) => f.family).join(', ')}`);
  Promise.all(
    todo.map((f) => new FontFace(f.family, `url(${staticFile(f.src)}) format('woff2')`, { weight: f.weights, style: 'normal' }).load()),
  )
    .then((faces) => {
      for (const face of faces) document.fonts.add(face);
      return document.fonts.ready;
    })
    .then(() => continueRender(handle))
    .catch((err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))));
}

export function facesOf(fonts: TimelineFont[]): { text: string; display: string; latin: string } {
  const by = (role: TimelineFont['role']) => fonts.find((f) => f.role === role)?.family;
  const text = by('text') ?? 'serif';
  return { text, display: by('display') ?? text, latin: by('latin') ?? text };
}
