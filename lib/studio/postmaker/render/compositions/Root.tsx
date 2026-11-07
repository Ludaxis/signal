// Registers the Post maker compositions. Size and length come from the props (timeline.json / mixPlan.json).
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { MixPlan } from '../mixPlan';
import { MIX_TARGETS } from '../mixPlan';
import type { Timeline } from '../timeline';
import { AudioMaster, type AudioMasterProps } from './AudioMaster';
import { CharacterTest, type CharacterTestProps } from './CharacterTest';
import { StorySpine, type StorySpineProps } from './StorySpine';

const EMPTY_TIMELINE: Timeline = {
  schema: 'signal.pm.timeline/1',
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: 30,
  lang: 'en',
  layers: [],
  captions: [],
  coverFrame: 0,
  elements: [],
  audio: [],
  aiLabel: { text: 'AI', lang: 'en' },
  mock: true,
  fonts: [],
  palette: { background: '#F4EFE6', backgroundDark: '#16161D', text: '#16161D', accent: '#F2B705', plate: '#FFFFFF', cards: ['#E4572E'] },
  segments: [],
  cutFrames: [],
  grid: { bpm: 100, bf: 18, beats: [], chantBeatsPerCard: 2 },
  events: [],
  marks: { hookComplete: null, firstHookTokenOpaque: null },
};
const EMPTY_PLAN: MixPlan = { schema: 'signal.pm.mix-plan/1', durationFrames: 30, cues: [], voice: [], sfx: [], music: null, targets: MIX_TARGETS };

const spineMeta: CalculateMetadataFunction<StorySpineProps> = ({ props }) => ({ durationInFrames: Math.max(1, props.timeline.durationInFrames), fps: 30, width: props.timeline.width, height: props.timeline.height });
const characterMeta: CalculateMetadataFunction<CharacterTestProps> = ({ props }) => ({ durationInFrames: Math.max(1, props.spec.to), fps: 30, width: props.width, height: props.height });
const EMPTY_CHARACTER: CharacterTestProps = {
  rig: { format: 'cutout-rig/1', id: 'none', views: ['front'], unitPx: 1, parts: [], palette: [], turnaround: 'none' },
  sources: {},
  spec: { charId: 'none', from: 0, to: 30, place: { x: 0, y: 0, scale: 1 }, poses: [], gestures: [], loops: [] },
  seed: 1,
  tempo: null,
  background: '#F4EFE6',
  width: 1080,
  height: 1080,
};
const audioMeta: CalculateMetadataFunction<AudioMasterProps> = ({ props }) => ({ durationInFrames: Math.max(1, props.plan.durationFrames), fps: 30, width: 1080, height: 1920 });

export const PostmakerRoot: React.FC = () => (
  <>
    <Composition id="StorySpine" component={StorySpine} defaultProps={{ timeline: EMPTY_TIMELINE, master: null }} calculateMetadata={spineMeta} width={1080} height={1920} fps={30} durationInFrames={30} />
    <Composition id="CharacterTest" component={CharacterTest} defaultProps={EMPTY_CHARACTER} calculateMetadata={characterMeta} width={1080} height={1080} fps={30} durationInFrames={30} />
    <Composition id="AudioMaster" component={AudioMaster} defaultProps={{ plan: EMPTY_PLAN }} calculateMetadata={audioMeta} width={1080} height={1920} fps={30} durationInFrames={30} />
  </>
);
