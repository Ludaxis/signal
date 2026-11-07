// Builds a registered connector from its definition: status() comes from the single decision point, test() defaults
// to the free "Key saved. Not tested." answer, and redact() removes every saved secret, not only the connector's own.
import { t } from '@/app/studio/copy/en';
import { GROUPS, SECRET_FIELD_NAMES, groupComplete } from '../../app-settings';
import type { Connector } from '../types';
import { connectorStatus } from './allowed';
import { redactor, type RegisteredConnector } from './base';

export type TestResult = Awaited<ReturnType<Connector['test']>>;

export type ConnectorDef<Req, Res> = Omit<RegisteredConnector<Req, Res>, 'status' | 'test' | 'redact' | 'keyPresent' | 'keyEnv'> & {
  keyPresent?: () => Promise<boolean>;
  test?: () => Promise<TestResult>;
  /** Extra environment names whose values must never appear in events or errors. */
  secretEnv?: readonly string[];
};

export const notTested = (): TestResult => ({ ok: true, text: t('connector.keySavedNotTested'), costUsd: 0 });
export const needsKey = (title: string): TestResult => ({ ok: false, text: t('notice.serviceNeedsKey', { service: title }), costUsd: 0 });

/** Environment names of a settings group (all fields, secret or not). */
export const groupEnv = (groupId: string | null): string[] => (groupId ? (GROUPS.find((g) => g.id === groupId)?.fields.map((f) => f.name) ?? []) : []);

export function defineConnector<Req, Res>(d: ConnectorDef<Req, Res>): RegisteredConnector<Req, Res> {
  const keyPresent = d.keyPresent ?? (d.settingsGroup ? () => groupComplete(d.settingsGroup!) : async () => true);
  const redact = redactor([...SECRET_FIELD_NAMES, ...(d.secretEnv ?? []), 'SIGNAL_TOKEN_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  const c: RegisteredConnector<Req, Res> = {
    ...d,
    keyPresent,
    keyEnv: groupEnv(d.settingsGroup),
    redact,
    status: () => connectorStatus(c as RegisteredConnector),
    test: d.test ?? (async () => ((await keyPresent()) ? notTested() : needsKey(d.title))),
  };
  return c;
}
