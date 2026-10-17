import {
  AlertSquare,
  BookOpen,
  Bug,
  CircleDot,
  Crown,
  SignalFull,
  SignalLow,
  SignalMedium,
  TaskDone,
  Trophy,
  type IconComponent,
} from "../../../shared/ui/icons";

type Glyph = { Icon: IconComponent; tone: string };

const DEFAULT_GLYPH: Glyph = { Icon: CircleDot, tone: "text-content/45" };

/** Icon and color for an Azure work item type. */
export function workItemTypeGlyph(type: string | undefined): Glyph {
  const name = type?.trim().toLowerCase() ?? "";
  if (name === "bug") return { Icon: Bug, tone: "text-rose-400" };
  if (
    name === "user story" ||
    name === "product backlog item" ||
    name === "requirement"
  ) {
    return { Icon: BookOpen, tone: "text-sky-400" };
  }
  if (name === "task") return { Icon: TaskDone, tone: "text-amber-400" };
  if (name === "feature") return { Icon: Trophy, tone: "text-violet-400" };
  if (name === "epic") return { Icon: Crown, tone: "text-orange-400" };
  return DEFAULT_GLYPH;
}

export function WorkItemTypeGlyph({
  type,
  className = "size-3.5",
}: {
  type: string | undefined;
  className?: string;
}) {
  const { Icon, tone } = workItemTypeGlyph(type);
  return (
    <Icon
      aria-hidden
      className={`shrink-0 ${tone} ${className}`}
      strokeWidth={1.75}
    />
  );
}

/**
 * Linear priority: 1 urgent, 2 high, 3 medium, 4 low. `null` for no
 * priority, so cards without one stay quiet.
 */
export function linearPriorityGlyph(value: number): Glyph | null {
  switch (value) {
    case 1:
      return { Icon: AlertSquare, tone: "text-orange-400" };
    case 2:
      return { Icon: SignalFull, tone: "text-content/60" };
    case 3:
      return { Icon: SignalMedium, tone: "text-content/60" };
    case 4:
      return { Icon: SignalLow, tone: "text-content/60" };
    default:
      return null;
  }
}

export function LinearPriorityGlyph({
  priority,
  className = "size-3.5",
}: {
  priority: { value: number; label: string };
  className?: string;
}) {
  const glyph = linearPriorityGlyph(priority.value);
  if (!glyph) return null;
  const { Icon, tone } = glyph;
  return (
    <span title={priority.label} className="inline-flex shrink-0">
      <Icon
        aria-hidden
        className={`shrink-0 ${tone} ${className}`}
        strokeWidth={1.75}
      />
    </span>
  );
}
