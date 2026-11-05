"use client";
// Post packages: the data hook, the shared per-post actions and the Make-a-post bar. The Posts
// screen (Posts.tsx) shows them as a board and lists. Approve re-checks every file fingerprint on
// the server; posting is by hand or, when posting is switched on for the account, one
// owner-confirmed send. Nothing is approved or posted automatically.
import { useRouter } from "next/navigation";
import { notifyChanged, useOnChanged } from "./sync";
import { useCallback, useEffect, useState } from "react";
import { getProjectId, useProjectId } from "./Projects";
import { Select } from "./Select";
import { TaskProgress } from "./loaders";
import { formatDateTime } from "@/lib/time";

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
  source?: { format?: string; category?: string } | null;
  campaign?: { id: string; name: string; slot: string } | null;
  /** Set when a pipeline made the post: its name shows on the card. */
  pipeline?: { id: string; name: string; slotAt: string } | null;
  /** Set when autopilot made the post. */
  autopilot?: { run: string; campaign: string | null; slot: string; pipeline?: string; madeAt: string; autoApproved: null | { at: string; trustInARow: number; scheduledFor: string | null; via: "meta" | "upload-post" | null } } | null;
}
interface Account {
  destination: string;
  maxPosts: number;
  posted: number;
  open: boolean;
  expiresAt: number;
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
  top: { id: string; title: string; views: number | null; rate: number | null }[];
}
export interface Payload {
  account: Account;
  folder: string;
  packages: RealPackage[];
  live: Live;
  codex?: Live;
  higgsfield?: Live;
  scheduling?: Live;
  instagram?: Live;
  analytics?: Live & { source?: 'instagram' | 'upload-post' | null };
  insights?: Insights;
  project?: { id: string; name: string; handle: string };
}

export const STATUS_LABEL: Record<Status, string> = {
  ready: "Waiting for your OK",
  changed: "Files changed: needs a new package",
  approved: "Approved",
  scheduled: "Scheduled",
  sending: "Sending…",
  submitted: "Publishing on Instagram…",
  uncertain: "Unclear: check before anything else",
  failed: "Not posted",
  posted: "Posted",
  discarded: "Rejected",
  invalid: "Package problem",
};

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
        // The session ended (for example the mock server restarted): sign in again.
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
export function usePackageAct(pkgId: string, { onChange, reload, say }: { onChange: (p: RealPackage) => void; reload: () => Promise<void>; say: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [doing, setDoing] = useState("");
  const [err, setErr] = useState("");
  const router = useRouter();
  const act = useCallback(
    async (body: Record<string, unknown>, okText: string): Promise<boolean> => {
      setBusy(true);
      setDoing(String(body.action ?? ""));
      setErr("");
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
        if (!r.ok || !j.package) throw new Error(j.error?.message ?? "Something went wrong.");
        onChange(j.package);
        notifyChanged("content", "calendar", "campaigns");
        if (okText) say(okText);
        return true;
      } catch (e) {
        setErr((e as Error).message);
        await reload();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [pkgId, onChange, reload, say, router],
  );
  return { act, busy, doing, err, setErr };
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

const needsCheck = (pkg: RealPackage) =>
  pkg.status === "sending" || pkg.status === "scheduled" || pkg.status === "submitted" || pkg.status === "uncertain" || (pkg.status === "failed" && !!pkg.dispatch && !pkg.outcome?.message?.startsWith("Upload-Post rejected"));
const needsResolve = (pkg: RealPackage) => pkg.status === "uncertain" || (pkg.status === "failed" && !!pkg.dispatch && !pkg.outcome?.message?.startsWith("Upload-Post rejected"));
/** Which short action a board card should offer for a post in Review (besides moving it). */
export function quickAction(pkg: RealPackage): "check" | "resolve" | "label" | null {
  if (pkg.status === "posted") return pkg.labelConfirmed ? null : "label";
  if (needsResolve(pkg)) return "resolve";
  if (needsCheck(pkg)) return "check";
  return null;
}

/**
 * Every action that is valid for a package in its current status: approve (after the two checks),
 * post now, schedule, cancel a schedule, check status, resolve an unclear result, confirm the AI
 * label, record a hand-made post, reject. Shared by the Posts drawer; the board's moves run the
 * same server actions through the move rules.
 */
export function PackageActions({
  pkg,
  live,
  scheduling,
  say,
  onChange,
  reload,
  confirm = async (m) => window.confirm(m),
}: {
  pkg: RealPackage;
  live: Live;
  scheduling?: Live;
  say: (t: string) => void;
  onChange: (p: RealPackage) => void;
  reload: () => Promise<void>;
  /** Asks the owner before anything that posts, approves or rejects. Defaults to the browser's confirm box. */
  confirm?: (message: string) => Promise<boolean>;
}) {
  const [openedAt] = useState(() => Date.now());
  const [url, setUrl] = useState("");
  const [aiLabel, setAiLabel] = useState(false);
  const [checks, setChecks] = useState({ look: false, claims: false });
  const { act, busy, doing, err } = usePackageAct(pkg.id, { onChange, reload, say });
  const media = pkg.files.filter((f) => f.role !== "caption");
  const ask = async (message: string, body: Record<string, unknown>, okText: string) => {
    if (await confirm(message)) await act(body, okText);
  };

  return (
    <div className="st-stack" style={{ gap: 14 }}>
      {pkg.problems.length ? (
        <ul className="real-problems st-small">
          {pkg.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}

      {pkg.status === "ready" ? (
        <div className="st-stack" style={{ gap: 8 }}>
          <label className="real-check">
            <input type="checkbox" checked={checks.look} onChange={(e) => setChecks({ ...checks, look: e.target.checked })} /> I looked at every slide and the caption, and the “AI-generated content” label is visible.
          </label>
          <label className="real-check">
            <input type="checkbox" checked={checks.claims} onChange={(e) => setChecks({ ...checks, claims: e.target.checked })} />{" "}
            {pkg.source?.format === "website-card" ? "The text matches the page, and the rights notes in the manifest are fine." : "The claims are true and the rights notes in the manifest are fine."}
          </label>
          <div className="row-wrap" style={{ gap: 8 }}>
            <button
              aria-busy={busy && doing === "approve"}
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              disabled={busy || !checks.look || !checks.claims}
              onClick={() => void ask(`Approve post ${pkg.id} exactly as shown for ${pkg.destination}? Any later change needs a new approval.`, { action: "approve" }, `Post ${pkg.id} approved. It is OK to post now.`)}
            >
              Approve these exact files
            </button>
          </div>
        </div>
      ) : null}

      {pkg.status === "approved" && pkg.missedAt ? (
        <p className="real-outcome st-small real-uncertain" role="status">
          Missed its time{pkg.plannedFor ? ` (${formatDateTime(pkg.plannedFor)})` : ""}
          {pkg.missedReason ? `: ${pkg.missedReason}` : " because Signal was not running"}. Nothing was posted. Post it now or pick a new time in the Calendar.
        </p>
      ) : null}

      {pkg.status === "approved" && live.enabled ? (
        <div className="st-stack" style={{ gap: 8 }}>
          <div>
            <button
              aria-busy={busy && doing === "send"}
              type="button"
              className="st-btn st-btn-primary"
              disabled={busy}
              onClick={() =>
                void ask(
                  `Post ${pkg.id} goes to ${pkg.destination} now, publicly, with the AI label. It is sent once and cannot be undone from here. Send it?`,
                  { action: "send" },
                  `Post ${pkg.id} sent to ${live.provider === "meta" ? "Instagram" : "Upload-Post"}`,
                )
              }
            >
              Post to Instagram now
            </button>
          </div>
          <span className="st-small st-muted">
            Approved {formatDateTime(pkg.approval!.approved_at)} by {pkg.approval!.approved_by} · sent once via {live.provider === "meta" ? "Meta" : "Upload-Post"}, never retried
          </span>
          {pkg.plannedFor && Date.parse(pkg.plannedFor) > openedAt + 10 * 60_000 ? (
            scheduling?.enabled ? (
              <div className="row-wrap" style={{ gap: 8, alignItems: "center" }}>
                <button
                  aria-busy={busy && doing === "schedule"}
                  type="button"
                  className="st-btn st-btn-dark st-btn-sm"
                  disabled={busy}
                  onClick={() =>
                    void ask(
                      scheduling?.provider === "signal"
                        ? `Schedule post ${pkg.id} for ${formatDateTime(pkg.plannedFor!)}? Signal sends it at that time while it is running on your machine. If Signal is off then, it waits for you. You can move or cancel it until then.`
                        : `Schedule post ${pkg.id} on Upload-Post for ${formatDateTime(pkg.plannedFor!)}? It posts at that time even if your machine is off. You can cancel or move it until a minute before.`,
                      { action: "schedule" },
                      `Post ${pkg.id} scheduled`,
                    )
                  }
                >
                  Schedule for {formatDateTime(pkg.plannedFor)}
                </button>
                <span className="xs st-muted">from its Calendar plan</span>
              </div>
            ) : (
              <span className="xs st-muted">{scheduling?.reason}</span>
            )
          ) : (
            <span className="xs st-muted">Plan a time in the Calendar to schedule it.</span>
          )}
        </div>
      ) : null}

      {pkg.status === "scheduled" && pkg.scheduled ? (
        <div className="row-wrap" style={{ gap: 8, alignItems: "center" }}>
          <span className="st-small">
            Goes out <strong>{formatDateTime(pkg.scheduled.scheduled_for)}</strong> {pkg.scheduled.provider === "signal" ? "from Signal (keep it running)" : "via Upload-Post"}.
          </span>
          <button
            aria-busy={busy && doing === "cancel-schedule"}
            type="button"
            className="st-btn st-btn-ghost st-btn-sm"
            disabled={busy}
            onClick={() => void ask(`Cancel the schedule for post ${pkg.id}? It goes back to Approved.`, { action: "cancel-schedule" }, `Schedule for post ${pkg.id} cancelled`)}
          >
            Cancel schedule
          </button>
        </div>
      ) : null}

      {pkg.outcome?.message && pkg.status !== "posted" ? <p className={`real-outcome st-small real-${pkg.status}`}>{pkg.outcome.message}</p> : null}

      {needsCheck(pkg) ? (
        <div className="row-wrap" style={{ gap: 8 }}>
          <button aria-busy={busy && doing === "check"} type="button" className="st-btn st-btn-dark st-btn-sm" disabled={busy} onClick={() => void act({ action: "check" }, "Status checked")}>
            Check status
          </button>
        </div>
      ) : null}

      {needsResolve(pkg) ? (
        <div className="st-stack" style={{ gap: 8 }}>
          <span className="st-small">Check {pkg.destination} on Instagram: paste the link if it is there, or mark it not posted.</span>
          <input className="st-input" type="url" inputMode="url" placeholder="https://www.instagram.com/p/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Instagram post link" />
          <div className="row-wrap" style={{ gap: 8 }}>
            <button aria-busy={busy && doing === "resolve"} type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy || !url} onClick={() => void act({ action: "resolve", posted: true, url }, `Post ${pkg.id} recorded`)}>
              It is on Instagram
            </button>
            {pkg.status === "uncertain" ? (
              <button
                aria-busy={busy && doing === "resolve"}
                type="button"
                className="st-btn st-btn-ghost st-btn-sm"
                disabled={busy}
                onClick={() => void ask(`You checked ${pkg.destination} and the post is not there? It will be marked as not posted; a replacement needs a new package.`, { action: "resolve", posted: false }, `Post ${pkg.id} marked as not posted`)}
              >
                It is not on Instagram
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {pkg.status === "posted" && !pkg.labelConfirmed ? (
        <div className="st-stack" style={{ gap: 8 }}>
          <span className="st-small">
            Posted.{" "}
            {pkg.posted?.url ? (
              <a className="real-link" href={pkg.posted.url} target="_blank" rel="noreferrer">
                Open it on Instagram
              </a>
            ) : (
              `Open ${pkg.destination} on Instagram`
            )}{" "}
            and check the “AI info” label is shown. The next post unlocks after this check.
          </span>
          <div>
            <button aria-busy={busy && doing === "label"} type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy} onClick={() => void act({ action: "label" }, "AI label confirmed")}>
              I checked: label visible, post looks right
            </button>
          </div>
        </div>
      ) : null}

      {pkg.status === "approved" ? (
        <details className="st-stack" style={{ gap: 10 }} open={!live.enabled}>
          <summary className="st-small st-muted">{live.enabled ? "Or post it by hand instead" : "Post it by hand"}</summary>
          <ol className="real-steps st-small">
            <li>
              Download the {media.length > 1 ? "slides" : "file"}:{" "}
              {media.map((f, i) => (
                <a key={f.name} className="real-link" href={fileUrl(pkg.id, f.name, true)}>
                  {media.length > 1 ? `slide ${i + 1}` : f.name}
                  {i < media.length - 1 ? ", " : ""}
                </a>
              ))}
              . Send them to your phone or post from instagram.com.
            </li>
            <li>In Instagram: New post → select {media.length > 1 ? "the slides in order" : "the file"} → paste the caption.</li>
            <li>
              Advanced settings → turn on <strong>Add AI label</strong> → Share.
            </li>
            <li>Paste the post link below.</li>
          </ol>
          <input className="st-input" type="url" inputMode="url" placeholder="https://www.instagram.com/p/…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Instagram post link" />
          <label className="real-check">
            <input type="checkbox" checked={aiLabel} onChange={(e) => setAiLabel(e.target.checked)} /> Instagram’s AI label is on for this post.
          </label>
          <div>
            <button aria-busy={busy && doing === "posted"} type="button" className="st-btn st-btn-primary st-btn-sm" disabled={busy || !url || !aiLabel} onClick={() => void act({ action: "posted", url, aiLabel }, `Post ${pkg.id} recorded`)}>
              Record as posted
            </button>
          </div>
          <span className="st-small st-muted">
            Approved {formatDateTime(pkg.approval!.approved_at)} by {pkg.approval!.approved_by}
          </span>
        </details>
      ) : null}

      {["ready", "changed", "invalid", "approved"].includes(pkg.status) ? (
        <div>
          <button
            aria-busy={busy && doing === "discard"}
            type="button"
            className="st-btn st-btn-ghost st-btn-sm"
            disabled={busy}
            onClick={() => void ask(`Reject post ${pkg.id}? It moves to Rejected and will not be posted (its files stay on disk).`, { action: "discard" }, `Post ${pkg.id} rejected`)}
          >
            Reject this post
          </button>
        </div>
      ) : null}

      {err ? (
        <p className="real-error st-small" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}

const FORMAT_OPTIONS: [string, string][] = [
  ["codex-post", "Codex image post (your idea)"],
  ["website-card", "Website post (from your site)"],
  ["higgsfield-image", "Higgsfield image (paid)"],
  ["higgsfield-reel", "Higgsfield Reel (paid)"],
];
const BRIEF = new Set(["codex-post", "higgsfield-image", "higgsfield-reel"]);

export function GenerateBar({ say, onMade, codex, higgsfield }: { say: (t: string) => void; onMade: (p: RealPackage) => void; codex?: Live; higgsfield?: Live }) {
  const [format, setFormat] = useState("codex-post");
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
      if (!r.ok || !j.package) throw new Error(j.error?.message ?? "Could not generate.");
      onMade(j.package);
      notifyChanged('content', 'calendar');
      say(`Post ${j.package.id} is ready for your approval`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="st-card real-gen row-wrap" style={{ gap: 10, alignItems: "center" }}>
      <div className="st-stack" style={{ gap: 2, flex: "1 1 240px" }}>
        <span style={{ fontWeight: 600 }}>Make the next post</span>
        <span className="st-small st-muted">
          {format === "codex-post"
            ? "Describe the image; Codex draws it, Signal adds the headline and labels."
            : format === "website-card"
              ? "A 2-slide post from the next page on your website (import it on Brand first)."
              : format === "higgsfield-reel"
                ? "Describe the opening frame; Higgsfield makes a still and animates a 5-second Reel (paid per request)."
                : "Describe the image; Higgsfield makes it (paid per request), Signal adds the headline and labels."}
        </span>
      </div>
      <Select
        className="real-select"
        label="Post format"
        value={format}
        disabled={busy}
        onChange={(v) => setFormat(v)}
        options={FORMAT_OPTIONS.map(([v, l]) => {
          const needsCodex = v === "codex-post";
          const needsHf = v.startsWith("higgsfield");
          const off = (needsCodex && !codex?.enabled) || (needsHf && !higgsfield?.enabled);
          return {
            value: v,
            label: l,
            disabled: off,
            hint: needsCodex && !codex?.enabled ? "Codex images are off for this account" : needsHf && !higgsfield?.enabled ? higgsfield?.reason || "Higgsfield is off" : undefined,
          };
        })}
      />
      {BRIEF.has(format) ? (
        <div className="gen-brief">
          <label className="wiz-field">
            What should the image show?
            <textarea
              className="st-input gen-text"
              rows={3}
              maxLength={800}
              value={brief.prompt}
              onChange={(e) => setBrief({ ...brief, prompt: e.target.value })}
              placeholder="e.g. A calm darkroom table with prints drying on a line, warm red safelight, editorial photography style"
            />
          </label>
          <div className="row-wrap" style={{ gap: 10 }}>
            <label className="wiz-field" style={{ flex: "1 1 220px" }}>
              Headline on the image (optional)
              <input className="st-input" maxLength={70} value={brief.headline} onChange={(e) => setBrief({ ...brief, headline: e.target.value })} placeholder="e.g. Open call: Night Streets" />
            </label>
          </div>
          <label className="wiz-field">
            Caption (optional)
            <textarea className="st-input gen-text" rows={3} maxLength={1900} value={brief.caption} onChange={(e) => setBrief({ ...brief, caption: e.target.value })} placeholder="Leave empty to use the headline" />
          </label>
        </div>
      ) : null}
      <button
        type="button"
        className="st-btn st-btn-primary st-btn-sm"
        aria-busy={busy}
        disabled={busy || (BRIEF.has(format) && brief.prompt.trim().length < 10) || (format === "codex-post" && !codex?.enabled) || (format.startsWith("higgsfield") && !higgsfield?.enabled)}
        onClick={() => void run()}
      >
        {busy ? "Generating" : "Generate next post"}
      </button>
      {busy ? (
        <div style={{ flexBasis: "100%" }}>
          <TaskProgress
            active
            title="Making the next post"
            steps={format === "higgsfield-reel" ? ["Writing the prompts", "Higgsfield is making the still", "Animating the video", "Converting for Instagram", "Saving the package"] : format === "codex-post" ? ["Writing the image prompt", "Codex is drawing the image", "Adding text and labels", "Saving the package"] : format === "website-card" ? ["Reading the page", "Fetching the photo", "Rendering slides", "Saving the package"] : ["Writing the image prompt", "Higgsfield is making the image", "Adding text and labels", "Saving the package"]}
            expectedSeconds={format === "higgsfield-reel" ? 300 : format === "codex-post" ? 150 : format === "higgsfield-image" ? 90 : 12}
          />
        </div>
      ) : null}
      {err ? (
        <p className="real-error st-small" role="alert" style={{ flexBasis: "100%" }}>
          {err}
        </p>
      ) : null}
    </div>
  );
}
