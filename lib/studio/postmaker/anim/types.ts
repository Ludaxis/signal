// The cut-out animation system's vocabulary (quality bar -, roles-animator-motion): part names, states,
// pose, gesture and loop ids, and the shapes the solver reads and writes. Pure module: no runtime imports, so the
// render bundle (CutoutCharacter) can import it next to solve.ts. Packs may override the keys of a core id per
// character; they never add ids (roles).
import type { CurveId } from '../render/curves';

export const RIG_FORMAT = 'cutout-rig/1' as const;

export const VIEWS = ['front', 'three-quarter-L', 'three-quarter-R', 'profile-L', 'profile-R'] as const;
export type ViewId = (typeof VIEWS)[number];
/** Every rig has at least these views. */
export const REQUIRED_VIEWS: readonly ViewId[] = ['front', 'three-quarter-L'];

export const HEAD_PARTS = ['head', 'hair_back', 'hair_front', 'ear_L', 'ear_R'] as const;
export const FACE_PARTS = ['brow_L', 'brow_R', 'eye_L', 'eye_R', 'pupil_L', 'pupil_R', 'lid_L', 'lid_R', 'mouth', 'nose'] as const;
export const OPTIONAL_PARTS = ['cheek_L', 'cheek_R'] as const;
export const BODY_PARTS = ['neck', 'torso', 'hip'] as const;
export const ARM_PARTS = ['arm_upper_L', 'arm_upper_R', 'arm_lower_L', 'arm_lower_R', 'hand_L', 'hand_R'] as const;
export const LEG_PARTS = ['leg_upper_L', 'leg_upper_R', 'leg_lower_L', 'leg_lower_R', 'foot_L', 'foot_R'] as const;
/** Slots carry no art of their own: a prop or accessory attaches to them. */
export const SLOT_PARTS = ['prop_hand_L', 'prop_hand_R', 'accessory_head', 'accessory_body'] as const;

export const REQUIRED_PARTS = [...HEAD_PARTS, ...FACE_PARTS, ...BODY_PARTS, ...ARM_PARTS, ...LEG_PARTS, ...SLOT_PARTS] as const;
export const KNOWN_PARTS: readonly string[] = [...REQUIRED_PARTS, ...OPTIONAL_PARTS];
export type PartName = (typeof REQUIRED_PARTS)[number] | (typeof OPTIONAL_PARTS)[number];

export const ROOT_PART = 'hip';

export const EYE_STATES = ['open', 'half', 'closed', 'happy', 'wide'] as const;
export type EyeState = (typeof EYE_STATES)[number];
/** Lids follow the eye channel when they carry the matching state. */
export const LID_STATES = ['open', 'half', 'closed'] as const;
export const VISEMES = ['X', 'A', 'E', 'O', 'U', 'M', 'F', 'L'] as const;
export type VisemeId = (typeof VISEMES)[number];
export const EXPRESSION_MOUTHS = ['smile', 'grin', 'frown', 'shock'] as const;
export const MOUTH_STATES = [...VISEMES, ...EXPRESSION_MOUTHS] as const;
export type MouthState = (typeof MOUTH_STATES)[number];
export const HAND_SHAPES = ['open', 'fist', 'point', 'wave', 'hold', 'thumb', 'peace'] as const;
export type HandShape = (typeof HAND_SHAPES)[number];
export type Side = 'L' | 'R';

/** Required state sets per part (validateRig, acceptance 1). */
export const REQUIRED_STATES: Record<string, readonly string[]> = {
  eye_L: EYE_STATES,
  eye_R: EYE_STATES,
  mouth: MOUTH_STATES,
  hand_L: HAND_SHAPES,
  hand_R: HAND_SHAPES,
};

export const POSE_IDS = ['neutral', 'happy', 'laugh', 'surprised', 'shocked', 'sulk', 'bored', 'point-screen', 'hold-phone', 'look-phone', 'cheer', 'shrug', 'facepalm', 'hands-hips', 'dance-A', 'dance-B'] as const;
export type PoseId = (typeof POSE_IDS)[number];
export const GESTURE_IDS = ['wave', 'nod', 'shake', 'point', 'clap', 'jump', 'gasp', 'swipe'] as const;
export type GestureId = (typeof GESTURE_IDS)[number];
export const LOOP_IDS = ['breath', 'blink', 'sway', 'bounce-beat', 'dance-A', 'dance-B', 'crowd'] as const;
export type AnimLoopId = (typeof LOOP_IDS)[number];

// ---- the rig ------------------------------------------------------------------------------------------------------

export interface RigPart {
  name: string;
  view: ViewId;
  /** Relative to the character folder. Slots may have none. */
  file?: string;
  states?: Record<string, string>;
  parent: string | null;
  /** Part-local px, where the part rotates. */
  pivot: [number, number];
  /** Parent-local px, where the pivot attaches. */
  anchor: [number, number];
  z: number;
  limits?: { rot?: [number, number] };
  /** Part size in px (width, height); read from the file when absent. */
  size?: [number, number];
}

export interface CutoutRig {
  format: typeof RIG_FORMAT;
  id: string;
  views: ViewId[];
  unitPx: number;
  parts: RigPart[];
  palette: string[];
  turnaround: string;
}

// ---- channels, keys, library ----------------------------------------------------------------------------------------

export type Channel = 'rot' | 'x' | 'y' | 'sx' | 'sy';
export const CHANNELS: readonly Channel[] = ['rot', 'x', 'y', 'sx', 'sy'];

/** A part's values in a pose: offsets from the rest drawing (rot in degrees, x/y in part px), scale multipliers. */
export interface PartKeys {
  rot?: number;
  x?: number;
  y?: number;
  sx?: number;
  sy?: number;
  state?: string;
}

export interface PoseDef {
  parts: Record<string, PartKeys>;
}

export type KeyCurve = CurveId | 'hold';

/** A gesture key: the value a part channel reaches at `frame`, eased from the previous key by `curve`. */
export interface GestureKey {
  frame: number;
  part: string;
  prop: Channel | 'state';
  value: number | string;
  curve: KeyCurve;
}

export interface GestureDef {
  /** Clip length (per clap for `clap`; computed from the path for `swipe`). */
  frames: number;
  keys: GestureKey[];
  /** Keep the last values after the clip until the next pose key (point, gasp). */
  holdEnd?: boolean;
  /** Contact frame (clap: the hands meet here, on the beat; an SFX cue fires). */
  contactFrame?: number;
}

export interface CharacterLibrary {
  poses: Record<PoseId, PoseDef>;
  gestures: Record<GestureId, GestureDef>;
}

// ---- what the solver is asked to play ------------------------------------------------------------------------------

export interface TempoMap {
  bpm: number;
  /** Frame of the first downbeat (may be fractional; beat frames are rounded). */
  firstDownbeatFrame: number;
  beatsPerBar: 3 | 4;
  fps?: number;
}

export interface SwipeTarget {
  id: string;
  x: number;
  y: number;
}

export interface CharacterSpec {
  charId: string;
  /** First visible frame and the exclusive end frame (absolute). */
  from: number;
  to: number;
  /** Where the root (`hip` pivot) sits in canvas px and the scale of one rig px. */
  place: { x: number; y: number; scale: number };
  view?: ViewId;
  /** View turns: the swap is hidden in a 2-frame head turn ending at `at`. */
  views?: { view: ViewId; at: number }[];
  poses: { pose: PoseId; at: number }[];
  gestures: { gesture: GestureId; at: number; side?: Side; count?: number; targets?: SwipeTarget[]; speedPxPerSec?: number }[];
  loops: AnimLoopId[];
  eyes?: { state: EyeState; at: number }[];
  hands?: { side: Side; shape: HandShape; at: number }[];
  /** Mouth states per frame from `from` (a viseme track); outside it the pose's mouth shows. */
  mouth?: { from: number; frames: MouthState[] } | null;
  /** This character's index among the extras of a crowd (phase offset seed). */
  crowdIndex?: number;
  /** Frames a pose change blends over, from the beat's preset table (render/presets `poseBlendFrames`). */
  blendFrames?: number;
}

export interface SolveContext {
  seed: number;
  tempo?: TempoMap | null;
  /** The character's library (core merged with its pack overrides); the core library when absent. */
  library?: CharacterLibrary;
}

export type Matrix = [number, number, number, number, number, number];

export interface SolvedPart {
  name: string;
  rot: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  state: string | null;
  /** The file drawn this frame (a state's file, or the part's own), null for slots and hidden parts. */
  file: string | null;
  /** Canvas matrix (CSS `matrix(a, b, c, d, e, f)`) of the part's own px box. */
  matrix: Matrix;
  z: number;
}

export interface SolvedFrame {
  frame: number;
  charId: string;
  view: ViewId;
  eye: EyeState;
  mouth: MouthState;
  hands: Record<Side, HandShape>;
  /** Parts of the view sorted by draw order. */
  parts: SolvedPart[];
  /** The swipe finger in canvas px, when a swipe plays. */
  finger: { x: number; y: number } | null;
  /** SFX cues that fire on this frame (clap contacts). */
  cues: string[];
}
