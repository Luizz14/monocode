import { useEffect, type ReactNode, type RefObject } from "react";

/** The list under `target` that can still scroll vertically by `deltaY`. */
function scrollableList(target: EventTarget | null, deltaY: number): boolean {
  if (!(target instanceof Element)) return false;
  const list = target.closest<HTMLElement>("[data-board-list]");
  if (!list || list.scrollHeight <= list.clientHeight) return false;
  return deltaY < 0
    ? list.scrollTop > 0
    : list.scrollTop + list.clientHeight < list.scrollHeight;
}

/**
 * Horizontal scroller holding the columns. A vertical wheel outside a card
 * list that can scroll turns into horizontal scrolling.
 */
export function BoardColumns({
  scrollerRef,
  label,
  children,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  label: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (scrollableList(event.target, event.deltaY)) return;
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaY;
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [scrollerRef]);

  return (
    <div
      ref={scrollerRef}
      role="group"
      aria-label={label}
      className="flex min-h-0 flex-1 items-start gap-2.5 overflow-x-auto overflow-y-hidden overscroll-x-contain p-3"
    >
      {children}
    </div>
  );
}
