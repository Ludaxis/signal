// CastLayer: the compiled characters of `Timeline.motion` drawn over their scene. A Tier A or C character is
// solved by the same pure solver the engine and the lint use (anim/solve.ts, the timeline's seed and tempo map)
// and drawn by CutoutCharacter; a Tier B character is its flat still (render/cast.ts `flatBox`). A new character's
// `enter` track (`settle`) fades and lifts it in. A character whose art the timeline does not carry is skipped.
import React, { useMemo } from 'react';
import { Img, staticFile } from 'remotion';
import type { CompiledCharacter } from '../../anim/compile';
import { prepareCharacter, type PreparedCharacter } from '../../anim/solve';
import { castAt, enterAt, flatBox } from '../cast';
import type { Timeline } from '../timeline';
import { CutoutCharacter } from './CutoutCharacter';

const served = (src: string) => (src.startsWith('data:') ? src : staticFile(src));

export const CastLayer: React.FC<{ timeline: Timeline; frame: number }> = ({ timeline, frame }) => {
  const { motion, characters } = timeline;
  const prepared = useMemo(() => {
    const m = new Map<CompiledCharacter, PreparedCharacter>();
    if (!motion || !characters) return m;
    for (const c of motion.characters) {
      const art = characters.cast.find((a) => a.charId === c.charId);
      if (!art?.rig) continue;
      try {
        m.set(c, prepareCharacter(art.rig, c, { seed: characters.seed, tempo: characters.tempo, library: art.library }));
      } catch {
        // a beat loop without a tempo map: the character is left out rather than failing the frame
      }
    }
    return m;
  }, [motion, characters]);
  const sources = useMemo(() => new Map((characters?.cast ?? []).map((a) => [a.charId, Object.fromEntries(Object.entries(a.sources ?? {}).map(([rel, src]) => [rel, served(src)]))])), [characters]);
  if (!characters) return null;
  return (
    <>
      {castAt(timeline, frame).map(({ c, art }) => {
        const enter = enterAt(timeline, c, frame);
        let body: React.ReactNode = null;
        if (art.rig) {
          const p = prepared.get(c);
          body = p ? <CutoutCharacter rig={art.rig} frame={p.at(frame)} sources={sources.get(c.charId) ?? {}} /> : null;
        } else if (art.still) {
          const b = flatBox(c, art.still, frame, characters.seed);
          body = (
            <Img
              data-layer="character"
              data-char={c.charId}
              data-tier="B"
              src={served(art.still.src)}
              style={{ position: 'absolute', left: b.left, top: b.top, width: b.width, height: b.height, maxWidth: 'none', transformOrigin: '50% 100%', transform: `scale(${2 - b.sy}, ${b.sy})` }}
            />
          );
        }
        if (!body) return null;
        return (
          <div key={`${c.charId}:${c.beatId}`} data-layer="cast" data-char={c.charId} style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: enter, transform: enter < 1 ? `translateY(${Math.round((1 - enter) * 60)}px)` : undefined }}>
            {body}
          </div>
        );
      })}
    </>
  );
};
