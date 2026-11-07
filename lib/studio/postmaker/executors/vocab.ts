// Closed vocabularies the agent answers are validated against (`RecipeBeat`). An agent may use
// only these ids and the pack ids it is given; anything else fails zod validation. The ids marked "proposed" in the
// roles doc (†, SFX cues) are included as proposed vocabulary, pending the reviewers'
// acknowledgement. Generic core: no project names.
import { z } from 'zod';

export const SEGMENTS = ['hook', 'story', 'interrupt', 'demo', 'chant', 'escalation', 'reveal', 'endcard', 'other'] as const;
export const SHOTS = ['wide', 'medium', 'close', 'insert', 'card'] as const;

/** Roles doc (list closed). */
export const TECHNIQUES = [
  'pov-hook',
  'word-kinetic-caption',
  'highlight-marker', // proposed
  'emphasis-punch', // proposed
  'emoji-sticker',
  'dialogue',
  'speech-bubble', // proposed
  'speaker-tag', // proposed
  'new-character-entry', // proposed
  'pattern-interrupt-card',
  'music-drop', // proposed
  'phone-demo',
  'finger-swipe',
  'feedback-sticker', // proposed
  'color-card-chant',
  'beat-sync-cuts', // proposed
  'crowd-escalation',
  'pull-back', // proposed
  'push-in', // proposed
  'letter-reveal',
  'confetti',
  'end-card-cta',
  'cta-pulse', // proposed
  'idle-loops', // proposed
  'dance-loop', // proposed
  'lip-sync-close-up', // proposed
  'voice-over', // proposed
  'b-roll-clip', // proposed
] as const;
export type Technique = (typeof TECHNIQUES)[number];

/** Roles doc (proposed). */
export const SFX_CUES = ['pop', 'whoosh', 'tap', 'swipe', 'success', 'clap', 'hit', 'riser', 'confetti', 'tick'] as const;

export const segmentSchema = z.enum(SEGMENTS);
export const shotSchema = z.enum(SHOTS);
export const techniqueSchema = z.enum(TECHNIQUES);
export const sfxSchema = z.enum(SFX_CUES);

/** `BilingualLine` register sets (English is casual | neutral | formal). */
export const FA_REGISTERS = ['colloquial', 'neutral', 'formal'] as const;
export const EN_REGISTERS = ['casual', 'neutral', 'formal'] as const;

/** A short human-readable list of the first zod issue (path and message) for a validation error. */
export function issueText(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Not valid.';
  return `${i.path.length ? i.path.join('.') : 'answer'}: ${i.message}`;
}
