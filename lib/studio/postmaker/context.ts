// Context assembly for agent-executed nodes: one ContextBundle, built by code, never by the model.
// Upstream JSON is passed verbatim up to 40,000 characters per artifact; larger artifacts get a deterministic
// projection (a script keeps its beats and only this node's language lines). The whole bundle stays within 120,000
// characters: over budget, the builder drops `history`, then `neighbours.after`, then shortens `pack.style` to its
// headings, in that order, and reports what it cut (the runner logs `context.truncated`). Two further steps run only
// if those three are not enough, so the budget always holds: upstream data is replaced by summaries (largest first),
// then the untrusted reference text is cut. User notes and reference text always sit under `untrusted`.
import { hashJson } from './store/objects';
import type { ContextBundle, Lang } from './types';

export const CONTEXT_BUDGET = 120_000;
export const UPSTREAM_VERBATIM = 40_000;

export type Truncation = 'history' | 'neighbours.after' | 'pack.style' | 'upstream' | 'untrusted.referenceText';

const size = (v: unknown) => JSON.stringify(v ?? null).length;

/** A deterministic summary that never grows with the artifact. */
export function summarise(data: unknown): unknown {
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort() : [];
  return { projected: 'summary', keys, chars: size(data), sha256: hashJson(data ?? null) };
}

/** The projection of a large upstream artifact (verbatim when it fits). */
export function projectUpstream(data: unknown, lang: Lang | null): unknown {
  if (size(data) <= UPSTREAM_VERBATIM) return data;
  const d = data as { beats?: unknown[]; lines?: unknown[] } | null;
  if (d && typeof d === 'object' && Array.isArray(d.beats) && Array.isArray(d.lines)) {
    const beats = d.beats.map((b) => {
      const x = b as { id?: string; segment?: string; targetMs?: number; onScreen?: Record<string, string> };
      return { id: x.id, segment: x.segment, targetMs: x.targetMs, ...(lang && x.onScreen ? { onScreen: { [lang]: x.onScreen[lang] } } : {}) };
    });
    const lines = d.lines
      .map((l) => l as { id?: string; beatId?: string; speaker?: string; langs?: string[] } & Record<string, unknown>)
      .filter((l) => !lang || !l.langs || l.langs.includes(lang))
      .map((l) => ({ id: l.id, beatId: l.beatId, speaker: l.speaker, ...(lang && l[lang] ? { [lang]: l[lang] } : {}) }));
    const projected = { projected: 'beats-and-own-lines', beats, lines };
    if (size(projected) <= UPSTREAM_VERBATIM) return projected;
  }
  return summarise(data);
}

const headings = (md: string) =>
  md
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .join('\n');

export interface ContextInput extends Omit<ContextBundle, 'upstream'> {
  upstream: (Omit<ContextBundle['upstream'][number], 'data'> & { data: unknown })[];
}

export function buildContext(input: ContextInput, budget = CONTEXT_BUDGET): { bundle: ContextBundle; truncated: Truncation[]; chars: number } {
  const lang = input.node.lang;
  const bundle: ContextBundle = {
    ...input,
    upstream: input.upstream.map((u) => ({ ...u, data: u.data === null || u.data === undefined ? null : projectUpstream(u.data, lang) })),
    neighbours: input.neighbours ? input.neighbours.map((n) => ({ ...n })) : null,
    pack: { ...input.pack },
    untrusted: { ...input.untrusted },
    history: [...input.history],
  };
  const truncated: Truncation[] = [];
  const over = () => size(bundle) > budget;
  if (over() && bundle.history.length) {
    bundle.history = [];
    truncated.push('history');
  }
  if (over() && bundle.neighbours?.some((n) => n.after !== null && n.after !== undefined && n.after !== '')) {
    bundle.neighbours = bundle.neighbours.map((n) => ({ ...n, after: null }));
    truncated.push('neighbours.after');
  }
  if (over() && bundle.pack.style) {
    bundle.pack.style = headings(bundle.pack.style);
    truncated.push('pack.style');
  }
  if (over()) {
    const order = bundle.upstream.map((u, i) => [i, size(u.data)] as const).sort((a, b) => b[1] - a[1]);
    for (const [i] of order) {
      if (!over()) break;
      const u = bundle.upstream[i]!;
      if (u.data !== null) {
        u.data = summarise(u.data);
        if (!truncated.includes('upstream')) truncated.push('upstream');
      }
    }
  }
  while (over() && bundle.untrusted.referenceText) {
    const excess = size(bundle) - budget;
    bundle.untrusted.referenceText = bundle.untrusted.referenceText.slice(0, Math.max(0, bundle.untrusted.referenceText.length - excess - 16));
    if (!truncated.includes('untrusted.referenceText')) truncated.push('untrusted.referenceText');
  }
  return { bundle, truncated, chars: size(bundle) };
}
