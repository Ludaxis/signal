// Server-only: a local kill switch for anything that could publish.
// SIGNAL_PUBLISH_PAUSED=1 blocks: Post now (Upload-Post and Instagram API), scheduling on Upload-Post,
// finishing an Instagram publish, and every scheduler tick. Reads (connection checks, posts, results,
// comments) still work, so a setup can be tested safely.
export function publishingPaused(): { paused: boolean; reason: string } {
  const v = (process.env.SIGNAL_PUBLISH_PAUSED ?? '').trim().toLowerCase();
  const paused = v === '1' || v === 'true' || v === 'yes';
  return { paused, reason: paused ? 'Publishing is paused (SIGNAL_PUBLISH_PAUSED=1). Nothing will be posted or scheduled.' : '' };
}
