// CutoutCharacter (quality bar): draws one solved frame of a `cutout-rig/1` character. The solver composes the
// nested transforms (parent · anchor · offset · rotation · scale · −pivot) into one matrix per part, so the parts are
// drawn flat in the rig's draw order (`z`) and a child may sit behind its parent's siblings (a far arm behind the
// torso). Eye, mouth and hand states arrive as the file each part shows this frame; pupils hide while the eyes are
// closed. Sources map a rig file to a URL the bundle can load (a served path or a data URI).
import React from 'react';
import { Img } from 'remotion';
import type { CutoutRig, SolvedFrame } from '../../anim/types';

export interface CutoutCharacterProps {
  rig: CutoutRig;
  frame: SolvedFrame;
  sources: Record<string, string>;
}

export const CutoutCharacter: React.FC<CutoutCharacterProps> = ({ rig, frame, sources }) => {
  const size = new Map(rig.parts.filter((p) => p.view === frame.view).map((p) => [p.name, p.size ?? [0, 0]]));
  return (
    <div data-layer="character" data-char={frame.charId} data-view={frame.view} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {frame.parts.map((p) => {
        if (!p.file || !sources[p.file]) return null;
        const [w, h] = size.get(p.name) ?? [0, 0];
        return (
          <Img
            key={p.name}
            data-part={p.name}
            data-state={p.state ?? undefined}
            src={sources[p.file]!}
            style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, maxWidth: 'none', transformOrigin: '0 0', transform: `matrix(${p.matrix.join(',')})` }}
          />
        );
      })}
      {frame.finger ? <div data-part="finger" style={{ position: 'absolute', left: frame.finger.x - 22, top: frame.finger.y - 22, width: 44, height: 44, borderRadius: 22, background: '#FFFFFF', border: '6px solid #1E1B2E', boxSizing: 'border-box' }} /> : null}
    </div>
  );
};
