import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
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
  setWorking: (working: boolean) => void;
  perform: (action: () => Promise<unknown>, success: string) => Promise<boolean>;
};

export function ModFilePreservationControl({
  portId,
  generation,
  live,
  disabled,
  setWorking,
  perform,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const [review, setReview] = useState<ModFilePreservationPlan>();
  const [preservedPath, setPreservedPath] = useState<string>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const pending = live.pending_preservation;
  const names = [...new Set([...live.unmanaged, ...live.changed_owned])];
  const plan =
    pending ??
    (review?.profile_id === live.profile_id && review?.revision === live.revision
      ? review
      : undefined);

  async function inspect(fileName: string) {
    setError(undefined);
    setReview(undefined);
    setWorking(true);
    try {
      const next = await desktopApi.inspectModFile(portId, fileName, generation);
      if (alive.current) setReview(next);
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      setWorking(false);
    }
  }

  async function preserve(plan: ModFilePreservationPlan) {
    setReview(undefined);
    setError(undefined);
    await perform(async () => {
      const result = await desktopApi.preserveModFile(
        portId,
        plan.file_name,
        plan.plan_sha256,
        generation,
      );
      if (alive.current) setPreservedPath(result.preserved_path);
    }, t("mods.filePreservation.outcome"));
  }

  if (!names.length && !pending && !preservedPath && !error) return null;
  return (
    <div className="grid gap-2">
      {(names.length > 0 || pending) && (
        <Notice intent="warning">
          <div data-slot="notice-body">
            <p>{pending ? t("mods.filePreservation.pending") : t("mods.blocked")}</p>
            {!pending && (
              <ul className="m-0 grid list-none gap-2 p-0">
                {names.map((fileName) => (
                  <li key={fileName}>
                    <ActionRow>
                      <bdi className="break-all">{fileName}</bdi>
                      <Button
                        variant="outline"
                        aria-label={t("mods.filePreservation.inspectName", { fileName })}
                        disabled={disabled}
                        onClick={() => void inspect(fileName)}
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
      {error && <p role="alert">{error}</p>}
      {plan && (
        <div className="grid gap-2">
          <p>
            <bdi className="font-medium">{plan.file_name}</bdi>
          </p>
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
              <Button variant="outline" disabled={disabled} onClick={() => setReview(undefined)}>
                {t("review.cancel")}
              </Button>
            )}
            <Button variant="outline" disabled={disabled} onClick={() => void preserve(plan)}>
              {pending ? t("mods.filePreservation.finish") : t("mods.filePreservation.preserve")}
            </Button>
          </ActionRow>
        </div>
      )}
      {preservedPath && (
        <div className="grid gap-1 text-sm">
          <p>{t("mods.filePreservation.adopt")}</p>
          <code className="break-all" dir="ltr">
            {preservedPath}
          </code>
        </div>
      )}
    </div>
  );
}
