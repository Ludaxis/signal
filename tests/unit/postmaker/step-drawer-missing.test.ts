// (follow-up): the Scenes step drawer lists each pending missing-asset request as a
// "Missing asset · Make with Codex" row; other steps and other request states show none.
import { describe, expect, it } from 'vitest';
import { missingAssets } from '@/app/studio/postmaker/StepDrawer';
import { t } from '@/app/studio/copy/en';

const scenes = (requests: unknown[]) => JSON.stringify({ schema: 'signal.pm.scenes/1', requests });

describe('StepDrawer missing assets', () => {
  it('lists pending requests of the Scenes step only, with their kind and prompt', () => {
    const text = scenes([
      { id: 'ar-0123456789ab', kind: 'sticker', prompt: 'a bold flat star sticker', status: 'pending' },
      { id: 'ar-0123456789ac', kind: 'background', prompt: 'a room', status: 'made' },
      { id: 'ar-0123456789ad', kind: 'ui', prompt: 'a phone', status: 'rejected' },
      { id: 'new-1', kind: 'prop', prompt: 'not recorded yet', status: 'pending' },
    ]);
    expect(missingAssets('art', text)).toEqual([{ id: 'ar-0123456789ab', kind: 'sticker', prompt: 'a bold flat star sticker' }]);
    expect(missingAssets('motion', text)).toEqual([]);
    expect(missingAssets('art', undefined)).toEqual([]);
    expect(missingAssets('art', '{ not json')).toEqual([]);
  });

  it('the row copy is plain words (no ids, paths or gate names)', () => {
    expect(t('pm.step.missing')).toBe('Missing asset · Make with Codex');
    for (const k of ['background', 'prop', 'sticker', 'ui'] as const) expect(t(`pm.step.missingKind.${k}`)).not.toMatch(/[_/]|ar-/);
    expect(t('pm.step.assetMade').split(/\s+/).length).toBeLessThanOrEqual(8);
  });
});
