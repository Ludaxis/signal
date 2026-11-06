// Runs once when the Signal server starts (Next.js instrumentation hook).
// Starts Signal's own post scheduler: every minute it sends posts whose scheduled time has come.
// It only does anything when the "scheduler" switch is on in signal.config.json and only while this
// server is running; a time that passes while Signal is off becomes "missed" and waits for you.
// A second minute tick runs the autopilot's daily run (switch "autopilot") inside its 08:00–12:00
// window (Studio time zone), once per project per day; a day that passes while Signal is off is skipped.
// SIGNAL_PUBLISH_PAUSED=1 and SIGNAL_AUTOPILOT_PAUSED=1 stop both ticks from doing anything.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Keys and switches saved in Connections (encrypted) apply before anything else runs.
  await import('./lib/studio/app-settings').then((m) => m.applySavedSettings()).catch(() => undefined);
  const g = globalThis as typeof globalThis & { __signalScheduler?: ReturnType<typeof setInterval>; __signalSchedulerRegistered?: boolean; __signalAutopilotScheduler?: ReturnType<typeof setInterval> };
  if (!g.__signalScheduler) {
    const { tickAll } = await import('./lib/studio/publish-meta');
    const run = () => void tickAll().catch(() => undefined);
    g.__signalScheduler = setInterval(run, 60_000);
    g.__signalScheduler.unref?.();
    setTimeout(run, 5_000).unref?.();
  }
  // Read by scheduleInSignal: a Signal schedule is only accepted when this timer exists in this process.
  g.__signalSchedulerRegistered = true;
  if (!g.__signalAutopilotScheduler) {
    // runAll checks the switch, the pause flag and the window itself and skips overlapping calls.
    const { runAll } = await import('./lib/studio/autopilot/runner');
    const tick = () => void runAll().catch(() => undefined);
    g.__signalAutopilotScheduler = setInterval(tick, 60_000);
    g.__signalAutopilotScheduler.unref?.();
    setTimeout(tick, 20_000).unref?.();
  }
}
