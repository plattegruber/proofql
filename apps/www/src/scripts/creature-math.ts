/**
 * The creature's motion math, ported unchanged from the Claude Design source
 * ("Alive Logo"). Pure functions so they can be unit-tested; the animation
 * loop that uses them is ./creature.ts.
 */

export interface BounceFrame {
  /** Height, in jumps (−1 is the top of a normal jump). */
  y: number;
  sx: number;
  sy: number;
  /** Where the eyes look during the jump (−0.7 up … 0.6 down). */
  up: number;
}

/**
 * One bounce over t ∈ [0, 1] (950 ms) with height multiplier h: anticipation
 * squash (0–0.15), a parabolic jump with stretch (0.15–0.55), a landing
 * squash (0.55–0.72), and a damped jiggle back to rest.
 */
export function bounceCurve(t: number, h: number): BounceFrame {
  const H = h;
  if (t < 0 || t > 1) return { y: 0, sx: 1, sy: 1, up: 0 };
  if (t < 0.15) {
    const e = Math.sin(((t / 0.15) * Math.PI) / 2);
    return { y: 0, sx: 1 + 0.08 * e * H, sy: 1 - 0.12 * e * H, up: -0.3 * e };
  }
  if (t < 0.55) {
    const p = (t - 0.15) / 0.4;
    const a = Math.abs(1 - 2 * p);
    return {
      y: -4 * p * (1 - p) * H,
      sx: 1 - 0.05 * a * H,
      sy: 1 + 0.08 * a * H,
      up: p < 0.5 ? -0.7 : 0.6,
    };
  }
  if (t < 0.72) {
    const q = Math.sin(((t - 0.55) / 0.17) * Math.PI);
    return { y: 0, sx: 1 + 0.11 * q * H, sy: 1 - 0.15 * q * H, up: 0.5 * q };
  }
  const r = (t - 0.72) / 0.28;
  const w = Math.sin(r * Math.PI * 2) * (1 - r);
  return { y: 0, sx: 1 - 0.025 * w, sy: 1 + 0.035 * w, up: 0 };
}

export const BOUNCE_MS = 950;

/**
 * One step of a damped spring, frame-rate independent: `dt` is in 60 fps
 * frames (1 at 60 Hz, 0.5 at 120 Hz). Returns the new [position, velocity].
 */
export function spring(
  x: number,
  v: number,
  target: number,
  k: number,
  d: number,
  dt: number,
): [number, number] {
  let vel = v + (target - x) * k * dt;
  vel *= d ** dt;
  return [x + vel * dt, vel];
}

/** Spring constants from the source: [stiffness, damping]. */
export const SPRINGS = {
  gaze: [0.09, 0.72],
  hover: [0.06, 0.75],
  surprise: [0.05, 0.82],
} as const;

export const BLINK_MS = 150;
/** The second blink of a double blink starts this long after the first. */
export const DOUBLE_BLINK_DELAY_MS = 230;

/** How closed the eyes are (0 open … 1 shut) `elapsed` ms into a blink. */
export function blinkAmount(elapsed: number, double: boolean): number {
  const bl = (t: number) => (t >= 0 && t < 1 ? Math.sin(t * Math.PI) : 0);
  let blink = bl(elapsed / BLINK_MS);
  if (double) {
    blink = Math.max(blink, bl((elapsed - DOUBLE_BLINK_DELAY_MS) / BLINK_MS));
  }
  return blink;
}

/** Eye height multiplier: blinking shuts, happiness squints, surprise widens. */
export function eyeScaleY(blink: number, happy: number, surprise: number) {
  return Math.max(
    0.08,
    (1 - 0.92 * blink) * (1 - 0.5 * happy) * (1 + 0.35 * surprise),
  );
}

/** Next blink: 2.2–6 s away; a quarter of them are double. */
export function nextBlink(now: number, random: () => number = Math.random) {
  return {
    start: now,
    double: random() < 0.25,
    next: now + 2200 + random() * 3800,
  };
}
