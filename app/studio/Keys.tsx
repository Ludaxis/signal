'use client';
// Keys and switches for Connections: no .env.local editing. Secret values go to the server once and
// are stored encrypted there; the browser only ever learns whether a value is set (and its last 4
// characters). Connections embeds KeyForm inside each service's panel.
import { useCallback, useEffect, useState } from 'react';
import { notifyChanged, useOnChanged } from './sync';
import { Switch } from './Autopilot';
import { More } from './More';
import { t } from './copy/en';

export interface FieldStatus { name: string; label: string; secret: boolean; placeholder: string; source: 'saved' | 'env' | 'missing'; value: string | null; hint: string | null }
export interface GroupStatus { id: string; title: string; why: string; where: string; complete: boolean; saved: boolean; fields: FieldStatus[] }
export type SwitchId = 'publishing' | 'autopilot';
export interface FeatureState { id: string; label: string; on: boolean; forcedByEnv: boolean }
export interface SettingsData { ready: boolean; reason: string; groups: GroupStatus[]; switches: Record<SwitchId, { on: boolean; source: 'saved' | 'env' | 'default' }>; features?: FeatureState[] }

export async function settingsCall<T>(body?: unknown): Promise<T & { message?: string }> {
  const r = await fetch('/api/studio/settings', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { message?: string; error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

export function useSettings() {
  const [d, setD] = useState<SettingsData | null>(null);
  const load = useCallback(async () => {
    try {
      setD(await settingsCall<SettingsData>());
    } catch {
      /* the Connections screen shows the main error */
    }
  }, []);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['connections'], load);
  return { d, load };
}

// a value set outside the app reads "Saved outside Signal", never a file name.
const sourceText = (f: FieldStatus) => (f.source === 'saved' ? `Saved${f.hint ? ` · ${f.hint}` : ''}` : f.source === 'env' ? `Saved outside Signal${f.hint ? ` · ${f.hint}` : ''}` : 'Not set');

/** The fields of one key group, with Save, Test (where there is one) and Remove. */
/** `primary`: Save is the drawer's one filled button; otherwise it is secondary. */
export function KeyForm({ group, ready, reason, say, onSaved, title, primary = false }: { group: GroupStatus; ready: boolean; reason: string; say: (t: string) => void; onSaved: () => Promise<void> | void; title?: string; primary?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, body: Record<string, unknown>, after?: () => void) => {
    setBusy(key);
    try {
      const j = await settingsCall(body);
      if (j.message) say(j.message);
      after?.();
      await onSaved();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const filled = Object.values(values).some((v) => v.trim());
  const canTest = group.id === 'r2' || group.id === 'upload-post';
  return (
    <form
      className="cx-keys st-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run('save', { action: 'save', group: group.id, values }, () => setValues({}));
      }}
    >
      <div className="cx-keys-head">
        <span className="cx-subhead">{title ?? 'Keys'}</span>
        <More label={group.fields.length > 1 ? 'Where do I find these?' : 'Where do I find it?'}>
          <span>{group.where}</span>
        </More>
      </div>
      {/* The server's reason can name files and settings; the screen says what it means instead. */}
      {!ready ? <p className="real-error st-small" style={{ margin: 0 }} data-reason={reason ? 'set' : 'none'}>{t('keys.notReady')}</p> : null}
      {group.fields.map((f) => (
        <label key={f.name} className="cx-field">
          <span className="cx-field-top">
            {group.fields.length > 1 ? <span>{f.label}</span> : <span className="st-vh">{f.label}</span>}
            <span className={`cx-field-src cx-src-${f.source}`}>{sourceText(f)}</span>
          </span>
          <input
            className="st-input"
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            disabled={!ready}
            placeholder={f.secret ? (f.source === 'missing' ? 'Paste the key' : 'Paste a new key to replace it') : (f.value ?? f.placeholder)}
            value={values[f.name] ?? ''}
            onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
          />
        </label>
      ))}
      <div className="row-wrap" style={{ gap: 8 }}>
        <button type="submit" className={`btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-dense`} aria-busy={busy === 'save'} disabled={!!busy || !filled || !ready}>Save</button>
        {canTest ? <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'test'} disabled={!!busy || !group.complete} title={group.complete ? '' : 'Fill in every field first.'} onClick={() => void run('test', { action: 'test', group: group.id })}>Test</button> : null}
        {group.saved ? <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!!busy} onClick={() => void run('clear', { action: 'clear', group: group.id })}>Remove saved</button> : null}
      </div>
      <span className="xs st-muted">Encrypted on this machine, active at once, never shown again.</span>
    </form>
  );
}

/** Feature switches (signal.config.json), all off by default. Anything that spends money, posts or runs on its own stays off until you turn it on here. */
/** `hide`: switches shown elsewhere (Connections shows the Post maker ones as rows, with their terms step). */
export function FeaturesSection({ say, hide = [] }: { say: (t: string) => void; hide?: readonly string[] }) {
  const { d, load } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const features = (d?.features ?? []).filter((f) => !hide.includes(f.id));
  if (!features.length) return null;
  const on = features.filter((f) => f.on).length;
  return (
    <>
      <section className="cx-section" aria-labelledby="cx-features">
      <div className="cx-section-head">
        <h2 id="cx-features" className="cx-h2">{hide.length ? t('connections.features.more') : t('connections.group.features')}</h2>
        <p className="cx-sub">{on} of {features.length} on. Paid, posting and automatic features stay off until you switch them on.</p>
      </div>
      <div className="st-card cx-features">
        <More label="Show switches">
          {features.map((f) => (
            <Switch
              key={f.id}
              checked={f.on}
              busy={busy === f.id}
              disabled={!!busy || f.forcedByEnv}
              reason={f.forcedByEnv ? 'Set by an environment variable on this machine.' : undefined}
              label={f.label}
              onChange={(v) =>
                void (async () => {
                  setBusy(f.id);
                  try {
                    const j = await settingsCall({ action: 'feature', id: f.id, on: v });
                    if (j.message) say(j.message);
                    notifyChanged('connections', 'content', 'autopilot', 'pipelines');
                    await load();
                  } catch (e) {
                    say((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                })()
              }
            />
          ))}
        </More>
      </div>
      </section>
    </>
  );
}
