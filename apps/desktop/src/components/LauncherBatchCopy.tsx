import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { FolderInput } from "lucide-react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import type { AdoptionBatchItem, AdoptionBatchPreview, AdoptionBatchResult } from "../types";

export type LauncherBatchSelection = { item: AdoptionBatchItem; label: string };

/** Core refuses larger batches; the list keeps selections within it. */
export const LAUNCHER_BATCH_LIMIT = 32;

function outcomeLabel(
  t: TFunction<"launcherImport">,
  outcome: AdoptionBatchResult["items"][number]["outcome"],
): string {
  switch (outcome) {
    case "copied":
      return t("batch.outcome.copied");
    case "changed":
      return t("batch.outcome.changed");
    case "failed":
      return t("batch.outcome.failed");
  }
}

/**
 * Reviews the selected launcher apps as one batch and copies them after one native
 * confirmation. Core re-reviews each app just before copying it.
 */
export function LauncherBatchCopy({
  selection,
  disabled,
  reviewBatch,
  copyBatch,
  copied,
  gameName = (portId) => portId,
}: {
  selection: readonly LauncherBatchSelection[];
  disabled: boolean;
  reviewBatch: (items: AdoptionBatchItem[]) => Promise<AdoptionBatchPreview | undefined>;
  copyBatch: (
    items: AdoptionBatchItem[],
    batchSha256: string,
  ) => Promise<AdoptionBatchResult | null | undefined>;
  /** Called after a copy ran, so copied apps are not offered again. */
  copied: () => void;
  gameName?: (portId: string) => string;
}) {
  const { t } = useAppTranslation("launcherImport");
  const [preview, setPreview] = useState<AdoptionBatchPreview>();
  const [result, setResult] = useState<{
    value: AdoptionBatchResult;
    labels: ReadonlyMap<string, string>;
  }>();
  const [phase, setPhase] = useState<"idle" | "reviewing" | "copying">("idle");
  const resultRef = useRef<HTMLParagraphElement>(null);
  // A review belongs to exactly the selection it was made for.
  const key = selection.map(({ item }) => `${item.source}\n${item.port_id}`).join("\n--\n");
  const [reviewedKey, setReviewedKey] = useState<string>();
  const current = preview && reviewedKey === key ? preview : undefined;
  const label = (source: string) =>
    selection.find(({ item }) => item.source === source)?.label ?? source;
  const items = selection.map(({ item }) => item);
  const busy = disabled || phase !== "idle";
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);
  return (
    <section aria-label={t("batch.label")} className="mt-3">
      <p className="text-[var(--color-text-secondary)]">
        {t("batch.selected", { count: selection.length })}
      </p>
      <Button
        data-focusable
        type="button"
        variant="outline"
        disabled={busy || selection.length < 2}
        onClick={() => {
          setPhase("reviewing");
          setResult(undefined);
          void reviewBatch(items)
            .then((reviewed) => {
              setPreview(reviewed);
              setReviewedKey(reviewed ? key : undefined);
            })
            .finally(() => setPhase("idle"));
        }}
      >
        <Icon glyph={FolderInput} />
        {phase === "reviewing" ? t("batch.reviewing") : t("batch.review")}
      </Button>
      {current && (
        <div
          className="mt-3 rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-3 [overflow-wrap:anywhere]"
          aria-label={t("batch.planLabel")}
          role="group"
        >
          <p>
            <Trans
              t={t}
              i18nKey="batch.planSummary"
              values={{
                apps: t("batch.apps", { count: current.items.length }),
                files: t("batch.files", { count: current.total_files }),
                size: formatBytes(current.total_bytes),
              }}
              components={{ strong: <strong /> }}
            />
          </p>
          <ul className="ps-5">
            {current.items.map((item) => (
              <li key={item.source}>
                <bdi>{label(item.source)}</bdi> → <bdi>{gameName(item.selected_port_id ?? "")}</bdi>
                {item.destination?.active_install && (
                  <>
                    <br />
                    <small>
                      <Trans
                        t={t}
                        i18nKey="batch.becomesActive"
                        components={{
                          version: <bdi>{item.destination.active_install.version}</bdi>,
                        }}
                      />
                    </small>
                  </>
                )}
                {(item.destination?.imported_user_data_paths.length ?? 0) > 0 && (
                  <>
                    <br />
                    <small>{t("batch.savedFilesCopied")}</small>
                  </>
                )}
                {item.copy_plan.skipped_entries.length > 0 && (
                  <>
                    <br />
                    <small className="text-[var(--color-warning-text)]">
                      {t("batch.unsupported", { count: item.copy_plan.skipped_entries.length })}
                    </small>
                  </>
                )}
              </li>
            ))}
          </ul>
          {current.items_replacing_saved_files > 0 && (
            <p role="note" className="text-[var(--color-warning-text)]">
              {t("batch.replacesSavedFiles", { count: current.items_replacing_saved_files })}
            </p>
          )}
          <p className="text-[var(--color-text-secondary)]">{t("batch.recheckNote")}</p>
          <Button
            data-focusable
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => {
              const labels = new Map(selection.map(({ item, label }) => [item.source, label]));
              setPhase("copying");
              void copyBatch(items, current.batch_sha256)
                .then((value) => {
                  if (value) {
                    setResult({ value, labels });
                    setPreview(undefined);
                    copied();
                  }
                })
                .finally(() => setPhase("idle"));
            }}
          >
            <Icon glyph={FolderInput} />
            {phase === "copying" ? t("batch.copying") : t("batch.continue")}
          </Button>
        </div>
      )}
      <div aria-live="polite">
        {result && (
          <div className="mt-3" role="group" aria-label={t("batch.resultLabel")}>
            <p
              ref={resultRef}
              tabIndex={-1}
              className="rounded-sm focus:outline-2 focus:outline-offset-2 focus:outline-pc-ring"
            >
              {t("batch.resultSummary", {
                count: result.value.items.filter((item) => item.outcome === "copied").length,
                total: result.value.items.length,
              })}
            </p>
            <ul className="ps-5">
              {result.value.items.map((item) => (
                <li key={item.source}>
                  <Trans
                    t={t}
                    i18nKey="batch.resultItem"
                    values={{ outcome: outcomeLabel(t, item.outcome) }}
                    components={{
                      name: <bdi>{result.labels.get(item.source) ?? item.source}</bdi>,
                    }}
                  />
                  {item.message && (
                    <>
                      <br />
                      <small className="text-[var(--color-text-secondary)]">{item.message}</small>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
