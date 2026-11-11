import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { OfficialCatalogReview, OperationEvent } from "../types";
import { errorText, isCancellation } from "../view-model";
import { useOperationState } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import { OperationCancellation } from "./OperationCancellation";
import { SettingsRow } from "./ui/patterns";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { useAppTranslation } from "../localization";

/** App-owned setup failures keep a stable code; messages serve diagnostics only. */
class CatalogSetupError extends Error {
  readonly code: "reviewAgain" | "setupIncomplete";
  constructor(code: "reviewAgain" | "setupIncomplete", message: string) {
    super(message);
    this.code = code;
  }
}
type CatalogError =
  | { kind: "text"; text: string }
  | { kind: "reviewAgain" }
  | { kind: "setupIncomplete" };
const catalogError = (value: unknown): CatalogError =>
  value instanceof CatalogSetupError
    ? { kind: value.code }
    : { kind: "text", text: errorText(value) };

const noChange = async () => {};

type OfficialCatalogUpdatesProps = {
  generation: number;
  disabled: boolean;
  onChanged?: (() => Promise<unknown>) | undefined;
};

export function OfficialCatalogUpdates(props: OfficialCatalogUpdatesProps) {
  // Retire the complete review/confirmation lifetime when the selected library changes.
  return <OfficialCatalogControls key={props.generation} {...props} />;
}

function OfficialCatalogControls({ generation, disabled, onChanged }: OfficialCatalogUpdatesProps) {
  const { t } = useAppTranslation("catalogUpdates");
  const [review, setReview] = useState<OfficialCatalogReview>();
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState<OfficialCatalogReview>();
  const [error, setError] = useState<CatalogError>();
  const [notice, setNotice] = useState<"refreshed" | "cancelled">();
  const [operationId, setOperationId] = useState<string>();
  const actionButton = useRef<HTMLButtonElement>(null);
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

  const load = async () => {
    const current = owner.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await desktopApi.officialCatalogReview(generation);
      if (current.active && owner.current === current) setReview(next);
    } catch (value) {
      if (current.active && owner.current === current) setError(catalogError(value));
    } finally {
      if (current.active && owner.current === current) setLoading(false);
    }
  };

  useEffect(() => {
    const current = owner.current;
    void desktopApi.officialCatalogReview(generation).then(
      (next) => {
        if (current.active && owner.current === current) {
          setReview(next);
          setLoading(false);
        }
      },
      (value: unknown) => {
        if (current.active && owner.current === current) {
          setError(catalogError(value));
          setLoading(false);
        }
      },
    );
  }, [generation]);

  const update = async (confirmed?: OfficialCatalogReview) => {
    const current = owner.current;
    if (current.pending || disabled || loading || busy) return;
    current.pending = true;
    const isCurrent = () => current.active && owner.current === current;
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await perform(
        confirmed ? t("catalog.enabling") : t("catalog.refreshing"),
        async (reportEvent) => {
          try {
            if (confirmed) {
              if (!confirmed.configured || !confirmed.expected_plan)
                throw new CatalogSetupError(
                  "reviewAgain",
                  "Review official catalog settings again before enabling updates.",
                );
              const enabled = await desktopApi.enableOfficialCatalog(
                confirmed.expected_plan,
                generation,
              );
              if (!isCurrent()) return;
              setReview(enabled.review);
              if (!enabled.review.enabled)
                throw new CatalogSetupError(
                  "setupIncomplete",
                  "Official catalog setup did not complete. Reload settings to review it.",
                );
            }
            if (!isCurrent()) return;
            return await desktopApi.refreshOfficialCatalog(generation, (event: OperationEvent) => {
              reportEvent?.(event);
              if (isCurrent() && event.type === "started") setOperationId(event.operation_id);
            });
          } catch (value) {
            // A lost response may have enabled the anchor. Read back instead of replaying setup.
            if (isCurrent()) {
              try {
                const next = await desktopApi.officialCatalogReview(generation);
                if (isCurrent()) setReview(next);
              } catch {
                if (isCurrent()) setReview(undefined);
              }
            }
            throw value;
          }
        },
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
      if (isCurrent() && result) setNotice("refreshed");
    } catch (value) {
      if (isCurrent()) {
        if (isCancellation(value)) setNotice("cancelled");
        else setError(catalogError(value));
      }
    } finally {
      current.pending = false;
      if (isCurrent()) {
        setOperationId(undefined);
        setConfirmation(undefined);
      }
    }
  };

  const blocked = disabled || Boolean(busy) || loading;
  const working = [...invocations.values()].some(
    (record) =>
      record.phase === "pending" &&
      record.context.libraryGeneration === generation &&
      record.context.target.id === "official-catalog",
  );
  return (
    <SettingsRow aria-label={t("catalog.title")}>
      <h2>{t("catalog.title")}</h2>
      <p>{t("catalog.description")}</p>
      {loading ? (
        <p role="status">{t("catalog.loading")}</p>
      ) : review?.configured ? (
        <Button
          ref={actionButton}
          data-focusable
          disabled={blocked || (!review.enabled && !review.expected_plan)}
          onClick={() => {
            if (review.enabled) void update();
            else setConfirmation(review);
          }}
        >
          {review.enabled ? t("catalog.refresh") : t("catalog.enable")}
        </Button>
      ) : review ? (
        <p>{t("catalog.unavailable")}</p>
      ) : null}
      {!confirmation && (
        <CatalogRefreshProgress busy={busy} working={working} operationId={operationId} />
      )}
      {notice && (
        <p role="status">
          {notice === "refreshed" ? t("catalog.refreshed") : t("catalog.cancelled")}
        </p>
      )}
      {error && (
        <>
          <p role="alert">
            {error.kind === "text"
              ? error.text
              : error.kind === "reviewAgain"
                ? t("catalog.reviewAgain")
                : t("catalog.setupIncomplete")}
          </p>
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
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(open, details) => {
          if (!open && owner.current.pending) details.cancel();
          else if (!open) setConfirmation(undefined);
        }}
      >
        <DialogContent showCloseButton={!working} finalFocus={actionButton}>
          <DialogTitle>{t("catalog.confirmTitle")}</DialogTitle>
          <DialogDescription>{t("catalog.confirmDescription")}</DialogDescription>
          <CatalogRefreshProgress busy={busy} working={working} operationId={operationId} />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={working}
              onClick={() => {
                if (!owner.current.pending) setConfirmation(undefined);
              }}
            >
              {t("catalog.confirmCancel")}
            </Button>
            <Button
              disabled={blocked}
              onClick={() => {
                if (confirmation) void update(confirmation);
              }}
            >
              {t("catalog.confirmEnable")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsRow>
  );
}

function CatalogRefreshProgress({
  busy,
  working,
  operationId,
}: {
  busy: ReturnType<typeof useOperationState>["busy"];
  working: boolean;
  operationId: string | undefined;
}) {
  const { t } = useAppTranslation("catalogUpdates");
  return (
    <>
      {working && busy && <p role="status">{busy}</p>}
      {operationId && (
        <OperationCancellation
          key={operationId}
          operationId={operationId}
          label={t("catalog.cancel")}
        />
      )}
    </>
  );
}
