import { useEffect, useState, type RefObject } from "react";
import { focusAndReveal, navigationScope } from "../../focus";

/** Retain completion intent across status publication and popup teardown. */
export function usePreparationCompletionFocus({
  owner,
  nextStep,
  identity,
  busy,
}: {
  owner: RefObject<HTMLElement | null>;
  nextStep: RefObject<HTMLElement | null>;
  identity: string;
  busy: boolean;
}) {
  const [intent, setIntent] = useState<string>();
  useEffect(() => {
    if (intent !== identity) return;
    const element = owner.current;
    if (!element?.isConnected || element.dataset.taskOwner !== identity) return;
    let frame = 0;
    let settled = false;
    const stop = () => {
      settled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("focusin", schedule);
    };
    const attempt = () => {
      frame = 0;
      if (settled) return;
      if (!element.isConnected || element.dataset.taskOwner !== identity) return stop();
      // The popup owns focus until it finishes restoration. Its DOM removal or
      // focus event schedules another observation, without a fixed timer.
      if (navigationScope() !== document) return;
      const active = document.activeElement;
      const launch = element.querySelector<HTMLElement>("[data-launch-action]");
      if (
        active !== document.body &&
        active !== nextStep.current &&
        active !== launch &&
        !(
          active instanceof Element &&
          element.contains(active) &&
          active.closest(".preparation-control")
        )
      ) {
        stop();
        setIntent(undefined);
        return;
      }
      if (busy) return;
      const target =
        element.querySelector<HTMLElement>("[data-launch-action]:not(:disabled)") ??
        nextStep.current;
      stop();
      setIntent(undefined);
      focusAndReveal(target);
    };
    function schedule() {
      if (!settled && !frame) frame = requestAnimationFrame(attempt);
    }
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "data-closed", "aria-modal"],
    });
    document.addEventListener("focusin", schedule);
    schedule();
    return stop;
  }, [intent, identity, busy, owner, nextStep]);
  return () => setIntent(identity);
}
