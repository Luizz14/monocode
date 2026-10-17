/**
 * The model slider's knob motion: one position (the knob's center, in px
 * from the track's left edge) and its velocity, advanced once per animation
 * frame. The knob and the fill are both drawn from that position.
 */
export type SliderMotion = { pos: number; vel: number };

/**
 * While dragging, the knob closes the gap to its target exponentially with
 * this time constant (seconds): smooth, yet within about 1px of a resting
 * pointer after 100ms.
 */
export const FOLLOW_TAU = 0.022;

/**
 * Settling onto a dot: a spring with a damping ratio of about 0.63, which
 * overshoots by about 8% and comes to rest in about a third of a second.
 */
export const SETTLE_SPRING = { stiffness: 420, damping: 26 } as const;

/** Largest integration step for the spring, for stability at low frame rates. */
const SPRING_SUBSTEP = 0.004;

export function followStep(
  motion: SliderMotion,
  target: number,
  dt: number,
  tau = FOLLOW_TAU,
): SliderMotion {
  if (dt <= 0) return motion;
  const pos = motion.pos + (target - motion.pos) * (1 - Math.exp(-dt / tau));
  return { pos, vel: (pos - motion.pos) / dt };
}

export function springStep(
  motion: SliderMotion,
  target: number,
  dt: number,
  spring: { stiffness: number; damping: number } = SETTLE_SPRING,
): SliderMotion {
  let { pos, vel } = motion;
  let left = dt;
  while (left > 0) {
    const h = Math.min(left, SPRING_SUBSTEP);
    // Semi-implicit Euler: update the velocity first, then move with it.
    vel += (-spring.stiffness * (pos - target) - spring.damping * vel) * h;
    pos += vel * h;
    left -= h;
  }
  return { pos, vel };
}

/** Close enough to stop animating and snap exactly onto the target. */
export function isSettled(motion: SliderMotion, target: number): boolean {
  return Math.abs(motion.pos - target) < 0.05 && Math.abs(motion.vel) < 2;
}
