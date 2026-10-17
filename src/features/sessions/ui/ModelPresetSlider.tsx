import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  dragStepAt,
  SLIDER_KNOB_SIZE,
  SLIDER_TRACK_WIDTH,
  stepAt,
  stepCenter,
  stepForKey,
  type EffortTone,
  type PresetStep,
} from "../model/modelPresetSteps";
import { performHaptic } from "../../../platform/tauri/haptics";
import { RollText } from "../../../shared/ui/RollText";
import { EffortTileShimmer } from "./EffortTileShimmer";
import { ModelFamilyIcon } from "./ModelFamilyIcon";
import type { ModelFamilyInfo } from "../model/modelFamilies";
import {
  followStep,
  isSettled,
  springStep,
  type SliderMotion,
} from "../model/sliderMotion";
// The tile keyframes live with the effort menu that introduced them.
import "./ModelPicker.css";
import "./ModelPresetSlider.css";

type Props = {
  steps: readonly PresetStep[];
  /** The step the session runs now, or -1 when its choice is not a preset. */
  index: number;
  /** What the session runs now, shown while nothing is being dragged. */
  modelLabel: string;
  effortLabel?: string;
  /** The current model's family, for its icon and color. */
  family?: ModelFamilyInfo;
  tone?: EffortTone;
  /** Tick the trackpad as a drag crosses into another step. */
  haptics: boolean;
  /** Opened from the keyboard, so the rail shows its focus ring at once. */
  keyboard?: boolean;
  onCommit: (index: number) => void;
  /** Opens the full model and settings menu. */
  onOpenModels: () => void;
  /** Enter on the track: done choosing. */
  onDone: () => void;
};

type Drag = { pointerId: number; index: number };

let fontsWarmed = false;

/**
 * Starts loading the slider's bundled faces, so the panel opens in them
 * rather than waiting out `font-display: block` on first use.
 */
export function warmSliderFonts() {
  if (fontsWarmed || typeof document === "undefined") return;
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts?.load) return;
  fontsWarmed = true;
  void fonts.load('500 22px "MonoCode Slider Mono"', "Opus").catch(() => {});
  void fonts
    .load('italic 400 22px "MonoCode Slider Serif"', "High")
    .catch(() => {});
}

const KNOB_HALF = SLIDER_KNOB_SIZE / 2;

/** A frame longer than this (a background tab) is integrated as this. */
const MAX_FRAME_SECONDS = 1 / 30;

type Motion = SliderMotion & {
  /** Where the knob is headed: the pointer while dragging, else a dot. */
  target: number;
  mode: "follow" | "settle";
  frame: number;
  last: number;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * The composer's model chooser: the chosen model and effort over a rail with
 * one dot per preset. Drag the knob or click a dot to switch; arrow keys,
 * Page Up/Down, Home, and End step from the keyboard. A drag only shows the
 * step it is over and applies it on release, so the session is not switched
 * on every step along the way.
 */
export function ModelPresetSlider({
  steps,
  index,
  modelLabel,
  effortLabel,
  family,
  tone,
  haptics,
  keyboard = false,
  onCommit,
  onOpenModels,
  onDone,
}: Props) {
  const track = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const motion = useRef<Motion>({
    pos: Number.NaN,
    vel: 0,
    target: 0,
    mode: "settle",
    frame: 0,
    last: 0,
  });
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [focusRing, setFocusRing] = useState(keyboard);
  const count = steps.length;

  // One position, the knob's center, draws both the knob and the fill, so
  // the fill always ends exactly under the knob's center. Both are written
  // straight to the elements: the knob as a transform, the fill as a clip on
  // a full-width bar, so neither moves layout and a drag never renders.
  const paint = (center: number) => {
    if (knob.current) {
      knob.current.style.transform = `translate3d(${center - KNOB_HALF}px, 0, 0)`;
    }
    if (fill.current) {
      fill.current.style.clipPath = `inset(0 ${SLIDER_TRACK_WIDTH - center}px 0 0 round 10px)`;
    }
  };

  const tick = (now: number) => {
    const m = motion.current;
    m.frame = 0;
    const dt = m.last
      ? Math.min((now - m.last) / 1000, MAX_FRAME_SECONDS)
      : 1 / 60;
    m.last = now;
    const next =
      m.mode === "follow"
        ? followStep(m, m.target, dt)
        : springStep(m, m.target, dt);
    m.pos = next.pos;
    m.vel = next.vel;
    const resting =
      m.mode === "follow"
        ? Math.abs(m.pos - m.target) < 0.05
        : isSettled(m, m.target);
    if (resting) {
      // Land exactly; a later pointer move starts the loop again.
      m.pos = m.target;
      m.vel = 0;
      paint(m.pos);
      return;
    }
    paint(m.pos);
    m.frame = requestAnimationFrame(tick);
  };

  /**
   * Heads the knob for `target`: following the pointer, or springing onto a
   * dot. With reduced motion, or before the first paint, it is there at once.
   */
  const animateTo = (target: number, mode: Motion["mode"]) => {
    const m = motion.current;
    m.target = target;
    m.mode = mode;
    if (Number.isNaN(m.pos) || prefersReducedMotion()) {
      if (m.frame) cancelAnimationFrame(m.frame);
      m.frame = 0;
      m.pos = target;
      m.vel = 0;
      paint(target);
      return;
    }
    if (!m.frame) {
      m.last = 0;
      m.frame = requestAnimationFrame(tick);
    }
  };

  // At rest the knob sits on the session's step; a change of step (a key,
  // a release, a preset edit) springs it there.
  useLayoutEffect(() => {
    if (drag.current || index < 0) return;
    animateTo(stepCenter(index, count), "settle");
  }, [index, count, dragIndex]);

  useEffect(
    () => () => {
      const m = motion.current;
      if (m.frame) cancelAnimationFrame(m.frame);
    },
    [],
  );

  // The popover focuses its frame; the track takes focus once it is on
  // screen so the arrow keys work straight away.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      track.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const shown = dragIndex != null ? steps[dragIndex] : undefined;
  const shownModel = shown ? shown.modelLabel : modelLabel;
  const shownEffort = shown ? shown.effortLabel : effortLabel;
  const shownFamily = shown ? shown.family : family;
  const shownTone = shown ? shown.tone : tone;
  const activeIndex = dragIndex ?? index;
  const valueText = shownEffort ? `${shownModel} ${shownEffort}` : shownModel;

  const pointerX = (event: ReactPointerEvent<HTMLDivElement>) =>
    event.clientX - (track.current?.getBoundingClientRect().left ?? 0);

  const moveTo = (next: number) => {
    const current = drag.current;
    if (!current || next === current.index) return;
    current.index = next;
    if (haptics) performHaptic("levelChange");
    setDragIndex(next);
  };

  const follow = (x: number) => {
    const current = drag.current;
    if (!current) return;
    const { index: next, center } = dragStepAt(x, current.index, count);
    moveTo(next);
    // Reduced motion skips the glide: the knob only jumps from step to step.
    const target =
      prefersReducedMotion() && current.index >= 0
        ? stepCenter(current.index, count)
        : center;
    animateTo(target, "follow");
  };

  const finish = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragIndex(null);
    if (commit && current.index >= 0 && current.index !== index) {
      onCommit(current.index);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || count === 0) return;
    event.preventDefault();
    setFocusRing(false);
    track.current?.focus({ preventScroll: true });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic or already-released pointer cannot be captured.
    }
    const x = pointerX(event);
    drag.current = { pointerId: event.pointerId, index };
    setDragIndex(index >= 0 ? index : null);
    // Grabbing the knob keeps its step; pressing anywhere else on the rail
    // jumps to the nearest dot.
    const onKnob =
      index >= 0 && Math.abs(x - stepCenter(index, count)) <= KNOB_HALF;
    if (!onKnob) moveTo(stepAt(x, count));
    follow(x);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    follow(pointerX(event));
  };

  const onPointerEnd = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    finish(commit);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    setFocusRing(true);
    if (event.key === "Enter") {
      event.preventDefault();
      onDone();
      return;
    }
    if (drag.current) return;
    const next = stepForKey(event.key, index, count);
    if (next == null) return;
    event.preventDefault();
    if (next !== index) onCommit(next);
  };

  return (
    <div
      data-model-slider
      data-model-family={shownFamily?.family}
      data-model-legacy={shownFamily?.legacy ? "" : undefined}
      data-effort-tone={shownTone}
      className="model-slider flex w-fit flex-col items-center gap-4 p-3 font-sans"
    >
      <button
        type="button"
        title="All models and settings"
        aria-label={`${valueText}. All models and settings`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpenModels}
        className="model-slider-label flex items-center gap-2 rounded-xl px-1 text-[22px] leading-[30px]"
      >
        <span className="grid size-6.5 shrink-0 place-items-center">
          <ModelFamilyIcon
            family={shownFamily?.family}
            size={26}
            className="model-slider-globe"
          />
        </span>
        <RollText
          text={shownModel}
          className="model-slider-model whitespace-nowrap font-medium text-content"
        />
        {shownEffort ? (
          <RollText
            text={shownEffort}
            className="model-slider-effort whitespace-nowrap italic text-content/70"
          />
        ) : null}
      </button>

      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Model preset"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, count - 1)}
        aria-valuenow={activeIndex >= 0 ? activeIndex : undefined}
        aria-valuetext={valueText}
        data-dragging={dragIndex != null ? "" : undefined}
        data-focus-ring={focusRing ? "" : undefined}
        data-empty={activeIndex < 0 ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerEnd(event, true)}
        onPointerCancel={(event) => onPointerEnd(event, false)}
        onLostPointerCapture={(event) => onPointerEnd(event, false)}
        onKeyDown={onKeyDown}
        className="model-slider-track relative h-6.5 w-[342px] shrink-0 touch-none rounded-[10px] outline-1 -outline-offset-2 outline-content/10"
      >
        <span ref={fill} aria-hidden="true" className="model-slider-fill" />
        {steps.map((step, stepIndex) => (
          <span
            key={step.preset.id}
            aria-hidden="true"
            data-active={stepIndex === activeIndex ? "" : undefined}
            className="model-slider-dot"
            style={{ left: stepCenter(stepIndex, count) - 3 }}
          />
        ))}
        {shownTone ? (
          <Fragment key={shownTone}>
            <span aria-hidden="true" className="model-slider-tiles-clip">
              <EffortTileShimmer className="model-slider-tiles" />
            </span>
            <span aria-hidden="true" className="model-slider-ripple" />
          </Fragment>
        ) : null}
        <span ref={knob} aria-hidden="true" className="model-slider-knob" />
      </div>
    </div>
  );
}
