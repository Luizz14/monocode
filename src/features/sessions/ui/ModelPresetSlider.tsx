import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  knobOffsetAt,
  SLIDER_KNOB_SIZE,
  stepAt,
  stepCenter,
  stepForKey,
  type EffortTone,
  type PresetStep,
} from "../model/modelPresetSteps";
import { performHaptic } from "../../../platform/tauri/haptics";
import { RollText } from "../../../shared/ui/RollText";
import { EffortTileShimmer } from "./EffortTileShimmer";
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

const KNOB_HALF = SLIDER_KNOB_SIZE / 2;

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
  tone,
  haptics,
  keyboard = false,
  onCommit,
  onOpenModels,
  onDone,
}: Props) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [focusRing, setFocusRing] = useState(keyboard);
  // React ids carry punctuation that `url(#…)` does not accept.
  const gradientId = `model-slider-rainbow-${useId().replace(/[^\w-]/g, "")}`;
  const count = steps.length;

  // The knob and fill read `--knob-x`. It is written here rather than through
  // React's style prop so a drag can move it on every pointer event without
  // a render.
  useLayoutEffect(() => {
    if (drag.current) return;
    const offset = index >= 0 ? stepCenter(index, count) - KNOB_HALF : 0;
    track.current?.style.setProperty("--knob-x", `${offset}px`);
  }, [index, count, dragIndex]);

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
  const shownTone = shown ? shown.tone : tone;
  const activeIndex = dragIndex ?? index;
  const valueText = shownEffort ? `${shownModel} ${shownEffort}` : shownModel;

  const pointerX = (event: ReactPointerEvent<HTMLDivElement>) =>
    event.clientX - (track.current?.getBoundingClientRect().left ?? 0);

  const follow = (x: number) => {
    const current = drag.current;
    if (!current) return;
    track.current?.style.setProperty("--knob-x", `${knobOffsetAt(x)}px`);
    const next = stepAt(x, count);
    if (next === current.index) return;
    current.index = next;
    if (haptics) performHaptic("levelChange");
    setDragIndex(next);
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
    drag.current = { pointerId: event.pointerId, index };
    setDragIndex(index >= 0 ? index : null);
    follow(pointerX(event));
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
      data-effort-tone={shownTone}
      className="model-slider flex w-fit flex-col items-center gap-4 rounded-3xl bg-background-base/80 p-3 font-sans shadow-[0_8px_32px_#1a1a1a14] outline-1 -outline-offset-2 outline-content/10 backdrop-blur-sm"
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
          <svg
            width="26"
            height="26"
            viewBox="-88 -88 424 424"
            aria-hidden="true"
            className="model-slider-globe"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#f87171" />
                <stop offset="30%" stopColor="#fbbf24" />
                <stop offset="55%" stopColor="#34d399" />
                <stop offset="80%" stopColor="#60a5fa" />
                <stop offset="100%" stopColor="#e879f9" />
              </linearGradient>
            </defs>
            <path
              d={GLOBE_PATH}
              fill={
                shownTone === "ultrathink"
                  ? `url(#${gradientId})`
                  : "currentColor"
              }
            />
          </svg>
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
        <span aria-hidden="true" className="model-slider-fill" />
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
        <span aria-hidden="true" className="model-slider-knob" />
      </div>
    </div>
  );
}

/** The globe from the design's model panel. */
const GLOBE_PATH =
  "M123.996-48.25A172.25 172.25 0 1 0 296.246 124 172.432 172.432 0 0 0 123.996-48.25Zm145.75 172.25a145.12 145.12 0 0 1-10.6 54.557l-74.034-45.53a26.367 26.367 0 0 0-10.335-3.693l-37.796-5.102a26.682 26.682 0 0 0-26.5 13.018h-14.443l-6.293-13.018a26.351 26.351 0 0 0-18.219-14.359l-13.25-2.866L71.228 84.25h27.676a26.6 26.6 0 0 0 12.803-3.313l20.289-11.195a27.527 27.527 0 0 0 4.969-3.545l44.57-40.313A26.384 26.384 0 0 0 186.935-6.678l-0.597-1.076A145.932 145.932 0 0 1 269.746 124ZM149.354-19.53L163.746 6.241 119.177 46.554 98.904 57.75H71.228a26.5 26.5 0 0 0-22.988 13.25l-14.459 25.225L16.97 51.44 35.088 8.594a145.534 145.534 0 0 1 114.282-28.157ZM-21.754 124a144.971 144.971 0 0 1 14.145-62.606l18.782 50.135a26.5 26.5 0 0 0 19.245 16.562l35.494 7.636L72.222 148.844a26.649 26.649 0 0 0 23.85 14.906h2.451l-11.974 26.881a26.5 26.5 0 0 0 4.737 28.769l0.231 0.232L123.996 253.089l-3.213 16.562A145.932 145.932 0 0 1-21.754 124Zm169.899 143.73l1.871-9.623a26.649 26.649 0 0 0-6.625-23.022 3.064 3.064 0 0 1-0.232-0.232L110.746 201.414 133.437 150.5l37.796 5.102 75.723 46.573A146.048 146.048 0 0 1 148.145 267.73Z";
