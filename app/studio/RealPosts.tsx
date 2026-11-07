"use client";
// Real posts: the data hook, the shared per-post actions and the make form (shown in the header's
// "Make a post" drawer until Post maker ships). The Posts screen (Posts.tsx) shows them as a board, a
// gallery and lists. Approve re-checks every file on the server; posting is by hand or, when posting is
// switched on for the account, one owner-confirmed send. Nothing is approved or posted automatically.
import type { ConnectionBlock } from "@/lib/studio/posting-blocks";
import { useConfirm, type ConfirmFn, type ConfirmRequest } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { More } from "./More";
import { t } from "./copy/en";
import { deferApprove, useApproving } from "./approve-undo";
import { formatWhenIn } from "@/lib/studio/time";
import { useRouter } from "next/navigation";
import { notifyChanged, useOnChanged } from "./sync";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getProjectId, useProjectId } from "./Projects";
import { Select } from "./Select";
import { TaskProgress } from "./loaders";
import { OVERDUE_TEXT, canReject, isOverdue, overdueTimes } from "./posts-rules";

export type Status =
  | "ready"
  | "changed"
  | "approved"
  | "scheduled"
  | "sending"
  | "submitted"
  | "uncertain"
  | "failed"
  | "posted"
  | "discarded"
  | "invalid";
interface PFile {
  name: string;
  role: "slide" | "video" | "cover" | "caption";
  sha256: string;
  ok: boolean;
}
export interface RealPackage {
  id: string;
  title: string;
  format: "carousel" | "image" | "reel";
  destination: string;
  status: Status;
  problems: string[];
  caption: string;
  files: PFile[];
  approval: { approved_by: string; approved_at: string } | null;
  posted: {
    url: string | null;
    posted_at: string;
    via?: "manual" | "upload-post" | "meta";
  } | null;
  outcome: { state: string; at: string; message?: string } | null;
  labelConfirmed: boolean;
  plannedFor: string | null;
  scheduled: { job_id: string; scheduled_for: string; provider?: "upload-post" | "signal" } | null;
  missedAt?: string | null;
  missedReason?: string | null;
  metrics: { fetched_at: string; metrics: { views: number | null; reach: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null; impressions: number | null } | null; error?: string } | null;
  dispatch: { request_id: string; provider?: "upload-post" | "meta" } | null;
  source?: { format?: string; category?: string; generator?: string } | null;
  campaign?: { id: string; name: string; slot: string } | null;
  /** Set when Post maker made the post: the card's origin line. */
  postmaker?: { template: string; version: number } | null;
  /** Set when a pipeline made the post: its name shows on the card. */
  pipeline?: { id: string; name: string; slotAt: string } | null;
  /** Set when autopilot made the post. */
  autopilot?: { run: string; campaign: string | null; slot: string; pipeline?: string; madeAt: string; autoApproved: null | { at: string; trustInARow: number; scheduledFor: string | null; via: "meta" | "upload-post" | null } } | null;
  /** State files that are not valid JSON (the package is then 'invalid'; they are named in problems). */
  unreadable?: string[];
}
interface Account {
  destination: string;
  maxPosts: number;
  posted: number;
  open: boolean;
  /** When the posting settings end; null (or not finite) when they have no end date. */
  expiresAt: number | null;
  maxPerDay: number;
  reason?: string;
}
export interface Live {
  enabled: boolean;
  reason: string;
  provider?: string;
}
export interface Insights {
  posts: number;
  measured: number;
  totals: { views: number; reach: number; engagement: number };
  byFormat: { format: string; posts: number; avgViews: number | null; avgRate: number | null }[];
  bestWeekday: string | null;
  bestHour: number | null;
  /** Why bestWeekday/bestHour are empty (null when they are set). */
  bestTimeReason: string | null;
  /** Posts that went into bestWeekday/bestHour. */
  bestTimeSample: number;
  top: { id: string; title: string; views: number | null; rate: number | null }[];
}
export interface Payload {
  account: Account;
  folder: string;
  packages: RealPackage[];
  live: Live;
  codex?: Live;
  higgsfield?: Live;
  /** Connections that block a post planned within 24 h (Today › Needs you). */
  connectionBlocks?: ConnectionBlock[];
  scheduling?: Live;
  instagram?: Live;
  analytics?: Live & { source?: 'instagram' | 'upload-post' | null };
  insights?: Insights;
  project?: { id: string; name: string; handle: string; timeZone?: string };
  /** The formats the project can make, with its labels (the make form's list). */
  formats?: MakeFormat[];
}


const projectQuery = () => `project=${encodeURIComponent(getProjectId() ?? "")}`;
export const fileUrl = (id: string, name: string, download = false) =>
  `/api/studio/content/${id}/file/${encodeURIComponent(name)}?${projectQuery()}${download ? "&download=1" : ""}`;

export function useRealPosts() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const router = useRouter();
  const pid = useProjectId();
  const load = useCallback(async () => {
    if (!pid) return;
    try {
      const r = await fetch(`/api/studio/content?project=${encodeURIComponent(pid)}`, { cache: "no-store" });
      if (r.status === 401) {
        // The session ended: sign in again.
        router.push("/login?next=%2Fstudio");
        return;
      }
      const j = (await r.json()) as Payload & { error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? "Could not load posts.");
      setData(j);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [router, pid]);
  useEffect(() => {
    // Fetch on mount and whenever the project changes; the effect only subscribes, state is set in the async callback.
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);
  // Refetch when anything changes posts (any screen or tab), when the tab comes back, and every 45 s while visible.
  useOnChanged(['content'], load, 45_000);
  return { data, error, reload: load, setData };
}

/** Thumbnail (cover, else first slide) of a package, or null. */
export function thumbUrl(p: RealPackage): string | null {
  const f = p.files.find((x) => x.role === "cover") ?? p.files.find((x) => x.role === "slide");
  return f ? fileUrl(p.id, f.name) : null;
}

/** One POST /api/studio/content/:id action with busy state, the error line and the shared refresh. */
export function usePackageAct(pkgId: string, { onChange, reload, say }: { onChange: (p: RealPackage) => void; reload: () => Promise<void>; say: Say }) {
  const [busy, setBusy] = useState(false);
  const [doing, setDoing] = useState("");
  const [err, setErr] = useState("");
  const lastErr = useRef("");
  const router = useRouter();
  const act = useCallback(
    async (body: Record<string, unknown>, okText: string): Promise<boolean> => {
      setBusy(true);
      setDoing(String(body.action ?? ""));
      setErr("");
      lastErr.current = "";
      try {
        const r = await fetch(`/api/studio/content/${pkgId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, project: getProjectId() }),
        });
        if (r.status === 401) {
          router.push("/login?next=%2Fstudio");
          return false;
        }
        const j = (await r.json()) as { package?: RealPackage; error?: { message: string } };
        if (!r.ok || !j.package) throw new Error(j.error?.message ?? t("post.couldNotAct"));
        onChange(j.package);
        notifyChanged("content", "calendar", "campaigns");
        if (okText) say(okText);
        return true;
      } catch (e) {
        lastErr.current = (e as Error).message;
        setErr((e as Error).message);
        await reload();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [pkgId, onChange, reload, say, router],
  );
  /** The message of the last failed act (also shown as `err`), for callers that run several steps. */
  const lastError = useCallback(() => lastErr.current, []);
  return { act, busy, doing, err, setErr, lastError };
}

/** The big media preview of a package: slides, or the video with its cover as poster. */
export function PackageMedia({ pkg }: { pkg: RealPackage }) {
  const media = pkg.files.filter((f) => f.role !== "caption");
  const cover = media.find((m) => m.role === "cover");
  return (
    <div className="real-media">
      {media
        .filter((f) => !(f.role === "cover" && media.some((m) => m.role === "video")))
        .map((f, i) =>
          f.role === "video" ? (
            // Preview of the owner's own post; captions live in the Instagram caption.
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video key={f.name} className="real-slide real-video" src={fileUrl(pkg.id, f.name)} poster={cover ? fileUrl(pkg.id, cover.name) : undefined} controls playsInline preload="metadata" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={f.name} className="real-slide" src={fileUrl(pkg.id, f.name)} alt={`Slide ${i + 1} of post ${pkg.id}`} />
          ),
        )}
    </div>
  );
}

// "Check status" asks the provider about a send, so it needs one: a Signal schedule has no dispatch yet.
const needsCheck = (pkg: RealPackage) =>
  !!pkg.dispatch && (pkg.status === "sending" || pkg.status === "scheduled" || pkg.status === "submitted" || pkg.status === "uncertain" || (pkg.status === "failed" && !pkg.outcome?.message?.startsWith("Upload-Post rejected")));
const needsResolve = (pkg: RealPackage) => pkg.status === "uncertain" || (pkg.status === "failed" && !!pkg.dispatch && !pkg.outcome?.message?.startsWith("Upload-Post rejected"));
/** Which short action a board card should offer for a post in Review (besides moving it). */
export function quickAction(pkg: RealPackage): "check" | "resolve" | "label" | null {
  if (pkg.status === "posted") return pkg.labelConfirmed ? null : "label";
  if (needsResolve(pkg)) return "resolve";
  if (needsCheck(pkg)) return "check";
  return null;
}

/** Says something in the Studio toast; `onUndo` adds the Undo button (8 s). */
export type Say = (text: string, opts?: { onUndo?: () => void }) => void;

/**
 * One POST /api/studio/content/:id outside a component (the deferred approval runs after the drawer closed).
 * The project is the selected one unless `body.project` names it: a deferred send must name the project it was
 * chosen in, because the selection can change before it goes out.
 */
export async function postAction(pkgId: string, body: Record<string, unknown>, opts: { keepalive?: boolean } = {}): Promise<RealPackage> {
  const r = await fetch(`/api/studio/content/${pkgId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: getProjectId(), ...body }),
    keepalive: opts.keepalive,
  });
  const j = (await r.json().catch(() => ({}))) as { package?: RealPackage; error?: { message: string } };
  if (!r.ok || !j.package) throw new Error(j.error?.message ?? t("post.couldNotAct"));
  return j.package;
}

/** The key of a deferred approval: project and post. */
export const approveKey = (pkgId: string, project: string | null = getProjectId()) => `${project ?? ""}/${pkgId}`;

/**
 * Approve with Undo: no confirmation; a toast with Undo for 8 s, and the approval is sent when that
 * time is up (approve-undo.ts). The two review checks before it stay: they are the reviewer's own statement.
 */
export function approveWithUndo(pkg: RealPackage, { say, onChange }: { say: Say; onChange: (p: RealPackage) => void }): void {
  // The project is read once, at the click: switching project inside the 8 s must not approve another post.
  const project = getProjectId();
  const undo = deferApprove(
    approveKey(pkg.id, project),
    async ({ keepalive }) => {
      const done = await postAction(pkg.id, { action: "approve", project }, { keepalive });
      // Another project is shown now: its list has its own post with this number, so only refresh.
      if (getProjectId() === project) onChange(done);
      notifyChanged("content", "calendar", "campaigns");
    },
    (e) => {
      say(t("post.approveFailed", { id: pkg.id, message: e.message }));
      notifyChanged("content");
    },
  );
  say(t("post.approved", { id: pkg.id }), {
    onUndo: () => {
      // The toast closes itself after Undo; the confirmation follows on the next tick.
      if (undo()) setTimeout(() => say(t("post.approveUndone", { id: pkg.id })), 0);
    },
  });
}

/**
 * Every action that is valid for a post in its current status: approve (after the two checks, with Undo), post
 * now, schedule, unschedule, check status, resolve an unclear result, confirm the AI label, record a hand-made
 * post, reject. Confirms use the shared Dialog shape (a question naming the post, one consequence
 * line, a confirm that repeats the verb). At most one primary button is visible at a time.
 */
export function PackageActions({
  pkg,
  live,
  scheduling,
  say,
  onChange,
  reload,
  confirm: confirmProp,
  timeZone,
  layout,
}: {
  pkg: RealPackage;
  live: Live;
  scheduling?: Live;
  say: Say;
  onChange: (p: RealPackage) => void;
  reload: () => Promise<void>;
  /** Asks before anything that posts, schedules or rejects. Defaults to its own Studio Dialog (ui/Dialog.tsx). */
  confirm?: ConfirmFn;
  /** The project time zone for every date and time shown; the default zone when unset. */
  timeZone?: string | null;
  /**
   * Places the parts: the drawer puts `primary` (the status's one filled button) and `secondary` (Reject) in its
   * sticky footer and `body` in its scrolling body. Without it they are stacked in place.
   */
  layout?: (parts: { body: ReactNode; primary: ReactNode; secondary: ReactNode }) => ReactNode;
}) {
  const own = useConfirm();
  const confirm = confirmProp ?? own.confirm;
  const approving = useApproving().has(approveKey(pkg.id));
  const [openedAt] = useState(() => Date.now());
  const [url, setUrl] = useState("");
  const [aiLabel, setAiLabel] = useState(false);
  const [checks, setChecks] = useState({ look: false, claims: false });
  const { act, busy, doing, err } = usePackageAct(pkg.id, { onChange, reload, say });
  const media = pkg.files.filter((f) => f.role !== "caption");
  const when = (iso: string | null | undefined) => formatWhenIn(timeZone, iso);
  const ask = async (req: ConfirmRequest, body: Record<string, unknown>, okText: string) => {
    if (await confirm(req)) await act(body, okText);
  };
  const scheduleRequest = (iso: string): ConfirmRequest => ({
    title: t("post.scheduleTitle", { id: pkg.id, when: when(iso) }),
    body: scheduling?.provider === "signal" ? t("post.scheduleBodySignal") : t("post.scheduleBodyProvider"),
    confirmLabel: t("post.scheduleConfirm"),
  });
  const overdue = isOverdue(pkg, openedAt);
  const times = overdue && pkg.plannedFor ? overdueTimes(pkg.plannedFor, openedAt, timeZone) : null;
  /** An overdue post: one confirm, then re-plan to `iso` and schedule it there (only on this click). */
  const scheduleOverdue = async (iso: string) => {
    if (!(await confirm(scheduleRequest(iso)))) return;
    if (await act({ action: "plan", plannedFor: iso }, "")) await act({ action: "schedule" }, t("post.scheduled", { id: pkg.id, when: when(iso) }));
  };
  const linkOk = url.trim().length > 0;
  const busyReason = t("post.busyReason");

  // The one primary for the post's status. The statuses do not overlap, so at most one is set.
  const approveButton =
    pkg.status === "ready" && !approving ? (
      <Button level="primary" disabled={busy || !checks.look || !checks.claims} reason={busy ? busyReason : t("post.approveReason")} onClick={() => approveWithUndo(pkg, { say, onChange })}>
        {t("post.approve")}
      </Button>
    ) : null;
  const sendButton =
    pkg.status === "approved" && live.enabled ? (
      <Button
        level="primary"
        busy={busy && doing === "send"}
        disabled={busy}
        reason={busyReason}
        onClick={() => void ask({ title: t("post.sendTitle", { id: pkg.id, handle: pkg.destination }), body: t("post.sendBody"), confirmLabel: t("post.sendNow") }, { action: "send" }, t("post.sent", { id: pkg.id }))}
      >
        {t("post.sendNow")}
      </Button>
    ) : null;
  const recordButton =
    pkg.status === "approved" ? (
      // Secondary while "Post now" is the primary (one filled button).
      <Button level={live.enabled ? "secondary" : "primary"} busy={busy && doing === "posted"} disabled={busy || !linkOk || !aiLabel} reason={busy ? busyReason : t("post.recordReason")} onClick={() => void act({ action: "posted", url, aiLabel }, t("post.recorded", { id: pkg.id }))}>
        {t("post.record")}
      </Button>
    ) : null;
  const isLiveButton = needsResolve(pkg) ? (
    <Button level="primary" busy={busy && doing === "resolve"} disabled={busy || !linkOk} reason={busy ? busyReason : t("post.link")} onClick={() => void act({ action: "resolve", posted: true, url }, t("post.recorded", { id: pkg.id }))}>
      {t("post.isLive")}
    </Button>
  ) : null;
  const labelButton =
    pkg.status === "posted" && !pkg.labelConfirmed ? (
      <Button level="primary" busy={busy && doing === "label"} disabled={busy} reason={busyReason} onClick={() => void act({ action: "label" }, t("post.labelConfirmed"))}>
        {t("post.labelConfirm")}
      </Button>
    ) : null;
  const primary = approveButton ?? sendButton ?? (live.enabled ? null : recordButton) ?? isLiveButton ?? labelButton;
  const secondary =
    canReject(pkg) && !approving ? (
      <Button level="destructive" busy={busy && doing === "discard"} disabled={busy} reason={busyReason} onClick={() => void ask(rejectRequest(pkg.id), { action: "discard" }, t("post.rejected", { id: pkg.id }))}>
        {t("post.reject")}
      </Button>
    ) : null;

  const body = (
    <div className="st-stack pa">
      {confirmProp ? null : own.node}
      {pkg.status === "changed" || pkg.status === "invalid" ? (
        <div className="st-stack pa-group">
          <p className="st-small pa-bad">{t("posts.filesChanged")}</p>
          {pkg.problems.length ? (
            <More label={t("notice.details")}>
              <ul className="real-problems st-small">
                {pkg.problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </More>
          ) : null}
        </div>
      ) : null}

      {pkg.status === "ready" ? (
        approving ? (
          <p className="st-small" role="status">
            {t("posts.approving")}
          </p>
        ) : (
          <div className="st-stack pa-group">
            <label className="real-check">
              <input type="checkbox" checked={checks.look} onChange={(e) => setChecks({ ...checks, look: e.target.checked })} /> {t("post.checkLook")}
            </label>
            <label className="real-check">
              <input type="checkbox" checked={checks.claims} onChange={(e) => setChecks({ ...checks, claims: e.target.checked })} /> {t("post.checkClaims")}
            </label>
          </div>
        )
      ) : null}

      {overdue ? (
        <p className="st-small pa-warn" role="status">
          {OVERDUE_TEXT}
        </p>
      ) : pkg.status === "approved" && pkg.missedAt ? (
        <p className="st-small pa-warn" role="status">
          {t("post.missed")}
        </p>
      ) : null}

      {pkg.status === "approved" && live.enabled ? (
        times ? (
          scheduling?.enabled ? (
            <div className="pa-row">
              {times.atPlannedTime ? (
                <Button level="secondary" dense busy={busy && (doing === "plan" || doing === "schedule")} disabled={busy} reason={busyReason} onClick={() => void scheduleOverdue(times.atPlannedTime!)}>
                  {t("post.scheduleFor", { when: when(times.atPlannedTime) })}
                </Button>
              ) : null}
              <Button level="secondary" dense busy={busy && (doing === "plan" || doing === "schedule")} disabled={busy} reason={busyReason} onClick={() => void scheduleOverdue(times.soonest)}>
                {t("post.scheduleNow", { when: when(times.soonest) })}
              </Button>
            </div>
          ) : (
            <span className="xs st-muted">{t("post.planFirst")}</span>
          )
        ) : pkg.plannedFor && Date.parse(pkg.plannedFor) > openedAt + 10 * 60_000 ? (
          scheduling?.enabled ? (
            <div className="pa-row">
              <Button
                level="secondary"
                dense
                busy={busy && doing === "schedule"}
                disabled={busy}
                reason={busyReason}
                onClick={() => void ask(scheduleRequest(pkg.plannedFor!), { action: "schedule" }, t("post.scheduled", { id: pkg.id, when: when(pkg.plannedFor) }))}
              >
                {t("post.scheduleFor", { when: when(pkg.plannedFor) })}
              </Button>
            </div>
          ) : scheduling?.reason ? (
            <More label={t("posts.why")}>
              <span>{scheduling.reason}</span>
            </More>
          ) : null
        ) : (
          <span className="xs st-muted">{t("post.planFirst")}</span>
        )
      ) : null}

      {pkg.status === "scheduled" && pkg.scheduled ? (
        <div className="pa-row">
          <span className="st-small">{t("post.goesOut", { when: when(pkg.scheduled.scheduled_for) })}</span>
          <Button
            level="secondary"
            dense
            busy={busy && doing === "cancel-schedule"}
            disabled={busy}
            reason={busyReason}
            onClick={() => void ask({ title: t("post.unscheduleTitle", { id: pkg.id }), body: t("post.unscheduleBody"), confirmLabel: t("post.unscheduleConfirm") }, { action: "cancel-schedule" }, t("post.unscheduled", { id: pkg.id }))}
          >
            {t("post.unschedule")}
          </Button>
        </div>
      ) : null}

      {/* The provider's own words stay behind Details (no server text as the main line). */}
      {pkg.outcome?.message && pkg.status !== "posted" ? (
        <More label={t("notice.details")}>
          <span>{pkg.outcome.message}</span>
        </More>
      ) : null}

      {needsCheck(pkg) ? (
        <div>
          <Button level="secondary" dense busy={busy && doing === "check"} disabled={busy} reason={busyReason} onClick={() => void act({ action: "check" }, t("post.statusChecked"))}>
            {t("post.checkStatus")}
          </Button>
        </div>
      ) : null}

      {needsResolve(pkg) ? (
        <div className="st-stack pa-group">
          <span className="st-small">{t("post.resolveLine", { handle: pkg.destination })}</span>
          <input className="st-input" type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("post.link")} />
          {pkg.status === "uncertain" ? (
            <div className="pa-row">
              <Button
                level="secondary"
                dense
                disabled={busy}
                reason={busyReason}
                onClick={() => void ask({ title: t("post.notLiveTitle", { id: pkg.id }), body: t("post.notLiveBody"), confirmLabel: t("post.notLiveConfirm") }, { action: "resolve", posted: false }, t("post.markedNotLive", { id: pkg.id }))}
              >
                {t("post.notLive")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {labelButton ? (
        <span className="st-small">
          {t("post.labelLine")}{" "}
          {pkg.posted?.url ? (
            <a className="real-link" href={pkg.posted.url} target="_blank" rel="noreferrer">
              {t("post.viewLive")}
            </a>
          ) : null}
        </span>
      ) : null}

      {pkg.status === "approved" ? (
        <details className="st-stack pa-group" open={!live.enabled}>
          <summary className="st-small st-muted">{live.enabled ? t("post.byHandInstead") : t("post.byHand")}</summary>
          <span className="st-small">{t("post.byHandSteps")}</span>
          <span className="st-small pa-row">
            {media.map((f, i) => (
              <a key={f.name} className="real-link" href={fileUrl(pkg.id, f.name, true)}>
                {t("post.download")} {media.length > 1 ? i + 1 : ""}
              </a>
            ))}
          </span>
          <input className="st-input" type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("post.link")} />
          <label className="real-check">
            <input type="checkbox" checked={aiLabel} onChange={(e) => setAiLabel(e.target.checked)} /> {t("post.aiLabelOn")}
          </label>
          {/* With one-click posting on, recording by hand is the secondary way and stays here. */}
          {live.enabled ? <div>{recordButton}</div> : null}
        </details>
      ) : null}

      {err ? (
        <p className="real-error st-small" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );

  if (layout) return <>{layout({ body, primary, secondary })}</>;
  return (
    <div className="st-stack pa-standalone">
      {body}
      {primary || secondary ? (
        <div className="pa-row">
          {primary}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}

/** Reject uses the shared Dialog: "Reject post 12?" / "It will not be posted." / [Cancel] [Reject post]. */
export function rejectRequest(id: string): ConfirmRequest {
  return { title: t("post.rejectTitle", { id }), body: t("post.rejectBody"), confirmLabel: t("post.rejectConfirm"), destructive: true };
}

/** One format the project can make, as the server names it (GET /api/studio/content `formats`). */
export interface MakeFormat {
  id: string;
  label: string;
}
/** Formats that take a written brief, and the switches each one needs. Labels always come from the server. */
const BRIEF = new Set(["codex-post", "higgsfield-image", "higgsfield-reel"]);
const NEEDS_CODEX = ["codex-post"];
const NEEDS_HIGGSFIELD = ["higgsfield-image", "higgsfield-reel"];
const MAKE_SECONDS: Record<string, number> = { "codex-post": 150, "website-card": 12, "higgsfield-image": 90, "higgsfield-reel": 300 };

/** The progress steps of a make, by format. */
function makeSteps(format: string): string[] {
  if (format === "higgsfield-reel") return [t("make.step.prompt"), t("make.step.hfStill"), t("make.step.animate"), t("make.step.convert"), t("make.step.save")];
  if (format === "higgsfield-image") return [t("make.step.prompt"), t("make.step.hfImage"), t("make.step.text"), t("make.step.save")];
  if (format === "codex-post") return [t("make.step.prompt"), t("make.step.drawing"), t("make.step.text"), t("make.step.save")];
  if (format === "website-card") return [t("make.step.page"), t("make.step.photo"), t("make.step.slides"), t("make.step.save")];
  return [t("make.step.brief"), t("make.step.visual"), t("make.step.text"), t("make.step.save")];
}

/** Why a format cannot be made right now, or null. */
function offReason(format: string, codex?: Live, higgsfield?: Live): string | null {
  if (NEEDS_CODEX.includes(format) && !codex?.enabled) return t("make.codexOff");
  if (NEEDS_HIGGSFIELD.includes(format) && !higgsfield?.enabled) return higgsfield?.reason || t("make.higgsfieldOff");
  return null;
}

/** The make form (the header's "Make a post" drawer). */
export function GenerateBar({ say, onMade, codex, higgsfield, formats }: { say: (t: string) => void; onMade: (p: RealPackage) => void; codex?: Live; higgsfield?: Live; formats: MakeFormat[] }) {
  const options = formats.map((f) => {
    const off = offReason(f.id, codex, higgsfield);
    return { value: f.id, label: f.label, disabled: off !== null, hint: off ?? undefined };
  });
  // Starts on the first format that can be made now.
  const [format, setFormat] = useState(() => options.find((o) => !o.disabled)?.value ?? options[0]?.value ?? "");
  const [brief, setBrief] = useState({ prompt: "", headline: "", caption: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const router = useRouter();
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/studio/content/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, project: getProjectId(), ...(BRIEF.has(format) ? { brief } : {}) }),
      });
      if (r.status === 401) {
        router.push("/login?next=%2Fstudio");
        return;
      }
      const j = (await r.json()) as { package?: RealPackage; error?: { message: string } };
      if (!r.ok || !j.package) throw new Error(j.error?.message ?? t("make.couldNotMake"));
      onMade(j.package);
      notifyChanged('content', 'calendar');
      say(t("posts.slot.made", { id: j.package.id }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const briefShort = BRIEF.has(format) && brief.prompt.trim().length < 10;
  const off = offReason(format, codex, higgsfield);
  const intro = format === "codex-post" ? t("make.intro.brief") : format === "website-card" ? t("make.intro.website") : format === "higgsfield-image" ? t("make.intro.hfImage") : format === "higgsfield-reel" ? t("make.intro.hfReel") : null;
  return (
    <div className="real-gen gen-form">
      {intro ? <span className="st-small st-muted gen-intro">{intro}</span> : null}
      <Select className="real-select" label={t("make.format")} value={format} disabled={busy} onChange={(v) => setFormat(v)} options={options} />
      {BRIEF.has(format) ? (
        <div className="gen-brief">
          <label className="wiz-field">
            {t("make.prompt")}
            <textarea
              className="st-input gen-text"
              rows={3}
              maxLength={800}
              value={brief.prompt}
              onChange={(e) => setBrief({ ...brief, prompt: e.target.value })}
              placeholder={t("make.promptExample")}
            />
          </label>
          <div className="row-wrap gen-row">
            <label className="wiz-field gen-grow">
              {t("make.headline")}
              <input className="st-input" maxLength={70} value={brief.headline} onChange={(e) => setBrief({ ...brief, headline: e.target.value })} placeholder={t("make.headlineExample")} />
            </label>
          </div>
          <label className="wiz-field">
            {t("make.caption")}
            <textarea className="st-input gen-text" rows={3} maxLength={1900} value={brief.caption} onChange={(e) => setBrief({ ...brief, caption: e.target.value })} placeholder={t("make.captionHint")} />
          </label>
        </div>
      ) : null}
      <div>
        <Button
          level="primary"
          busy={busy}
          disabled={busy || !format || briefShort || off !== null}
          reason={busy ? t("make.making") : !format ? t("make.noFormat") : (off ?? t("make.promptShort"))}
          onClick={() => void run()}
        >
          {busy ? t("make.making") : t("make.submit")}
        </Button>
      </div>
      {busy ? (
        <div className="gen-full">
          <TaskProgress active title={t("make.progress")} steps={makeSteps(format)} expectedSeconds={MAKE_SECONDS[format] ?? 15} />
        </div>
      ) : null}
      {err ? (
        <p className="real-error st-small gen-full" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
