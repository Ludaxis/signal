// Key easing for the animation system: each key names one of the six curve ids (quality bar, roles) or
// `hold`; this maps the id to its normalised 0 → 1 shape so a key track eases with the same curves the type layer
// uses. No linear easing exists here (nothing organic moves linearly). Pure module.
import { easeInOutCubic, easeInQuad, easeOutBack, easeOutCubic, easeOutQuad, settleProgress } from '../render/curves';
import type { KeyCurve } from './types';

/** Progress 0 → 1 at t (0-1) of a key span of `span` frames. `settle` overshoots (spring), `pop-in` overshoots (back). */
export function easeOf(curve: KeyCurve, t: number, span: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (curve) {
    case 'pop-in':
      return easeOutBack(t);
    case 'slide-in':
      return easeOutCubic(t);
    case 'punch':
      return easeOutQuad(t);
    case 'whip':
      return easeInOutCubic(t);
    case 'settle':
      return settleProgress(t * span, span);
    case 'out-fast':
      return easeInQuad(t);
    case 'hold':
      return 0;
  }
}
