# Loading states

`app/studio/loaders.tsx` is the one vocabulary for "something is happening", chosen by how long it takes:

| Duration | What the user sees | Component |
| --- | --- | --- |
| < 150 ms | nothing; spinners never flash | `useDelayedFlag` |
| 150 ms – 1 s | the control itself: busy button (`aria-busy`) with a spinner and a moving sheen | `Spinner` |
| 1 – 10 s, content | skeletons shaped like the content that is coming | `ScreenSkeleton`, `Skeleton`, `SkeletonText` |
| > 10 s, a task | named steps, elapsed time and an honest "usually about N s" bar | `TaskProgress` (`MAKE_STEPS` / `MAKE_SECONDS` in Campaigns) |
| live agent work | the agent Activity panel polling `agent-progress.json` | Campaigns |
| long lists and images | fade in as you scroll, placeholders until decoded, render more near the end | `Reveal`, `LazyImage`, `useProgressiveList`, `LoadMoreSentinel` |

Rules: a loader that appears stays at least 400 ms (no flicker); everything respects `prefers-reduced-motion`; every loader announces itself to screen readers (`role="status"`, labels); long tasks keep going when you leave the screen (the server does the work, the UI only polls).
