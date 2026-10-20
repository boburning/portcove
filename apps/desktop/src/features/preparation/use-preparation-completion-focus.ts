import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
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
  const [context, setContext] = useState({ identity, epoch: 0 });
  if (context.identity !== identity) setContext({ identity, epoch: context.epoch + 1 });
  const epoch = context.epoch;
  const committedContext = useRef(context);
  useLayoutEffect(() => {
    committedContext.current = context;
  }, [context]);
  const [intent, setIntent] = useState<{
    identity: string;
    epoch: number;
    owner: HTMLElement;
    popup: Element | null;
  }>();
  useEffect(() => {
    if (intent?.identity !== identity || intent.epoch !== epoch) return;
    const element = owner.current;
    if (!element?.isConnected || element !== intent.owner || element.dataset.taskOwner !== identity)
      return;
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
      const scope = navigationScope();
      if (scope !== document) {
        if (scope === intent.popup) return;
        stop();
        setIntent(undefined);
        return;
      }
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
  }, [intent, identity, epoch, busy, owner, nextStep]);
  return () => {
    const element = owner.current;
    if (
      committedContext.current.epoch !== epoch ||
      committedContext.current.identity !== identity ||
      !element?.isConnected ||
      element.dataset.taskOwner !== identity
    )
      return;
    setIntent({
      identity,
      epoch,
      owner: element,
      popup: document.querySelector('[aria-labelledby="preparation-review-title"]'),
    });
  };
}
