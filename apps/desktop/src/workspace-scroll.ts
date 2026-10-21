/** The narrow shell reads in document flow; wide workspaces scroll independently. */
function scrollOwner(workspace: HTMLElement | null | undefined) {
  if (!workspace) return undefined;
  const document = workspace.ownerDocument;
  return document.defaultView?.getComputedStyle(workspace).overflowY === "visible"
    ? (document.scrollingElement ?? document.documentElement)
    : workspace;
}

export function workspaceScrollTop(workspace: HTMLElement | null | undefined) {
  return scrollOwner(workspace)?.scrollTop ?? 0;
}

export function scrollWorkspaceTo(workspace: HTMLElement | null | undefined, top: number) {
  scrollOwner(workspace)?.scrollTo({ top });
}
import { useEffect, type RefObject } from "react";
import { fieldOwnsArrows, navigationScope } from "./focus";

/** Preserve visible reading position for window reflow and leading feedback. */
export function useWorkspaceReflow(workspace: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const feedback = element.querySelector<HTMLElement>("[data-workspace-feedback]");
    const scope = () => element.getAttribute("data-workspace-continuity-scope");
    let owner = scrollOwner(element);
    let anchor: { element: HTMLElement; top: number; scope: string | null } | undefined;
    let frame = 0;
    let revealRequested = false;
    let feedbackHeight = feedback?.getBoundingClientRect().height;
    let feedbackChangePending = false;
    const overlayOpen = () => navigationScope() !== document;
    const remember = (event?: Event) => {
      // The resize route owns scroll-owner transfer, not a content observer.
      if (scrollOwner(element) !== owner) return;
      // A content shrink can clamp scroll before ResizeObserver runs. That is
      // not a new reading choice; retain the anchor until this reflow settles.
      if (
        event?.type === "scroll" &&
        feedback &&
        (feedbackChangePending || feedback.getBoundingClientRect().height !== feedbackHeight)
      )
        return;
      if (overlayOpen()) {
        anchor = undefined;
        return;
      }
      const visible = (item: HTMLElement) => {
        const rect = item.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.bottom > Math.max(0, element.getBoundingClientRect().top) &&
          rect.top < innerHeight
        );
      };
      const active = document.activeElement;
      const focused =
        active instanceof HTMLElement && element.contains(active) && visible(active)
          ? active
          : undefined;
      const reading =
        focused ??
        [...element.querySelectorAll<HTMLElement>("[data-detail-origin], h1, h2, h3")].find(
          visible,
        );
      anchor = reading
        ? { element: reading, top: reading.getBoundingClientRect().top, scope: scope() }
        : undefined;
    };
    const reconcile = (reveal: boolean) => {
      revealRequested ||= reveal;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const revealFocus = revealRequested;
        revealRequested = false;
        const nextOwner = scrollOwner(element);
        try {
          if (!revealFocus && nextOwner !== owner) return;
          owner = nextOwner;
          if (
            anchor?.element.isConnected &&
            element.contains(anchor.element) &&
            anchor.scope === scope() &&
            !overlayOpen()
          ) {
            const delta = anchor.element.getBoundingClientRect().top - anchor.top;
            // Browser anchoring already accounted for any compensated movement.
            // Correct only remaining displacement; never restore a launch baseline.
            if (owner && Math.abs(delta) > 0.5) owner.scrollTo({ top: owner.scrollTop + delta });
            // Preserve the original window-resize reveal behavior. Feedback
            // changes never focus or scrollIntoView the current control.
            if (revealFocus) {
              const active = document.activeElement;
              if (active instanceof HTMLElement && active !== element && element.contains(active))
                active.scrollIntoView({ block: "nearest", inline: "nearest" });
            }
          }
        } finally {
          feedbackChangePending = false;
          remember();
        }
      });
    };
    const resize = () => reconcile(true);
    const observer = feedback
      ? new ResizeObserver(() => {
          const height = feedback.getBoundingClientRect().height;
          if (height === feedbackHeight) return;
          feedbackHeight = height;
          feedbackChangePending = true;
          reconcile(false);
        })
      : undefined;
    // New input outranks the retained geometry, even during a pending frame.
    // Invalidation never scrolls or focuses; subsequent observation records the
    // player's new position rather than restoring a pre-input baseline.
    const userInput = (event?: Event) => {
      anchor = undefined;
      // Clicking an already focused control has no new focusin event. Retain
      // its current baseline only while geometry is stable. Scroll gestures
      // stay invalidated until their new position is observed.
      const control =
        event?.type === "pointerdown" && event.target instanceof Element
          ? event.target.closest("button, a[href], input, select, textarea, [tabindex]")
          : null;
      if (
        control === document.activeElement &&
        !feedbackChangePending &&
        (!feedback || feedback.getBoundingClientRect().height === feedbackHeight)
      )
        remember();
    };
    const scrollKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.isComposing || fieldOwnsArrows(target)) return;
      if (
        event.key === " " &&
        target?.closest(
          "button, summary, [role=button], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=tab], [role=option]",
        )
      )
        return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        userInput();
    };
    remember();
    if (feedback) observer?.observe(feedback);
    document.addEventListener("scroll", remember, true);
    document.addEventListener("focusin", remember, true);
    window.addEventListener("resize", resize);
    for (const name of ["wheel", "touchstart", "touchmove", "pointerdown"])
      document.addEventListener(name, userInput, { capture: true, passive: true });
    document.addEventListener("keydown", scrollKey, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("scroll", remember, true);
      document.removeEventListener("focusin", remember, true);
      window.removeEventListener("resize", resize);
      for (const name of ["wheel", "touchstart", "touchmove", "pointerdown"])
        document.removeEventListener(name, userInput, true);
      document.removeEventListener("keydown", scrollKey, true);
    };
  }, [workspace]);
}
