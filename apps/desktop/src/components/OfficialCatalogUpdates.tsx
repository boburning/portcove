import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { OfficialCatalogReview, OperationEvent } from "../types";
import { errorText, isCancellation } from "../view-model";
import { useOperationState } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import {
  recordCatalogRefresh,
  requestAutomaticCatalogCheck,
  useLastAutomaticCatalogCheck,
  type AutomaticCatalogCheck,
} from "../features/catalog-updates/use-official-catalog-auto-refresh";
import { OperationCancellation } from "./OperationCancellation";
import { SettingsRow } from "./ui/patterns";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { useAppTranslation } from "../localization";

const mutedCopyClass = "m-0 text-xs leading-[var(--leading-relaxed)] text-pc-muted-foreground";

type CatalogError = { kind: "text"; text: string } | { kind: "choice" };

const noChange = async () => {};

/** The review is required; a failed choice read leaves Refresh available. */
async function readSettings(generation: number) {
  const [review, automatic] = await Promise.all([
    desktopApi.officialCatalogReview(generation),
    desktopApi.officialCatalogAutomaticUpdates().then(
      (value) => ({ ok: true as const, value }),
      (failure: unknown) => ({ ok: false as const, failure }),
    ),
  ]);
  return { review, automatic };
}

type OfficialCatalogUpdatesProps = {
  generation: number;
  disabled: boolean;
  onChanged?: (() => Promise<unknown>) | undefined;
};

export function OfficialCatalogUpdates(props: OfficialCatalogUpdatesProps) {
  // Retire the complete settings and refresh lifetime when the selected library changes.
  return <OfficialCatalogControls key={props.generation} {...props} />;
}

function OfficialCatalogControls({ generation, disabled, onChanged }: OfficialCatalogUpdatesProps) {
  const { t } = useAppTranslation("catalogUpdates");
  const [review, setReview] = useState<OfficialCatalogReview>();
  const [automatic, setAutomatic] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<CatalogError>();
  const [notice, setNotice] = useState<"refreshed" | "cancelled">();
  const [operationId, setOperationId] = useState<string>();
  const lastCheck = useLastAutomaticCatalogCheck();
  const owner = useRef({ generation, active: true, pending: false });
  useLayoutEffect(() => {
    const current = { generation, active: true, pending: false };
    owner.current = current;
    return () => {
      current.active = false;
    };
  }, [generation]);
  const { perform, busy, invocations } = useOperationState({
    refresh: onChanged ?? noChange,
    refreshActivities: noChange,
    libraryGeneration: generation,
  });

  const accept = ({ review, automatic }: Awaited<ReturnType<typeof readSettings>>) => {
    setReview(review);
    setAutomatic(automatic.ok ? automatic.value : undefined);
    if (!automatic.ok) setError({ kind: "text", text: errorText(automatic.failure) });
  };

  const load = async () => {
    const current = owner.current;
    const isCurrent = () => current.active && owner.current === current;
    setLoading(true);
    setError(undefined);
    try {
      const settings = await readSettings(generation);
      if (isCurrent()) accept(settings);
    } catch (value) {
      if (isCurrent()) setError({ kind: "text", text: errorText(value) });
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  useEffect(() => {
    const current = owner.current;
    const isCurrent = () => current.active && owner.current === current;
    void readSettings(generation).then(
      (settings) => {
        if (isCurrent()) {
          accept(settings);
          setLoading(false);
        }
      },
      (value: unknown) => {
        if (isCurrent()) {
          setError({ kind: "text", text: errorText(value) });
          setLoading(false);
        }
      },
    );
  }, [generation]);

  const choose = async (enabled: boolean) => {
    const current = owner.current;
    const isCurrent = () => current.active && owner.current === current;
    if (saving || loading) return;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await desktopApi.setOfficialCatalogAutomaticUpdates(enabled);
      if (!isCurrent()) return;
      setAutomatic(saved);
      // Turning updates on checks soon instead of waiting for the daily check.
      if (saved) requestAutomaticCatalogCheck();
    } catch {
      if (isCurrent()) setError({ kind: "choice" });
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  const refresh = async () => {
    const current = owner.current;
    if (current.pending || disabled || loading || busy) return;
    current.pending = true;
    const isCurrent = () => current.active && owner.current === current;
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await perform(
        // Activity records this name at start; operation names stay English until
        // the Activity surface resolves them at render (docs/LOCALIZATION.md).
        "Refreshing official catalog…",
        (reportEvent) =>
          desktopApi.refreshOfficialCatalog(generation, (event: OperationEvent) => {
            reportEvent?.(event);
            if (isCurrent() && event.type === "started") setOperationId(event.operation_id);
          }),
        {
          refresh: "workspace",
          propagateFailure: true,
          context: targetInvocationContext(
            "Refresh official catalog",
            { kind: "library", id: "official-catalog", label: "Official catalog" },
            generation,
            "library",
          ),
        },
      );
      if (isCurrent() && result) {
        recordCatalogRefresh(generation, result);
        setNotice("refreshed");
      }
    } catch (value) {
      if (isCurrent()) {
        if (isCancellation(value)) setNotice("cancelled");
        else setError({ kind: "text", text: errorText(value) });
      }
    } finally {
      current.pending = false;
      if (isCurrent()) setOperationId(undefined);
    }
  };

  const blocked = disabled || Boolean(busy) || loading;
  const working = [...invocations.values()].some(
    (record) =>
      record.phase === "pending" &&
      record.context.libraryGeneration === generation &&
      record.context.target.id === "official-catalog",
  );
  const checkboxId = `official-catalog-automatic-${generation}`;
  return (
    <SettingsRow aria-label={t("catalog.title")} aria-busy={saving || working}>
      <h2>{t("catalog.title")}</h2>
      <p>{t("catalog.description")}</p>
      {loading ? (
        <p role="status">{t("catalog.loading")}</p>
      ) : review?.configured ? (
        <>
          {automatic !== undefined && (
            <>
              <label
                htmlFor={checkboxId}
                className="flex min-h-10 cursor-pointer items-start gap-3 rounded-pc-md bg-[var(--color-bg-subtle)] p-3"
              >
                <Checkbox
                  data-focusable
                  className="mt-0.5"
                  id={checkboxId}
                  // Base UI's checkbox is not named by the wrapping label.
                  aria-labelledby={`${checkboxId}-label`}
                  aria-describedby={`${checkboxId}-description`}
                  checked={automatic}
                  disabled={saving}
                  onCheckedChange={(checked) => void choose(checked)}
                />
                <span className="grid gap-0.5">
                  <span id={`${checkboxId}-label`} className="font-bold text-pc-foreground">
                    {t("catalog.automatic.label")}
                  </span>
                  <small id={`${checkboxId}-description`} className={mutedCopyClass}>
                    {t("catalog.automatic.description")}
                  </small>
                </span>
              </label>
              <p className={mutedCopyClass} role="status">
                <CatalogCheckStatus
                  automatic={automatic}
                  check={lastCheck?.generation === generation ? lastCheck : undefined}
                />
              </p>
            </>
          )}
          <div>
            <Button
              data-focusable
              variant="outline"
              disabled={blocked}
              onClick={() => void refresh()}
            >
              {t("catalog.refresh")}
            </Button>
          </div>
        </>
      ) : review ? (
        <p>{t("catalog.unavailable")}</p>
      ) : null}
      {working && busy && <p role="status">{busy}</p>}
      {operationId && (
        <OperationCancellation
          key={operationId}
          operationId={operationId}
          label={t("catalog.cancel")}
        />
      )}
      {notice && (
        <p role="status">
          {notice === "refreshed" ? t("catalog.refreshed") : t("catalog.cancelled")}
        </p>
      )}
      {error && (
        <>
          <p role="alert">{error.kind === "text" ? error.text : t("catalog.choiceFailed")}</p>
          <Button
            variant="outline"
            disabled={blocked}
            onClick={() => {
              void load();
            }}
          >
            {t("catalog.reload")}
          </Button>
        </>
      )}
    </SettingsRow>
  );
}

/** What the latest scheduled check found. A failure here is never an alert. */
function CatalogCheckStatus({
  automatic,
  check,
}: {
  automatic: boolean;
  check: AutomaticCatalogCheck | undefined;
}) {
  const { t } = useAppTranslation("catalogUpdates");
  if (!automatic) return t("catalog.status.off");
  if (!check) return t("catalog.status.pending");
  // Times follow the system's regional format, separate from message language.
  const time = new Date(check.at).toLocaleString();
  if (check.kind === "result" && check.result.outcome === "refreshed")
    return t("catalog.status.current", { time });
  if (check.kind === "result" && check.result.serving === "not_served")
    return t("catalog.status.notPublished", { time });
  return t("catalog.status.unavailable", { time });
}
