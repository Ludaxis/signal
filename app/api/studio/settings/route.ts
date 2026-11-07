// GET  /api/studio/settings   which keys are set (and where from) and the two switches — never secret values
// POST /api/studio/settings
//   {action:'save', group, values}   saves the filled-in fields (encrypted), active at once
//   {action:'clear', group}          removes what was saved here (.env.local applies again)
//   {action:'switch', id:'publishing'|'autopilot', on}
//   {action:'feature', id, on, acceptTerms?}   feature switch (signal.config.json); a paid Post maker service's switch
//                                go through its connector, so turning it on the first time needs acceptTerms
//   {action:'test', group:'r2'|'upload-post'}   r2: puts a tiny file, reads it from the public address, deletes it
//                                              upload-post: lists the profiles on the plan
import { NextResponse, type NextRequest } from 'next/server';
import { requireStudioUser } from '@/lib/server/studioAuth';
import { FEATURE_IDS, featureStates, setFeature, type Feature } from '@/lib/server/signalConfig';
import { jsonError } from '@/lib/server/security';
import { SettingsError, clearGroup, saveGroup, setSwitch, settingsStatus } from '@/lib/studio/app-settings';
import { MediaHostError, hostFiles, r2Config, removeFiles } from '@/lib/studio/r2';
import { UploadPostError, listUpProfiles } from '@/lib/studio/uploadpost';
import { CONNECTORS, switchConnector, termsRefs } from '@/lib/studio/postmaker/connectors';
import { PostmakerError } from '@/lib/studio/postmaker/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  return NextResponse.json({ ...(await settingsStatus()), features: await featureStates() }, { headers: { 'Cache-Control': 'no-store' } });
}

async function testR2(): Promise<string> {
  const c = r2Config();
  if (!c.ok) throw new SettingsError(409, c.reason);
  const [f] = await hostFiles('check', [{ name: 'signal-check.txt', body: Buffer.from('signal media check'), type: 'text/plain' }]);
  try {
    const r = await fetch(f!.url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!r?.ok) throw new SettingsError(502, `Upload works, but the public address did not serve the file (${r ? `HTTP ${r.status}` : 'no answer'}). Turn on public access for the bucket and check the public address.`);
    return `Media bucket works: upload, public link and delete (${new URL(c.publicBase).host}).`;
  } finally {
    await removeFiles([f!.key]);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireStudioUser(req);
  if (user instanceof Response) return user;
  let b: { action?: unknown; group?: unknown; values?: unknown; id?: unknown; on?: unknown; acceptTerms?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return jsonError(400, 'validation', 'Bad request.');
  }
  try {
    const group = typeof b.group === 'string' ? b.group : '';
    switch (b.action) {
      case 'save': {
        const labels = await saveGroup(group, b.values && typeof b.values === 'object' ? (b.values as Record<string, unknown>) : {});
        return NextResponse.json({ message: `Saved ${labels.join(', ')}. Active now.` });
      }
      case 'clear': {
        const n = await clearGroup(group);
        return NextResponse.json({ message: n ? 'Removed the values saved here.' : 'Nothing was saved here.' });
      }
      case 'switch': {
        if ((b.id !== 'publishing' && b.id !== 'autopilot') || typeof b.on !== 'boolean') return jsonError(400, 'validation', 'Bad switch.');
        await setSwitch(b.id, b.on);
        const what = b.id === 'publishing' ? 'Publishing' : 'Autopilot';
        return NextResponse.json({ message: b.on ? `${what} is active.` : `${what} is paused.` });
      }
      case 'feature': {
        if (typeof b.id !== 'string' || !FEATURE_IDS.includes(b.id as Feature) || typeof b.on !== 'boolean') return jsonError(400, 'validation', 'Unknown switch.');
        // A paid Post maker service keeps its one-time terms step whichever screen turns it on.
        const owner = CONNECTORS.find((c) => c.feature === b.id && termsRefs(c).length > 0);
        if (owner) await switchConnector(owner.id, b.on, { acceptTerms: b.acceptTerms === true });
        else await setFeature(b.id as Feature, b.on);
        return NextResponse.json({ message: `${b.on ? 'On' : 'Off'}: ${(await featureStates()).find((x) => x.id === b.id)!.label}.` });
      }
      case 'test': {
        if (group === 'r2') return NextResponse.json({ message: await testR2() });
        if (group === 'upload-post') {
          const j = await listUpProfiles();
          return NextResponse.json({ message: `Upload-Post key works${j.plan ? ` (${j.plan} plan)` : ''}: ${j.profiles.length} profile${j.profiles.length === 1 ? '' : 's'}.` });
        }
        return jsonError(400, 'validation', 'No test for this group.');
      }
      default:
        return jsonError(400, 'validation', 'Unknown action.');
    }
  } catch (e) {
    if (e instanceof PostmakerError) return jsonError(e.status, e.status === 403 ? 'forbidden' : e.status === 404 ? 'not_found' : e.status === 400 ? 'validation' : e.code, e.message);
    if (e instanceof SettingsError) return jsonError(e.status, e.status === 409 ? 'conflict' : e.status >= 500 ? 'upstream' : 'validation', e.message);
    if (e instanceof MediaHostError || e instanceof UploadPostError) return jsonError(Math.min(Math.max(e.status, 400), 599), 'upstream', e.message);
    throw e;
  }
}
