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
    let focusedCard: HTMLElement | null = null;
    let cardHeight: number | undefined;
    const cardObserver = new ResizeObserver(() => {
      const height = focusedCard?.getBoundingClientRect().height;
      if (height === cardHeight) return;
      cardHeight = height;
      // Only a still-visible focus anchor may follow changing Library content.
      // An overlay or the player's scroll choice must not pull the page back.
      if (anchor?.element === document.activeElement) reconcile(true);
    });
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
      const workspaceBounds = element.getBoundingClientRect();
      const visible = (item: HTMLElement) => {
        const rect = item.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.bottom > Math.max(0, workspaceBounds.top) &&
          rect.top < Math.min(innerHeight, workspaceBounds.bottom)
        );
      };
      const active = document.activeElement;
      const libraryCard =
        active instanceof HTMLElement && element.contains(active)
          ? active.closest<HTMLElement>(".collection-entry")
          : null;
      if (libraryCard !== focusedCard) {
        cardObserver.disconnect();
        focusedCard = libraryCard;
        cardHeight = focusedCard?.getBoundingClientRect().height;
        if (focusedCard) cardObserver.observe(focusedCard);
      }
      const focused =
        active instanceof HTMLElement &&
        element.contains(active) &&
        (visible(active) || (event?.type === "focusin" && libraryCard))
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
      // Menu return can restore focus after artwork feedback already changed
      // the card. Reveal that explicit return, without moving focus itself.
      if (event?.type === "focusin" && libraryCard) reconcile(true);
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
            // Window resize and focused-card feedback reveal the current
            // control. Leading-workspace feedback only preserves the anchor.
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
      cardObserver.disconnect();
      document.removeEventListener("scroll", remember, true);
      document.removeEventListener("focusin", remember, true);
      window.removeEventListener("resize", resize);
      for (const name of ["wheel", "touchstart", "touchmove", "pointerdown"])
        document.removeEventListener(name, userInput, true);
      document.removeEventListener("keydown", scrollKey, true);
    };
  }, [workspace]);
}
