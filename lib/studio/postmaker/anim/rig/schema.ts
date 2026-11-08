// zod schema of `characters/<charId>/rig.json` (`cutout-rig/1`, quality bar, pack guide) and of the
// per-character override files `poses.json` / `gestures.json` (pack guide). Two additions to the documented
// shape, both optional: `size` (part px, read from the file when absent) and parts without a `file`: a part drawn
// only through its states (eyes, lids, mouth, hands) and slots (`prop_hand_*`, `accessory_*`), which only carry
// what attaches to them. Structural rules beyond the shape (required parts,
// states, pivots inside the part) live in validate.ts so each failure has its own code.
import { z } from 'zod';
import { relPath } from '../../pack/schema';
import { CURVE_IDS } from '../../render/curves';
import { CHANNELS, GESTURE_IDS, POSE_IDS, RIG_FORMAT, SLOT_PARTS, VIEWS } from '../types';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PART_NAME = /^[a-z][a-z0-9_]{0,40}(_[LR])?$/;
const STATE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const point = z.tuple([z.number().finite(), z.number().finite()]);

export const rigPartSchema = z
  .object({
    name: z.string().regex(PART_NAME),
    view: z.enum(VIEWS),
    file: relPath.optional(),
    states: z.record(z.string().regex(STATE), relPath).optional(),
    parent: z.string().regex(PART_NAME).nullable(),
    pivot: point,
    anchor: point,
    z: z.number().finite(),
    limits: z.object({ rot: z.tuple([z.number().min(-180).max(180), z.number().min(-180).max(180)]).optional() }).optional(),
    size: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  })
  .refine((p) => p.file !== undefined || (p.states !== undefined && Object.keys(p.states).length > 0) || (SLOT_PARTS as readonly string[]).includes(p.name), { message: 'A part needs a file or states; only a slot may have neither.', path: ['file'] });

export const cutoutRigSchema = z.object({
  format: z.literal(RIG_FORMAT),
  id: z.string().regex(SLUG),
  views: z.array(z.enum(VIEWS)).min(1),
  unitPx: z.number().positive(),
  parts: z.array(rigPartSchema).min(1),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  turnaround: relPath,
});

const partKeysSchema = z.object({
  rot: z.number().finite().optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  sx: z.number().positive().optional(),
  sy: z.number().positive().optional(),
  state: z.string().regex(STATE).optional(),
});

/** Ids are checked by `mergeOverrides` (an unknown id is named with the character), so the keys are free strings here. */
export const poseOverridesSchema = z.object({
  schema: z.literal('signal.cutout-poses/1'),
  poses: z.record(z.string(), z.object({ parts: z.record(z.string(), partKeysSchema) })),
});

export const gestureOverridesSchema = z.object({
  schema: z.literal('signal.cutout-gestures/1'),
  gestures: z.record(
    z.string(),
    z.object({
      frames: z.number().int().positive().max(600),
      keys: z.array(
        z.object({
          frame: z.number().int().min(0),
          part: z.string(),
          prop: z.enum(['state', ...CHANNELS]),
          value: z.union([z.number().finite(), z.string()]),
          curve: z.enum(['hold', ...CURVE_IDS]),
        }),
      ),
    }),
  ),
});

export type PoseOverrides = z.infer<typeof poseOverridesSchema>;
export type GestureOverrides = z.infer<typeof gestureOverridesSchema>;

export const CORE_POSE_IDS: readonly string[] = POSE_IDS;
export const CORE_GESTURE_IDS: readonly string[] = GESTURE_IDS;
