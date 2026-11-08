// `CharacterTest`: one character on a flat background, for the @render goldens and the pivot-integrity frame check
// (quality bar acceptance 2). It solves the frame in the bundle with the same pure solver the engine uses,
// so a golden frame and a solved frame agree. Not a post composition: it never carries captions, audio or a label.
import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { prepareCharacter } from '../../anim/solve';
import type { CharacterLibrary, CharacterSpec, CutoutRig, TempoMap } from '../../anim/types';
import { CutoutCharacter } from '../components/CutoutCharacter';

export interface CharacterTestProps extends Record<string, unknown> {
  rig: CutoutRig;
  sources: Record<string, string>;
  spec: CharacterSpec;
  seed: number;
  tempo: TempoMap | null;
  library?: CharacterLibrary;
  background: string;
  width: number;
  height: number;
}

export const CharacterTest: React.FC<CharacterTestProps> = ({ rig, sources, spec, seed, tempo, library, background }) => {
  const frame = useCurrentFrame();
  const prepared = useMemo(() => prepareCharacter(rig, spec, { seed, tempo, library }), [rig, spec, seed, tempo, library]);
  return (
    <AbsoluteFill style={{ background }}>
      <CutoutCharacter rig={rig} frame={prepared.at(frame)} sources={sources} />
    </AbsoluteFill>
  );
};
