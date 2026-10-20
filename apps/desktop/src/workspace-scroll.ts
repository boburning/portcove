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

/** Keep a visible reading anchor when resizing transfers the scroll owner. */
export function useWorkspaceReflow(workspace: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    let owner = scrollOwner(element);
    let anchor: { element: HTMLElement; top: number } | undefined;
    let frame = 0;
    const remember = () => {
      // A CSS breakpoint may change the owner before the resize notification.
      // Do not replace the previous reading anchor with the new, unscrolled view.
      if (scrollOwner(element) !== owner) return;
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
        ? {
            element: reading,
            top: reading.getBoundingClientRect().top,
          }
        : undefined;
    };
    const resize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        owner = scrollOwner(element);
        // Overlay focus and scrolling belong to the overlay, never this view.
        if (anchor?.element.isConnected && !document.querySelector('[aria-modal="true"]')) {
          owner?.scrollTo({
            top: owner.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top,
          });
          const active = document.activeElement;
          if (active instanceof HTMLElement && active !== element && element.contains(active))
            active.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        remember();
      });
    };
    remember();
    document.addEventListener("scroll", remember, true);
    document.addEventListener("focusin", remember, true);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", remember, true);
      document.removeEventListener("focusin", remember, true);
      window.removeEventListener("resize", resize);
    };
  }, [workspace]);
}
