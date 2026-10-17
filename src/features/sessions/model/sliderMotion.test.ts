import { describe, expect, it } from "vitest";
import {
  FOLLOW_TAU,
  followStep,
  isSettled,
  springStep,
  type SliderMotion,
} from "./sliderMotion";

function run(
  step: (motion: SliderMotion, target: number, dt: number) => SliderMotion,
  from: SliderMotion,
  target: number,
  ms: number,
  frameMs = 1000 / 60,
) {
  let motion = from;
  const path: number[] = [];
  for (let t = 0; t < ms; t += frameMs) {
    motion = step(motion, target, frameMs / 1000);
    path.push(motion.pos);
  }
  return { motion, path };
}

describe("followStep", () => {
  it("closes the gap smoothly without passing the target", () => {
    const { motion, path } = run(followStep, { pos: 0, vel: 0 }, 100, 200);
    expect(path.every((pos, i) => i === 0 || pos >= path[i - 1])).toBe(true);
    expect(Math.max(...path)).toBeLessThanOrEqual(100);
    expect(100 - motion.pos).toBeLessThan(0.01);
  });

  it("stays within about 1px of a resting pointer after 100ms", () => {
    const { motion } = run(followStep, { pos: 0, vel: 0 }, 55, 100);
    expect(55 - motion.pos).toBeLessThan(1);
  });

  it("does not depend on the frame rate", () => {
    const at60 = run(followStep, { pos: 0, vel: 0 }, 80, 50, 1000 / 60);
    const at120 = run(followStep, { pos: 0, vel: 0 }, 80, 50, 1000 / 120);
    expect(Math.abs(at60.motion.pos - at120.motion.pos)).toBeLessThan(3);
    // One step of a whole time constant covers 1 - 1/e of the way.
    expect(followStep({ pos: 0, vel: 0 }, 1, FOLLOW_TAU).pos).toBeCloseTo(
      1 - Math.exp(-1),
      6,
    );
  });

  it("ignores a frame with no elapsed time", () => {
    const motion = { pos: 3, vel: 9 };
    expect(followStep(motion, 10, 0)).toBe(motion);
  });
});

describe("springStep", () => {
  it("overshoots a little and comes to rest on the target", () => {
    const { motion, path } = run(springStep, { pos: 100, vel: 0 }, 155, 700);
    const overshoot = Math.max(...path) - 155;
    expect(overshoot).toBeGreaterThan(2);
    expect(overshoot).toBeLessThan(0.15 * 55);
    expect(isSettled(motion, 155)).toBe(true);
  });

  it("settles in under half a second", () => {
    const { path } = run(springStep, { pos: 100, vel: 0 }, 155, 1000);
    const frame = path.findIndex((_, i) =>
      path.slice(i).every((pos) => Math.abs(pos - 155) < 0.5),
    );
    expect((frame * 1000) / 60).toBeLessThan(500);
  });

  it("carries the drag's velocity into the settle", () => {
    const resting = springStep({ pos: 150, vel: 0 }, 155, 1 / 60);
    const moving = springStep({ pos: 150, vel: 600 }, 155, 1 / 60);
    expect(moving.pos).toBeGreaterThan(resting.pos);
  });

  it("stays stable over a long frame", () => {
    const { pos } = springStep({ pos: 0, vel: 0 }, 100, 0.1);
    expect(Number.isFinite(pos)).toBe(true);
    expect(pos).toBeLessThan(150);
  });
});

describe("isSettled", () => {
  it("needs both position and velocity to be at rest", () => {
    expect(isSettled({ pos: 100.01, vel: 0.5 }, 100)).toBe(true);
    expect(isSettled({ pos: 100.2, vel: 0 }, 100)).toBe(false);
    expect(isSettled({ pos: 100, vel: 30 }, 100)).toBe(false);
  });
});
