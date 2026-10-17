import { useLayoutEffect, useRef, useState } from "react";
import {
  graphemes,
  RESIZE_EASING,
  RESIZE_MS,
  ROLL_EASING,
  ROLL_IN,
  ROLL_MS,
  ROLL_OUT,
  ROLL_TOTAL_MS,
  sharedEnds,
  staggerDelays,
} from "../lib/rollText";
import { useAnimateNumbers } from "../../features/settings/model/displayPrefs";

interface Roll {
  from: string;
  to: string;
  id: number;
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A label that rolls when its text changes (see `rollText.ts`). At rest it is
 * the ordinary truncating span, so layout, ellipsis and hit-testing are
 * unchanged whenever nothing is moving; the per-glyph markup only exists for
 * the ~0.7s a roll takes. The first render never rolls; `still` swaps the
 * text in place, settling any roll in flight.
 */
export function RollText({
  text,
  className = "",
  still = false,
}: {
  text: string;
  className?: string;
  still?: boolean;
}) {
  const [shown, setShown] = useState(text);
  const [roll, setRoll] = useState<Roll | null>(null);
  if (shown !== text) {
    setShown(text);
    // A change mid-roll restarts from the label it was heading to.
    setRoll(
      still || reducedMotion()
        ? null
        : { from: shown, to: text, id: (roll?.id ?? 0) + 1 },
    );
  } else if (still && roll) {
    setRoll(null);
  }

  const sizer = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const box = sizer.current;
    if (!roll || !box) return;
    const fromLine = box.querySelector<HTMLElement>("[data-side='from']");
    const toLine = box.querySelector<HTMLElement>("[data-side='to']");
    if (!fromLine || !toLine) return;
    const animations: Animation[] = [];

    animations.push(
      box.animate(
        [
          { width: `${fromLine.offsetWidth}px` },
          { width: `${toLine.offsetWidth}px` },
        ],
        { duration: RESIZE_MS, easing: RESIZE_EASING },
      ),
    );
    // The trailing run slides from its old x to its new one with the width.
    const fromTail = fromLine.querySelector<HTMLElement>("[data-tail]");
    const toTail = toLine.querySelector<HTMLElement>("[data-tail]");
    if (fromTail && toTail && fromTail.offsetLeft !== toTail.offsetLeft) {
      const dx = fromTail.offsetLeft - toTail.offsetLeft;
      animations.push(
        toTail.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: "none" }],
          { duration: RESIZE_MS, easing: RESIZE_EASING },
        ),
      );
    }
    const rollGlyphs = (line: HTMLElement, keyframes: Keyframe[]) => {
      const glyphs = Array.from(
        line.querySelectorAll<HTMLElement>("[data-glyph]"),
      );
      const delays = staggerDelays(glyphs.map((glyph) => glyph.offsetLeft));
      glyphs.forEach((glyph, i) => {
        animations.push(
          glyph.animate(keyframes, {
            duration: ROLL_MS,
            delay: delays[i],
            easing: ROLL_EASING,
            fill: "both",
          }),
        );
      });
    };
    rollGlyphs(fromLine, ROLL_OUT);
    rollGlyphs(toLine, ROLL_IN);

    const settle = window.setTimeout(() => setRoll(null), ROLL_TOTAL_MS);
    return () => {
      window.clearTimeout(settle);
      for (const animation of animations) {
        // Browsers mark the canceled `finished` as handled; happy-dom doesn't.
        animation.finished?.catch(() => {});
        animation.cancel();
      }
    };
  }, [roll]);

  if (!roll) {
    return <span className={`roll-text ${className}`}>{text}</span>;
  }

  const from = graphemes(roll.from);
  const to = graphemes(roll.to);
  const [prefix, suffix] = sharedEnds(from, to);
  // Both lines keep the shared runs in place so positions line up; only the
  // new line paints them. Glyphs paint from `data-text` (see index.css) so
  // the element's text content, and any copy of it, is the new label alone.
  const line = (chars: string[], side: "from" | "to") => (
    <span className="roll-text-line" data-side={side}>
      <span
        className={`roll-text-run ${side === "from" ? "invisible" : ""}`}
        data-text={chars.slice(0, prefix).join("")}
      />
      {chars.slice(prefix, chars.length - suffix).map((char, i) => (
        <span
          key={i}
          className="roll-text-run roll-text-glyph"
          data-text={char}
          data-glyph
        />
      ))}
      <span
        className={`roll-text-run ${side === "from" ? "invisible" : ""}`}
        data-text={chars.slice(chars.length - suffix).join("")}
        data-tail
      />
    </span>
  );

  return (
    <span className={`roll-text ${className}`} data-rolling>
      <span key={roll.id} ref={sizer} className="roll-text-sizer" aria-hidden>
        {line(from, "from")}
        {line(to, "to")}
      </span>
      <span className="sr-only">{roll.to}</span>
    </span>
  );
}

/**
 * RollText for counters, meters and timers, which change often enough that
 * the user can keep them still (Settings > Appearance > Motion).
 */
export function RollNumber({
  text,
  className,
}: {
  text: string | number;
  className?: string;
}) {
  const animate = useAnimateNumbers();
  return (
    <RollText text={String(text)} className={className} still={!animate} />
  );
}
