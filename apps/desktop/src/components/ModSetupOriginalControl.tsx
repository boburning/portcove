import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { desktopApi } from "../api";
import { pickSourcePath } from "../file-picker";
import { useAppTranslation } from "../localization";
import type { ModSetupOriginalReview, ModSetupOriginalTarget, ModSetupView } from "../types";
import { errorText } from "../view-model";
import { ChoiceSelect } from "./ChoiceSelect";
import { Button } from "./ui/button";
import { ActionRow } from "./ui/patterns";

type Props = {
  target: ModSetupOriginalTarget;
  original: ModSetupView["originals"][number];
  disabled: boolean;
  perform: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
  setWorking: (working: boolean) => void;
  focusReturn: RefObject<HTMLHeadingElement | null>;
};

const focusableDisabledStyle =
  "aria-disabled:pointer-events-none aria-disabled:border-pc-border aria-disabled:bg-pc-surface-muted aria-disabled:text-pc-muted-foreground aria-disabled:opacity-70 aria-disabled:shadow-none";

export function ModSetupOriginalControl({
  target,
  original,
  disabled,
  perform,
  setWorking,
  focusReturn,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const [review, setReview] = useState<ModSetupOriginalReview>();
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const fallback = focusReturn.current;
    if (!section || !fallback) return;
    const { ownerDocument } = section;
    return () => {
      if (!section.contains(ownerDocument.activeElement)) return;
      // The revision or page may be gone. Wait for React to finish replacing it.
      queueMicrotask(() => {
        if (
          !section.isConnected &&
          fallback.isConnected &&
          ownerDocument.activeElement === ownerDocument.body
        ) {
          fallback.focus();
        }
      });
    };
  }, [focusReturn]);
  const availability = {
    changed: t("mods.original.status.changed"),
    missing: t("mods.original.status.missing"),
    verified: t("mods.original.status.verified"),
  }[original.availability];
  const options = useMemo(() => {
    if (!review) return [];
    const pathCounts = new Map<string, number>();
    if (review.current_path) pathCounts.set(review.current_path, 1);
    for (const { path } of review.instances) {
      pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
    }
    return [
      { value: "", label: t("mods.original.choose") },
      ...review.instances.map(({ instance_id, path }) => ({
        value: instance_id,
        label:
          (pathCounts.get(path) ?? 0) > 1
            ? t("mods.original.sameLocation", { path, identity: instance_id.slice(0, 12) })
            : path,
      })),
    ];
  }, [review, t]);

  async function read() {
    setReading(true);
    setWorking(true);
    setError(undefined);
    setReview(undefined);
    setChosen("");
    try {
      const next = await desktopApi.reviewModSetupOriginal(target);
      if (alive.current) setReview(next);
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      if (alive.current) setReading(false);
      setWorking(false);
    }
  }

  function finishReview() {
    if (!alive.current) return;
    const section = sectionRef.current;
    const active = section?.ownerDocument.activeElement;
    if (active && active !== reviewButton.current && section?.contains(active)) {
      focusReturn.current?.focus();
    }
    setReview(undefined);
    setChosen("");
  }

  async function relink(review: ModSetupOriginalReview) {
    setError(undefined);
    setWorking(true);
    try {
      const path = await pickSourcePath(review.source_profile, review.current_path ?? "", "game");
      if (path && alive.current) {
        const saved = await perform(
          () => desktopApi.relinkModSetupOriginal(target, path),
          t("mods.original.relinked"),
        );
        if (saved) finishReview();
      }
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      setWorking(false);
    }
  }

  async function select(instanceId: string) {
    const saved = await perform(
      () => desktopApi.selectModSetupOriginal(target, instanceId),
      t("mods.original.selected"),
    );
    if (saved) finishReview();
  }

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="grid gap-2">
      <h5 id={headingId} className="text-sm font-semibold">
        {t("mods.original.heading")}
      </h5>
      <p className="text-sm">{availability}</p>
      {error && <p role="alert">{error}</p>}
      {review && (
        <>
          {review.current_path && (
            <p className="text-sm break-all">
              <bdi>{review.current_path}</bdi>
            </p>
          )}
          <details className="text-sm">
            <summary>{t("mods.original.identity")}</summary>
            <code className="break-all" dir="ltr">
              {original.binding.sha256}
            </code>
          </details>
          {review.embedded ? (
            <p className="text-sm">{t("mods.original.embedded")}</p>
          ) : options.length > 1 ? (
            <div className="grid gap-2">
              <ChoiceSelect
                label={t("mods.original.registered")}
                value={chosen}
                disabled={disabled}
                onChange={setChosen}
                options={options}
              />
              <ActionRow>
                <Button
                  variant="outline"
                  className={focusableDisabledStyle}
                  disabled={disabled || !chosen}
                  focusableWhenDisabled={Boolean(chosen)}
                  onClick={() => chosen && void select(chosen)}
                >
                  {t("mods.original.use")}
                </Button>
              </ActionRow>
            </div>
          ) : (
            <p className="text-sm">{t("mods.original.noAlternatives")}</p>
          )}
        </>
      )}
      <ActionRow>
        {review && (
          <Button
            variant="outline"
            className={focusableDisabledStyle}
            disabled={disabled}
            focusableWhenDisabled
            onClick={() => void relink(review)}
          >
            {t("mods.original.relink")}
          </Button>
        )}
        <Button
          ref={reviewButton}
          variant={review ? "ghost" : "outline"}
          disabled={disabled}
          aria-busy={reading}
          focusableWhenDisabled={reading}
          onClick={() => void read()}
        >
          {t("mods.original.review")}
        </Button>
      </ActionRow>
    </section>
  );
}
