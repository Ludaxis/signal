'use client';
// Keys and switches, all in Connections: no .env.local editing. Secret values go to the server once
// and are stored encrypted there; the browser only ever sees whether a value is set (and its last 4
// characters). "Posting" holds the publishing and autopilot switches (the kill switches).
import { useCallback, useEffect, useState } from 'react';
import { notifyChanged, useOnChanged } from './sync';
import { Switch } from './Autopilot';
import { More } from './More';
import { Panel } from './Workspace';

interface FieldStatus { name: string; label: string; secret: boolean; placeholder: string; source: 'saved' | 'env' | 'missing'; value: string | null; hint: string | null }
interface GroupStatus { id: string; title: string; why: string; where: string; complete: boolean; saved: boolean; fields: FieldStatus[] }
interface FeatureState { id: string; label: string; on: boolean; forcedByEnv: boolean }
interface Payload { ready: boolean; reason: string; groups: GroupStatus[]; switches: Record<'publishing' | 'autopilot', { on: boolean; source: 'saved' | 'env' | 'default' }>; features?: FeatureState[] }

async function call<T>(body?: unknown): Promise<T & { message?: string }> {
  const r = await fetch('/api/studio/settings', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { message?: string; error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `Request failed (${r.status}).`);
  return j;
}

function useSettings() {
  const [d, setD] = useState<Payload | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try {
      setD(await call<Payload>());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);
  useOnChanged(['connections'], load);
  return { d, err, load };
}

/** The two kill switches, at the top of Connections. */
export function PostingSwitches({ say, status }: { say: (t: string) => void; status: string }) {
  const { d, err, load } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const flip = async (id: 'publishing' | 'autopilot', on: boolean) => {
    setBusy(id);
    try {
      const j = await call({ action: 'switch', id, on });
      if (j.message) say(j.message);
      notifyChanged('connections', 'content', 'autopilot');
      await load();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (err) return <p className="real-error st-small" role="alert">{err}</p>;
  if (!d) return null;
  return (
    <div className="st-card conn-card st-stack" style={{ gap: 6 }}>
      <Switch checked={d.switches.publishing.on} busy={busy === 'publishing'} disabled={!!busy || !d.ready} reason={d.ready ? undefined : d.reason} label="Publishing" hint={d.switches.publishing.on ? status : 'Paused · nothing is posted or scheduled.'} onChange={(on) => void flip('publishing', on)} />
      <Switch checked={d.switches.autopilot.on} busy={busy === 'autopilot'} disabled={!!busy || !d.ready} reason={d.ready ? undefined : d.reason} label="Autopilot" hint={d.switches.autopilot.on ? 'Active · runs daily where it is set up.' : 'Paused · nothing is made automatically.'} onChange={(on) => void flip('autopilot', on)} />
    </div>
  );
}

/** One card per service whose keys you can set here. */
export function KeysSection({ say }: { say: (t: string) => void }) {
  const { d, err, load } = useSettings();
  const [open, setOpen] = useState<string | null>(null);
  if (err) return <p className="real-error st-small" role="alert">{err}</p>;
  if (!d) return null;
  const g = d.groups.find((x) => x.id === open) ?? null;
  return (
    <>
      <span className="label">Keys</span>
      {!d.ready ? <p className="real-error st-small">{d.reason}</p> : null}
      <div className="conn-grid">
        {d.groups.map((gr) => {
          const missing = gr.fields.filter((f) => f.source === 'missing').length;
          return (
            <div key={gr.id} className={`st-card conn-card conn-${gr.complete ? 'on' : missing === gr.fields.length ? 'off' : 'warn'}`}>
              <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span className="conn-title">
                  <span className="conn-dot" aria-hidden="true" />
                  {gr.title}
                </span>
                <span className="conn-status">{gr.complete ? 'Set' : missing === gr.fields.length ? 'Not set' : `${missing} missing`}</span>
              </div>
              <span className="xs st-muted">{gr.why}</span>
              <div className="row-wrap" style={{ gap: 8 }}>
                <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!d.ready} onClick={() => setOpen(gr.id)}>{gr.complete ? 'Change' : 'Add keys'}</button>
              </div>
            </div>
          );
        })}
      </div>
      {g ? (
        <KeyPanel
          group={g}
          say={say}
          onClose={() => setOpen(null)}
          onSaved={async () => {
            notifyChanged('connections', 'content');
            await load();
          }}
        />
      ) : null}
    </>
  );
}

function KeyPanel({ group, say, onClose, onSaved }: { group: GroupStatus; say: (t: string) => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, body: Record<string, unknown>, after?: () => void) => {
    setBusy(key);
    try {
      const j = await call(body);
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
    <Panel title={group.title} onClose={onClose}>
      <span className="st-small st-muted">{group.why}</span>
      <More label="Where do I find these?">
        <span>{group.where}</span>
      </More>
      <form
        className="st-stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void run('save', { action: 'save', group: group.id, values }, () => setValues({}));
        }}
      >
        {group.fields.map((f) => (
          <label key={f.name} className="wiz-field">
            <span>
              {f.label}{' '}
              <span className="xs st-muted">· {f.source === 'saved' ? `saved here${f.hint ? ` (${f.hint})` : ''}` : f.source === 'env' ? `from .env.local${f.hint ? ` (${f.hint})` : ''}` : 'not set'}</span>
            </span>
            <input
              className="st-input"
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={f.secret ? (f.source === 'missing' ? 'Paste here' : 'Leave empty to keep it') : f.value ?? f.placeholder}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          </label>
        ))}
        <div className="row-wrap" style={{ gap: 8 }}>
          <button type="submit" className="st-btn st-btn-primary st-btn-sm" aria-busy={busy === 'save'} disabled={!!busy || !filled}>Save</button>
          {canTest ? <button type="button" className="st-btn st-btn-ghost st-btn-sm" aria-busy={busy === 'test'} disabled={!!busy || !group.complete} onClick={() => void run('test', { action: 'test', group: group.id })}>Test</button> : null}
          {group.saved ? <button type="button" className="st-btn st-btn-ghost st-btn-sm" disabled={!!busy} onClick={() => void run('clear', { action: 'clear', group: group.id })}>Remove saved</button> : null}
        </div>
      </form>
      <span className="xs st-muted">Saved keys are encrypted on this Mac and active at once. They are never shown again.</span>
    </Panel>
  );
}

/** Feature switches (signal.config.json), all off by default. Anything that spends money, posts or runs on its own stays off until you turn it on here. */
export function FeaturesSection({ say }: { say: (t: string) => void }) {
  const { d, err, load } = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  if (err || !d?.features) return null;
  const on = d.features.filter((f) => f.on).length;
  return (
    <>
      <span className="label">Features</span>
      <div className="st-card conn-card st-stack" style={{ gap: 4 }}>
        <span className="xs st-muted">{on} of {d.features.length} on. Paid, posting and automatic features stay off until you switch them on.</span>
        <More label="Show switches">
          {d.features.map((f) => (
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
                    const j = await call({ action: 'feature', id: f.id, on: v });
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
    </>
  );
}
