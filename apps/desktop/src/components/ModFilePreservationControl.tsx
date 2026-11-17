import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { desktopApi } from "../api";
import { focusAndReveal } from "../focus";
import { useAppTranslation } from "../localization";
import type { LiveMods, ModFilePreservationPlan } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { ActionRow, Notice } from "./ui/patterns";

type Props = {
  portId: string;
  generation: number;
  live: LiveMods;
  disabled: boolean;
  setupHeading: RefObject<HTMLHeadingElement | null>;
  setWorking: (working: boolean) => void;
  perform: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
};

export function ModFilePreservationControl({
  portId,
  generation,
  live,
  disabled,
  setupHeading,
  setWorking,
  perform,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const [review, setReview] = useState<ModFilePreservationPlan>();
  const [preservedPath, setPreservedPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [inspecting, setInspecting] = useState<string>();
  const [preserving, setPreserving] = useState(false);
  const headingId = useId();
  const warning = useRef<HTMLParagraphElement>(null);
  const noticeBody = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewSection = useRef<HTMLElement>(null);
  const receipt = useRef<HTMLParagraphElement>(null);
  const finish = useRef<HTMLButtonElement>(null);
  const reviewButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusFrom = useRef<HTMLButtonElement>(undefined);
  const returnFocus = useRef<{ fileName: string; preserved: boolean }>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const pending = live.pending_preservation;
  const names = [...new Set([...live.unmanaged, ...live.changed_owned])];
  const currentReview =
    review?.profile_id === live.profile_id &&
    review.revision === live.revision &&
    names.includes(review.file_name)
      ? review
      : undefined;
  if (review && !currentReview) setReview(undefined);
  const plan = pending ?? currentReview;
  const focusWarning = useCallback(() => {
    if (!warning.current) {
      focusAndReveal(setupHeading.current);
      return;
    }
    warning.current.focus({ preventScroll: true });
    warning.current.scrollIntoView({ block: "center", inline: "nearest" });
  }, [setupHeading]);
  const bindNotice = useCallback(
    (body: HTMLDivElement | null) => {
      if (!body && noticeBody.current?.contains(document.activeElement)) {
        focusAndReveal(setupHeading.current);
      }
      noticeBody.current = body;
    },
    [setupHeading],
  );
  const bindReview = useCallback(
    (section: HTMLElement | null) => {
      if (
        !section &&
        !returnFocus.current &&
        reviewSection.current?.contains(document.activeElement)
      ) {
        focusWarning();
      }
      reviewSection.current = section;
    },
    [focusWarning],
  );

  useEffect(() => {
    const trigger = focusFrom.current;
    focusFrom.current = undefined;
    if (!plan || !trigger || trigger !== document.activeElement) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [plan]);

  useEffect(() => {
    const destination = returnFocus.current;
    if (!destination) return;
    const focused = document.activeElement;
    if (
      focused !== document.body &&
      focused !== warning.current &&
      !reviewSection.current?.contains(focused)
    ) {
      returnFocus.current = undefined;
      return;
    }
    if (!destination.preserved && disabled) {
      if (focused === document.body) focusWarning();
      return;
    }
    returnFocus.current = undefined;
    const target = destination.preserved
      ? receipt.current
      : pending?.file_name === destination.fileName
        ? finish.current
        : reviewButtons.current.get(destination.fileName);
    if (target) target.focus();
    else if (focused !== warning.current) focusWarning();
  }, [disabled, focusWarning, pending, plan, preservedPath]);

  async function inspect(fileName: string, trigger: HTMLButtonElement) {
    setInspecting(fileName);
    setError(undefined);
    setReview(undefined);
    setWorking(true);
    try {
      const next = await desktopApi.inspectModFile(portId, fileName, generation);
      if (alive.current) {
        focusFrom.current = trigger;
        setReview(next);
      }
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      if (alive.current) setInspecting(undefined);
      setWorking(false);
    }
  }

  function restoreAfterReview(fileName: string, preserved: boolean) {
    if (reviewSection.current?.contains(document.activeElement)) {
      returnFocus.current = { fileName, preserved };
    }
  }

  async function preserve(plan: ModFilePreservationPlan) {
    setPreserving(true);
    setError(undefined);
    const succeeded = await perform(async () => {
      const result = await desktopApi.preserveModFile(
        portId,
        plan.file_name,
        plan.plan_sha256,
        generation,
      );
      if (alive.current) {
        restoreAfterReview(plan.file_name, true);
        setPreservedPath(result.preserved_path);
      }
    }, t("mods.filePreservation.outcome"));
    if (!alive.current) return;
    // A refused finish can leave the same review on screen. Preserve focus on
    // a surviving control the player chose while the finish was pending.
    if (!succeeded && (!pending || document.activeElement === finish.current)) {
      restoreAfterReview(plan.file_name, false);
    }
    setReview(undefined);
    setPreserving(false);
  }

  if (!names.length && !pending && !preservedPath && !error) return null;
  return (
    <div className="grid min-w-0 gap-2 wrap-anywhere">
      {(names.length > 0 || pending) && (
        <Notice intent="warning">
          <div ref={bindNotice} data-slot="notice-body">
            <p ref={warning} tabIndex={-1}>
              {pending ? t("mods.filePreservation.pending") : t("mods.blocked")}
            </p>
            {!pending && (
              <ul className="m-0 grid list-none gap-2 p-0">
                {names.map((fileName) => (
                  <li key={fileName}>
                    <ActionRow>
                      <bdi className="min-w-0">{fileName}</bdi>
                      <Button
                        ref={(button) => {
                          if (button) reviewButtons.current.set(fileName, button);
                          else reviewButtons.current.delete(fileName);
                        }}
                        variant="outline"
                        aria-label={t("mods.filePreservation.inspectName", { fileName })}
                        disabled={disabled}
                        focusableWhenDisabled={inspecting === fileName}
                        aria-busy={inspecting === fileName}
                        onClick={(event) => void inspect(fileName, event.currentTarget)}
                      >
                        {t("mods.filePreservation.inspect")}
                      </Button>
                    </ActionRow>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Notice>
      )}
      {error && (
        <p role="alert" dir="auto">
          {error}
        </p>
      )}
      {plan && (
        <section ref={bindReview} aria-labelledby={headingId} className="grid min-w-0 gap-2">
          <h4 ref={heading} id={headingId} tabIndex={-1} className="scroll-mt-3 font-medium">
            <bdi>{plan.file_name}</bdi>
          </h4>
          <p>
            {plan.restore ? t("mods.filePreservation.restore") : t("mods.filePreservation.move")}
          </p>
          <details className="text-sm">
            <summary>{t("mods.filePreservation.details")}</summary>
            <code className="break-all" dir="ltr">
              {plan.observed.sha256}
            </code>
          </details>
          <ActionRow>
            {!pending && (
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  restoreAfterReview(plan.file_name, false);
                  setReview(undefined);
                }}
              >
                {t("review.cancel")}
              </Button>
            )}
            <Button
              ref={finish}
              variant="outline"
              disabled={disabled}
              focusableWhenDisabled={preserving}
              aria-busy={preserving}
              onClick={() => void preserve(plan)}
            >
              {pending ? t("mods.filePreservation.finish") : t("mods.filePreservation.preserve")}
            </Button>
          </ActionRow>
        </section>
      )}
      {preservedPath && (
        <div className="grid gap-1 text-sm">
          <p ref={receipt} tabIndex={-1}>
            {t("mods.filePreservation.adopt")}
          </p>
          <code className="break-all" dir="ltr">
            {preservedPath}
          </code>
        </div>
      )}
    </div>
  );
}
