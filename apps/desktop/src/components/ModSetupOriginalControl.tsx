import { useEffect, useId, useMemo, useRef, useState } from "react";
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
};

export function ModSetupOriginalControl({
  target,
  original,
  disabled,
  perform,
  setWorking,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const [review, setReview] = useState<ModSetupOriginalReview>();
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string>();
  const headingId = useId();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
      setWorking(false);
    }
  }

  async function relink(review: ModSetupOriginalReview) {
    setError(undefined);
    setWorking(true);
    try {
      const path = await pickSourcePath(review.source_profile, review.current_path ?? "", "game");
      if (path && alive.current) {
        await perform(
          () => desktopApi.relinkModSetupOriginal(target, path),
          t("mods.original.relinked"),
        );
        if (alive.current) setReview(undefined);
      }
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      setWorking(false);
    }
  }

  async function select(instanceId: string) {
    await perform(
      () => desktopApi.selectModSetupOriginal(target, instanceId),
      t("mods.original.selected"),
    );
    if (alive.current) {
      setReview(undefined);
      setChosen("");
    }
  }

  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h5 id={headingId} className="text-sm font-semibold">
        {t("mods.original.heading")}
      </h5>
      <p className="text-sm">{availability}</p>
      {error && <p role="alert">{error}</p>}
      {review ? (
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
                  disabled={disabled || !chosen}
                  onClick={() => chosen && void select(chosen)}
                >
                  {t("mods.original.use")}
                </Button>
              </ActionRow>
            </div>
          ) : (
            <p className="text-sm">{t("mods.original.noAlternatives")}</p>
          )}
          <ActionRow>
            <Button variant="outline" disabled={disabled} onClick={() => void relink(review)}>
              {t("mods.original.relink")}
            </Button>
          </ActionRow>
        </>
      ) : (
        <ActionRow>
          <Button variant="outline" disabled={disabled} onClick={() => void read()}>
            {t("mods.original.review")}
          </Button>
        </ActionRow>
      )}
    </section>
  );
}
