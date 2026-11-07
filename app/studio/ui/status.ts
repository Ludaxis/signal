// The status dictionary: one word, one meaning, per object. A status pill can only show one of
// these words; an unlisted word fails type-checking. Colour comes from the meaning.

export const STATUS_WORDS = {
  post: ['To approve', 'Approved', 'Scheduled', 'Sending', 'Posted', 'Check status', 'Failed', 'Rejected', 'Files changed'],
  campaign: ['Draft', 'Running', 'Paused', 'Ended'],
  template: ['Draft', 'Proven', 'Repeats', 'Retired'],
  run: ['Queued', 'Running', 'Needs you', 'Done', 'Stopped', 'Failed'],
  step: ['Not run', 'Queued', 'Running', 'Done', 'Needs you', 'Out of date', 'Failed', 'Skipped', 'Off', 'Mock', 'Locked'],
  connection: ['Ready', 'Needs you', 'Off', 'Not set up'],
} as const;

export type StatusObject = keyof typeof STATUS_WORDS;
export type StatusWord = (typeof STATUS_WORDS)[StatusObject][number];

/** The five meanings a status colour can carry . */
export type StatusTone = 'done' | 'needs-you' | 'running' | 'failed' | 'neutral';

export const STATUS_TONE: Record<StatusWord, StatusTone> = {
  'To approve': 'needs-you',
  Approved: 'done',
  Scheduled: 'running',
  Sending: 'running',
  Posted: 'done',
  'Check status': 'needs-you',
  Failed: 'failed',
  Rejected: 'neutral',
  'Files changed': 'failed',
  Draft: 'neutral',
  Running: 'running',
  Paused: 'neutral',
  Ended: 'neutral',
  Proven: 'done',
  Repeats: 'done',
  Retired: 'neutral',
  Queued: 'running',
  'Needs you': 'needs-you',
  Done: 'done',
  Stopped: 'neutral',
  'Not run': 'neutral',
  'Out of date': 'needs-you',
  Skipped: 'neutral',
  Off: 'neutral',
  Mock: 'neutral',
  Locked: 'neutral',
  Ready: 'done',
  'Not set up': 'neutral',
};

/** Every word in the dictionary, once. */
export const ALL_STATUS_WORDS: readonly StatusWord[] = Array.from(new Set(Object.values(STATUS_WORDS).flat())) as StatusWord[];

export function isStatusWord(text: string): text is StatusWord {
  return (ALL_STATUS_WORDS as readonly string[]).includes(text);
}
