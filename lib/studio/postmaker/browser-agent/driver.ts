// Browser-agent driver interface. Generic core: a *site binding* (sites/*.ts) is configuration.
//
// The only implementation shipped is a refusal stub: the Codex mechanism is deliberately left open. Tests drive a
// fake driver.
//
// TODO (not implemented; nothing here spawns anything):
//   1. Spawn `codex app-server` over **stdio** only (newline-delimited JSON-RPC 2.0 with the "jsonrpc" field omitted).
//      Never `--listen ws://…`: non-loopback WebSocket listeners are unauthenticated by default.
//   2. Send `initialize`, then the `initialized` notification, before anything else.
//   3. `thread/start` with an explicit `approvalPolicy` and `sandbox` (read-only except the download folder); cwd is a
//      fresh temp folder; no shell tools.
//   4. Give Codex a browser through an MCP server (Playwright MCP or Chrome DevTools MCP) configured to the site's
//      persistent profile folder (user-data-dir), with an `enabled_tools` allow-list of navigation, click, type,
//      screenshot and download tools only. Whether the config is injected through a temp project `.codex/config.toml`
//      or `config/value/write` is UNVERIFIED.
//   5. `turn/start` per task with the fixed goal text; stream `item/*` events into BrowserEvent; answer the
//      server-initiated approval requests (`item/permissions/requestApproval`, `mcpServer/elicitation/request`): allow
//      only navigation/click/type/download on `allowedOrigins`, refuse everything else. Payload shapes are UNVERIFIED:
//      generate them with `codex app-server generate-ts --out <dir>` against the pinned CLI version.
//   6. Environment: CLI_ENV_ALLOW plus CODEX_HOME (as codex.ts); no Signal key ever passes.
//   7. `turn/interrupt` on abort; stop the process on session stop.
//   8. Downloads: the driver reports paths only. evidence.ts already follows symlinks (realpath on the folder and the
//      file) and checks magic bytes against the extension; keep the download folder private to the task (0700).
// Until that is built, reviewed for security and allowed by a written decision about the site's terms, the stub refuses.
import { PostmakerError } from '../errors';

export interface BrowserDriverStart {
  /** The site's persistent profile folder (mode 0700, outside the repo and the content folder). */
  profileDir: string;
  allowedOrigins: string[];
  downloadDir: string;
  model?: string;
  transport: 'stdio';
}

export interface BrowserDriver {
  start(o: BrowserDriverStart): Promise<BrowserSession>;
}

export interface BrowserSession {
  /** Runs one task. The driver awaits `onEvent` before its next action, so Signal can pause, check and abort. */
  runTask(t: BrowserTask, onEvent: (e: BrowserEvent) => void | Promise<void>, signal: AbortSignal): Promise<BrowserTaskOutcome>;
  screenshot(): Promise<Buffer>;
  stop(): Promise<void>;
}

export interface BrowserTask {
  siteId: string;
  /** Fixed template text written by Signal, per site binding. */
  goal: string;
  /** Framed as data, never instructions. */
  inputs: Record<string, string>;
  /** Navigation anywhere else aborts the task. */
  allowedOrigins: string[];
  forbidden: string[];
  maxActions: number;
  timeoutMs: number;
  expectDownloads: { mime: string; count: number; maxBytes: number };
}

export type BrowserEventKind = 'navigate' | 'click' | 'type' | 'download' | 'screenshot' | 'approval' | 'note' | 'error';

/** What the driver reports. `url` is set for navigate; `file` for download (a path inside the download folder). */
export interface BrowserEvent {
  seq: number;
  at: string;
  kind: BrowserEventKind;
  text: string;
  url?: string;
  file?: string;
  /** Object hash of the screenshot Signal took after this event (set by the session, not the driver). */
  screenshot?: string;
}

/** What the driver itself returns; the session adds hashes, evidence and the verdict (BrowserTaskResult). */
export interface BrowserTaskOutcome {
  ok: boolean;
  error?: string;
  creditsBefore?: string;
  creditsAfter?: string;
}

export interface BrowserTaskResult {
  ok: boolean;
  /** 'needs-you' when a stop rule fired (rule 5); the last screenshot is kept. */
  status: 'done' | 'needs-you' | 'failed';
  downloads: { file: string; sha256: string; mime: string; bytes: number }[];
  evidence: { before: string; after: string; actions: string; last: string | null };
  creditsBefore?: string;
  creditsAfter?: string;
  error?: string;
}

/** The Codex app-server driver: not built (see the TODO above). Refuses every start. */
export function codexAppServerDriver(): BrowserDriver {
  return {
    async start() {
      throw new PostmakerError(501, 'not_implemented', 'The browser agent is not available yet.');
    },
  };
}
