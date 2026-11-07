// Studio interface copy, English. Keyed messages with `{name}` placeholders and an
// ICU-style `{count, plural, one {…} other {…}}` subset, so no sentence is built by concatenation.
// This file holds the shared component and header strings; the tab passes move each screen's own copy here.
import { enPlan } from './en-plan';
import { enPostmaker } from './en-postmaker';

export const en = {
  // Plan, Learn and Setup tabs (copy/en-plan.ts)
  ...enPlan,
  // Post maker screens (copy/en-postmaker.ts)
  ...enPostmaker,

  // Shell: brand, navigation, header
  'shell.brand': 'Signal',
  'shell.product': 'Content Studio',
  'shell.nav': 'Studio',
  'shell.signOut': 'Sign out',
  'shell.makePost': 'Make a post',
  'shell.postsBadge': '{count, plural, one {# needs you} other {# need you}}',

  // Tab titles (one per screen, also the page title)
  'tab.today': 'Today',
  'tab.campaigns': 'Campaigns',
  'tab.pipelines': 'Pipelines',
  'tab.calendar': 'Calendar',
  'tab.posts': 'Posts',
  'tab.library': 'Library',
  'tab.results': 'Results',
  'tab.comments': 'Comments',
  'tab.brand': 'Brand',
  'tab.memory': 'Memory',
  'tab.connections': 'Connections',

  // Dialog and drawer
  'dialog.cancel': 'Cancel',
  'dialog.continue': 'Continue',
  'drawer.close': 'Close',
  'drawer.back': 'Back',
  'drawer.discardTitle': 'Discard changes?',
  'drawer.discardBody': 'Your edits are not saved.',
  'drawer.discardConfirm': 'Discard changes',

  // Long task progress
  'task.usuallySeconds': 'Usually about {seconds} s.',
  'task.usuallyMinutes': 'Usually about {minutes} min.',
  'task.slow': 'Taking longer than usual. It is still working; you can leave this screen open.',

  // Toast
  'toast.undo': 'Undo',

  // State patterns
  'notice.tryAgain': 'Try again',
  'notice.details': 'Details',
  'notice.why': 'Why?',
  'notice.openConnections': 'Open Connections',
  'notice.resume': 'Resume',
  'notice.loading': 'Loading {thing}',
  'notice.couldNotLoad': '{thing} could not load.',
  'notice.paused': 'Paused.',
  'notice.serviceOff': '{service} is off.',
  'notice.serviceNeedsKey': '{service} needs a key.',

  // ---- Work group: Today, Posts with Gallery, Calendar.
  // Today
  'today.block.title': 'Connect {service}',
  'today.block.line': '{count, plural, one {Post {id} is planned for {when}.} other {# posts planned, first {when}.}}',
  'today.block.open': 'Open {service} in Connections',
  'today.needsYou': 'Needs you',
  'today.nothing': 'Nothing needs you.',
  'today.seeAll': 'See all in Posts',
  'today.nextUp': 'Next up',
  'today.nothingNext': 'Nothing planned.',
  'today.openCalendar': 'Open calendar',
  'today.latest': 'Latest',
  'today.noLatest': 'No posts yet.',
  'today.expires': '{days, plural, =0 {Posting settings end today.} one {Posting settings end in # day.} other {Posting settings end in # days.}}',
  'today.capNear': '{left, plural, =0 {No posts left in the account limits.} one {# post left in the account limits.} other {# posts left in the account limits.}}',
  'today.couldNotLoad': 'Today could not load.',
  'today.loading': 'Loading today',

  // Posts: columns, tabs, cards
  'posts.col.toApprove': 'To approve',
  'posts.col.approved': 'Approved',
  'posts.col.posted': 'Posted',
  'posts.col.rejected': 'Rejected',
  'posts.tab.board': 'Board',
  'posts.tab.gallery': 'Gallery',
  'posts.tabs': 'Posts views',
  'posts.empty.planned': 'Nothing to approve.',
  'posts.empty.review': 'Nothing approved yet.',
  'posts.empty.posted': 'Nothing posted yet.',
  'posts.empty.rejected': 'Nothing rejected.',
  'posts.empty.gallery': 'No posts yet.',
  'posts.origin.postmaker': 'Post maker · {template} v{version}',
  'posts.origin.campaign': 'Campaign · {name}',
  'posts.origin.pipeline': 'Pipeline · {name}',
  'posts.origin.made': 'Made in Signal',
  'posts.origin.uploaded': 'Uploaded',
  'posts.overdue': 'Planned time passed.',
  'posts.filesChanged': 'Files changed since approval. Make it again.',
  'posts.noDay': 'No day yet',
  'posts.approving': 'Approving…',
  'posts.posting.auto': 'Posting on',
  'posts.posting.hand': 'Posting by hand',
  'posts.why': 'Why?',
  'posts.moveTo': 'Move post {id}',
  'posts.moveLabel': 'Move post {id} to',
  'posts.open': 'Open post {id}',
  'posts.couldNotLoad': 'Posts could not load.',
  'posts.loading': 'Loading posts',
  'posts.staleData': 'Posts could not refresh.',
  'posts.filter': 'Show',
  'posts.filter.posted': 'Posted',
  'posts.filter.all': 'All',
  'posts.views': 'views',
  'posts.slot.made': 'Post {id} made. It is in To approve.',
  'posts.slot.madeNoId': 'Post made. It is in To approve.',
  'posts.slot.notMade': 'Not made yet',
  'posts.slot.make': 'Make',
  'posts.slot.making': 'Making',

  // Posts: why a move on the board is refused, and the toast when a two-step move stopped halfway
  'posts.refuse.movedOnItsOwn': 'Post {id} moved on its own. The board was refreshed.',
  'posts.refuse.posted': 'Post {id} is already posted. Take it down on Instagram.',
  'posts.refuse.rejected': 'Post {id} stays rejected. Make a new post.',
  'posts.refuse.sending': 'Post {id} is sending. Check its status first.',
  'posts.refuse.approved': 'Post {id} is approved. Reject it to stop it.',
  'posts.refuse.failed': 'Post {id} failed. Open it to check its status.',
  'posts.refuse.scheduled': 'Post {id} is scheduled. Unschedule it first.',
  'posts.partial.approved': 'Post {id} was approved',
  'posts.partial.unscheduled': 'The schedule for post {id} was cancelled',
  'posts.partial.updated': 'Post {id} was updated',
  'posts.partial.notScheduled': 'not scheduled',
  'posts.partial.notPosted': 'not posted',
  'posts.partial.notRecorded': 'not recorded as posted',
  'posts.partial.notRejected': 'not rejected',
  'posts.partial.notFinished': 'not finished',
  'posts.partial.withError': '{did}, but {not}: {error}',
  'posts.partial.noError': '{did}, but {not}.',

  // Posts: drawer, 60 words
  'post.title': 'Post {id}',
  'post.timeline': 'Where this post stands',
  'post.step.made': 'Made',
  'post.step.approved': 'Approved',
  'post.step.scheduled': 'Scheduled',
  'post.step.posted': 'Posted',
  'post.step.rejected': 'Rejected',
  'post.caption': 'Caption',
  'post.copyCaption': 'Copy caption',
  'post.copied': 'Caption copied.',
  'post.copyFailed': 'Select the caption and copy it.',
  'post.viewLive': 'View post',
  'post.checkLook': 'I checked every slide, the caption and the AI label.',
  'post.checkClaims': 'Claims and rights notes are correct.',
  'post.approve': 'Approve',
  'post.approveReason': 'Tick both checks first.',
  'post.approved': 'Post {id} approved.',
  'post.approveUndone': 'Post {id} not approved.',
  'post.approveFailed': 'Post {id} was not approved: {message}',
  'post.reject': 'Reject',
  'post.rejectTitle': 'Reject post {id}?',
  'post.rejectBody': 'It will not be posted.',
  'post.rejectConfirm': 'Reject post',
  'post.rejected': 'Post {id} rejected.',
  'post.sendNow': 'Post now',
  'post.sendTitle': 'Post {id} to {handle} now?',
  'post.sendBody': 'It goes out once and cannot be undone here.',
  'post.sent': 'Post {id} sent.',
  'post.schedule': 'Schedule',
  'post.scheduleFor': 'Schedule for {when}',
  'post.scheduleNow': 'Schedule for {when}',
  'post.scheduleTitle': 'Schedule post {id} for {when}?',
  'post.scheduleBodySignal': 'Signal sends it then, while it runs on this computer.',
  'post.scheduleBodyProvider': 'It goes out then, even if this computer is off.',
  'post.scheduleConfirm': 'Schedule post',
  'post.scheduled': 'Post {id} scheduled for {when}.',
  'post.planFirst': 'Plan a time in the Calendar to schedule it.',
  'post.goesOut': 'Goes out {when}.',
  'post.unschedule': 'Unschedule',
  'post.unscheduleConfirm': 'Unschedule post',
  'post.unscheduleTitle': 'Unschedule post {id}?',
  'post.unscheduleBody': 'It stays approved and will not go out by itself.',
  'post.unscheduled': 'Post {id} unscheduled.',
  'post.checkStatus': 'Check status',
  'post.statusChecked': 'Status checked.',
  'post.resolveLine': 'Is it on {handle}? Paste its link.',
  'post.link': 'Post link',
  'post.isLive': 'It is posted',
  'post.notLive': 'It is not posted',
  'post.notLiveTitle': 'Mark post {id} as not posted?',
  'post.notLiveBody': 'A replacement needs a new post.',
  'post.notLiveConfirm': 'Mark not posted',
  'post.markedNotLive': 'Post {id} marked as not posted.',
  'post.recorded': 'Post {id} recorded as posted.',
  'post.labelLine': 'Check the AI label shows on the post.',
  'post.labelConfirm': 'Label is visible',
  'post.labelConfirmed': 'AI label confirmed.',
  'post.byHand': 'Post it by hand',
  'post.byHandInstead': 'Or post it by hand',
  'post.download': 'Download',
  'post.byHandSteps': 'Post the files with caption and AI label, then paste the link.',
  'post.aiLabelOn': 'The AI label is on for this post.',
  'post.record': 'Record as posted',
  'post.recordReason': 'Paste the link and tick the AI label.',
  'post.missed': 'Missed its time. Nothing was posted.',
  'post.busyReason': 'Working…',
  'post.couldNotAct': 'Something went wrong.',

  // Calendar, 40 words; drawer 25 words
  'calendar.region': 'Calendar',
  'calendar.thisAccount': 'This account',
  'calendar.allAccounts': 'All accounts',
  'calendar.accounts': 'Accounts shown',
  'calendar.changeWeek': 'Change week',
  'calendar.previous': 'Previous week',
  'calendar.next': 'Next week',
  'calendar.thisWeek': 'This week',
  'calendar.account': 'Account',
  'calendar.today': 'Today',
  'calendar.week': 'Week of {range}',
  'calendar.notPlanned': 'Not planned',
  'calendar.allPlanned': 'Everything is planned.',
  'calendar.nothingPlanned': 'Nothing planned',
  'calendar.twoPosts': 'More than one post',
  'calendar.clocksBack': 'Clocks go back on {day}.',
  'calendar.clocksForward': 'Clocks go forward on {day}.',
  'calendar.ownAccount': 'A post moves within its own account only.',
  'calendar.couldNotLoad': 'The calendar could not load.',
  'calendar.loading': 'Loading the calendar',
  'calendar.day': 'Day',
  'calendar.time': 'Time',
  'calendar.timeError': 'Use HH:MM, for example 18:00.',
  'calendar.plannedOnly': 'Planned only. Not scheduled.',
  'calendar.scheduledLine': 'Scheduled. It goes out at this time.',
  'calendar.lockedPosted': 'Posted {when}.',
  'calendar.lockedSending': 'Sending. Its time cannot change.',
  'calendar.save': 'Save',
  'calendar.move': 'Move',
  'calendar.unplan': 'Unplan',
  'calendar.unschedule': 'Unschedule',
  'calendar.openInPosts': 'Open in Posts',
  'calendar.planned': 'Post {id} planned for {when}.',
  'calendar.unplanned': 'Post {id} unplanned.',
  'calendar.moved': 'Post {id} moved to {when}.',
  'calendar.unscheduled': 'Post {id} unscheduled.',
  'calendar.moveTitle': 'Move post {id} to {when}?',
  'calendar.moveBody': 'It is scheduled and goes out at the new time.',
  'calendar.moveConfirm': 'Move post',
  'calendar.unscheduleTitle': 'Unschedule post {id}?',
  'calendar.unscheduleBody': 'It stays approved and planned for {when}.',
  'calendar.unscheduleConfirm': 'Unschedule post',
  'calendar.couldNotPlan': 'Could not plan the post.',
  'calendar.filter': 'Filter',
  'calendar.campaignChip': 'Campaign: {name}',
  'calendar.campaignChipUnnamed': 'This campaign',
  'calendar.clear': 'Clear',

  // Make a post (header drawer until Post maker, ships)
  'make.title': 'Make a post',
  'make.format': 'Post format',
  'make.codexOff': 'Codex images are off for this account.',
  'make.higgsfieldOff': 'Higgsfield is off.',
  'make.noFormat': 'No post format is ready for this project yet.',
  'make.intro.brief': 'Describe the image. Codex draws it; Signal adds the headline and labels.',
  'make.intro.website': "Two slides from your website's next page. Import it in Brand first.",
  'make.intro.hfImage': 'Describe the image. Higgsfield makes it, paid per request.',
  'make.intro.hfReel': 'Describe the first frame. Higgsfield animates a 5-second Reel, paid per request.',
  'make.prompt': 'What should the image show?',
  'make.promptExample': 'For example: a quiet street at dusk, soft light, photo style',
  'make.promptShort': 'Describe the image in a few words first.',
  'make.headline': 'Headline on the image (optional)',
  'make.headlineExample': 'For example: New this week',
  'make.caption': 'Caption (optional)',
  'make.captionHint': 'Leave empty to use the headline',
  'make.submit': 'Make it',
  'make.making': 'Making',
  'make.progress': 'Making the post',
  'make.step.prompt': 'Writing the image prompt',
  'make.step.drawing': 'Codex is drawing the image',
  'make.step.text': 'Adding text and labels',
  'make.step.page': 'Reading the page',
  'make.step.photo': 'Fetching the photo',
  'make.step.slides': 'Rendering slides',
  'make.step.save': 'Saving the post',
  'make.step.brief': 'Reading the brief',
  'make.step.visual': 'Making the visual',
  'make.step.hfImage': 'Higgsfield is making the image',
  'make.step.hfStill': 'Higgsfield is making the still',
  'make.step.animate': 'Animating the video',
  'make.step.convert': 'Converting for Instagram',
  'make.step.headline': 'Adding headline and labels',
  'make.couldNotMake': 'Could not make the post.',

  // Autopilot mark on a post (Posts drawer)
  'autopilot.mark.badge': 'Made by autopilot',
  'autopilot.mark.autoApproved': 'Auto-approved ({count} in a row).',
  'autopilot.mark.publishes': 'Publishes {when} unless you pull it.',
  'autopilot.mark.notScheduled': 'Not scheduled yet: it will not go out until it is.',
  'autopilot.mark.approvedAt': 'Approved automatically {when}.',
  'autopilot.mark.pull': 'Pull this post',
  'autopilot.mark.pullTitle': 'Pull post {id}?',
  'autopilot.mark.pullBody': 'Its schedule is cancelled and the post is rejected. Nothing goes out.',
  'autopilot.mark.pullConfirm': 'Pull post',
  'autopilot.mark.pulled': 'Post {id} pulled. It will not go out.',

  // Persian content block
  'fa.mock': 'Mock',

  // Post maker connectors: the one-line state of each Connections row (ConnectorStatus.line, at most 8 words)
  'connector.readyPaid': 'Ready · Paid per use',
  'connector.readyPlan': 'Ready · Uses your own plan',
  'connector.readyLocal': 'Ready · Runs on this computer',
  'connector.readyFree': 'Ready · Free to use',
  'connector.offMock': '{service} is off. Runs as mock.',
  'connector.paused': 'Post maker is paused. Runs as mock.',
  'connector.notInstalled': '{service} is not installed.',
  'connector.needsSignIn': 'Sign in to {service} first.',
  'connector.notAllowed': 'Not allowed yet · Turn on its switch',
  'connector.notAllowedTerms': 'Not allowed yet · Accept its terms',
  'connector.notAllowedSite': 'Not allowed · The site’s terms forbid it',
  'connector.checkFailed': '{service} check failed.',
  'connector.keySavedNotTested': 'Key saved. Not tested.',
  'connector.works': '{service} works.',
  'connector.pressRun': 'Needs you: press Run',

  // Post maker check: the verdict pill, hard-gate and check rows, one-line reasons with frame numbers
  'check.verdict.premium': 'Premium',
  'check.verdict.standard': 'Standard',
  'check.verdict.regenerate': 'Regenerate',
  'check.verdict.unscored': 'Unscored',
  'check.unscored.noReviewer': 'No reviewer was available. Score it yourself, or accept as draft.',
  'check.unscored.mock': 'Mock run, so not scored. Accept as draft only.',
  'check.unscored.rejected': "The reviewer's answer was incomplete. Score it yourself, or accept as draft.",
  'check.gate.C3': 'Safe zones clear',
  'check.gate.C8': 'Language correct',
  'check.gate.C11': 'AI label and rights',
  'check.row.loudness': 'Loudness',
  'check.row.safe-zones': 'Safe zones',
  'check.row.caption-match': 'Captions match the voice',
  'check.row.ai-label': 'AI label present',
  'check.row.fonts': 'Fonts',
  'check.row.frame-count': 'Frame count',
  'check.notMeasured': 'Not measured yet.',
  'check.loudness.off': 'Loudness {lufs} LUFS, needs −14 ±1.',
  'check.loudness.peak': 'Peak {tp} dBTP, needs −1.0 or lower.',
  'check.safeZones.hit': '{count, plural, one {# layer sits} other {# layers sit}} in a reserved zone, first at frame {frame}.',
  'check.captions.mismatch': 'Captions differ from the voice at line {line}.',
  'check.captions.coverage': 'Captions cover {pct} % of spoken words.',
  'check.aiLabel.missing': 'AI label missing on frame {frame}.',
  'check.aiLabel.outside': 'AI label outside the safe area on frame {frame}.',
  'check.aiLabel.flag': 'The AI flag does not match the assets.',
  'check.aiLabel.licence': '{count, plural, one {# asset lacks} other {# assets lack}} a complete licence record.',
  'check.fonts.none': 'No font list from the render.',
  'check.fonts.fallback': 'Font {family} is not a bundled file.',
  'check.frames.mismatch': 'Video has {video} frames, timeline {timeline}.',
  'check.frames.audio': 'Audio has {audio} frames, video {video}.',
  'check.pacing.gap': 'No beat for {frames} frames from frame {frame}.',
  'check.pacing.hook': 'Hook lands at frame {frame}, needs {max} or earlier.',
  'check.pacing.hookUnknown': 'Hook timing not measured.',
  'check.pacing.chantLength': 'Chant card at frame {frame} lasts {frames} frames.',
  'check.pacing.chantOffBeat': 'Chant card at frame {frame} is {offset} frames off the beat.',
  'check.pacing.noGrid': 'Chant cards need a declared beat grid.',
  'check.pacing.endCard': 'End card lasts {frames} frames, needs {min} to {max}.',
  'check.flash.tooMany': '{count} flashes within 1 s from frame {frame}.',
  'check.tier.ceiling': 'Motion capped at {max}: {character} has a tier {tier} rig.',
  'check.lipsync.lag': 'Lip-sync on line {line} is {lag} frames off.',
  'check.lipsync.coverage': 'Mouth moves on {pct} % of voiced frames, line {line}.',
  'check.lang.lint': '{count, plural, one {# language error} other {# language errors}} in the narration.',
  'check.capped': 'Capped at {max}: {reason}',
} as const;

export type CopyKey = keyof typeof en;
export type CopyVars = Record<string, string | number>;

const plural = new Intl.PluralRules('en');

/** Finds the matching `}` for the `{` at `open`, counting nesting. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    if (s[i] === '{') depth += 1;
    else if (s[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Formats one message: `{name}` placeholders and `{name, plural, one {…} other {…}}` with `#` for the number. */
export function format(message: string, vars: CopyVars = {}): string {
  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open < 0) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const close = closeOf(message, open);
    if (close < 0) throw new Error(`Unbalanced braces in message: ${message}`);
    const body = message.slice(open + 1, close);
    const m = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(body);
    if (m) {
      const name = m[1]!;
      const n = Number(vars[name] ?? 0);
      const forms: Record<string, string> = {};
      const rest = m[2]!;
      let j = 0;
      while (j < rest.length) {
        const sel = /\s*(=\d+|\w+)\s*\{/y;
        sel.lastIndex = j;
        const s = sel.exec(rest);
        if (!s) break;
        const start = sel.lastIndex - 1;
        const end = closeOf(rest, start);
        forms[s[1]!] = rest.slice(start + 1, end);
        j = end + 1;
      }
      const chosen = forms[`=${n}`] ?? forms[plural.select(n)] ?? forms.other ?? '';
      out += format(chosen, vars).replace(/#/g, String(n));
    } else {
      const name = body.trim();
      if (!(name in vars)) throw new Error(`Missing value for {${name}}`);
      out += String(vars[name]);
    }
    i = close + 1;
  }
  return out;
}

/** The English string for `key`, with its placeholders filled. */
export function t(key: CopyKey, vars?: CopyVars): string {
  return format(en[key], vars);
}
