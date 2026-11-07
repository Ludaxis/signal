// `AudioMaster`: the audio-only mix rendered by Remotion (codec wav) from mixPlan.json:
// narration clips at their gains, the music bed with its ducking curve, SFX at their gains. ffmpeg then applies the
// two-pass loudnorm (the only ffmpeg step besides transcode).
import React from 'react';
import { AbsoluteFill, Html5Audio, Sequence, staticFile } from 'remotion';
import { dbToGain, gainAt, type MixPlan } from '../mixPlan';

export interface AudioMasterProps extends Record<string, unknown> {
  plan: MixPlan;
}

export const AudioMaster: React.FC<AudioMasterProps> = ({ plan }) => (
  <AbsoluteFill style={{ background: '#000000' }}>
    {plan.music?.src ? <Html5Audio src={staticFile(plan.music.src)} volume={(f: number) => gainAt(plan.music!.curve, f) * dbToGain(plan.music!.gainDb)} /> : null}
    {[...plan.voice, ...plan.sfx].map((c) => (
      <Sequence key={c.id} from={c.from} durationInFrames={Math.max(1, c.frames)} layout="none">
        <Html5Audio src={staticFile(c.src)} volume={dbToGain(c.gainDb)} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
