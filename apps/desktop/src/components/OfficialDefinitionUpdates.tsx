import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { errorText, isCancellation } from "../view-model";
import type { Perform } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import { OperationCancellation } from "./OperationCancellation";
import { Button } from "./ui/button";
import type { TFunction } from "i18next";
import { useAppTranslation } from "../localization";

type Props = {
  portId: string;
  portName: string;
  generation: number;
  busy: boolean;
  perform: Perform;
  onChanged: () => Promise<unknown>;
  openSettings: () => void;
};

const outcomes = { selected: true, ineligible: true, revoked: true } as const;
type Notice = keyof typeof outcomes | "cancelled";
/** App-owned failure with a stable code; its message serves diagnostics only. */
class UnsupportedSetupResult extends Error {}

function noticeCopy(t: TFunction<"catalogUpdates">, notice: Notice) {
  switch (notice) {
    case "selected":
      return t("definition.selected");
    case "ineligible":
      return t("definition.ineligible");
    case "revoked":
      return t("definition.revoked");
    case "cancelled":
      return t("definition.cancelled");
  }
}

export function OfficialDefinitionUpdates(props: Props) {
  return <DefinitionControls key={`${props.generation}:${props.portId}`} {...props} />;
}

function DefinitionControls({
  portId,
  portName,
  generation,
  busy,
  perform,
  onChanged,
  openSettings,
}: Props) {
  const { t } = useAppTranslation("catalogUpdates");
  const [submitting, setSubmitting] = useState(false);
  const [operationId, setOperationId] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  // `unsupported` is app-owned copy; other failures keep Core's diagnostic text.
  const [error, setError] = useState<{ kind: "unsupported" } | { kind: "text"; text: string }>();
  const owner = useRef({ active: true, pending: false });
  useLayoutEffect(() => {
    const current = { active: true, pending: false };
    owner.current = current;
    return () => {
      current.active = false;
    };
  }, []);

  const check = async () => {
    const current = owner.current;
    if (!current.active || current.pending || busy) return;
    current.pending = true;
    setSubmitting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await perform(
        t("definition.checkingFor", { name: portName }),
        async (reportEvent) => {
          const refreshed = await desktopApi.refreshOfficialDefinition(
            portId,
            generation,
            (event) => {
              reportEvent?.(event);
              if (current.active && event.type === "started" && event.parent_operation_id === null)
                setOperationId((previous) => previous ?? event.operation_id);
            },
          );
          if (
            refreshed.refresh_schema !== 1 ||
            refreshed.namespace !== "official" ||
            refreshed.stable_id !== portId ||
            !Object.hasOwn(outcomes, refreshed.disposition)
          )
            throw new UnsupportedSetupResult(
              "The setup check returned an unsupported result. Review current setup information.",
            );
          return refreshed;
        },
        {
          // The shared owner reloads even after a partial commit or lost response,
          // preserving the original Core failure and any independent readback failure.
          refresh: onChanged,
          propagateFailure: true,
          context: targetInvocationContext(
            "Check setup availability",
            { kind: "port", id: portId, label: portName },
            generation,
            "library",
          ),
        },
      );
      if (current.active && result) setNotice(result.disposition);
    } catch (value) {
      if (current.active) {
        if (isCancellation(value)) setNotice("cancelled");
        else
          setError(
            value instanceof UnsupportedSetupResult
              ? { kind: "unsupported" }
              : { kind: "text", text: errorText(value) },
          );
      }
    } finally {
      current.pending = false;
      if (current.active) {
        setSubmitting(false);
        setOperationId(undefined);
      }
    }
  };

  return (
    <section
      className="grid min-w-0 gap-2 border-t border-pc-border pt-4"
      aria-label={t("definition.section")}
    >
      <p className="text-sm text-pc-muted-foreground">{t("definition.description")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || submitting}
          onClick={() => void check()}
        >
          {t("definition.check")}
        </Button>
        <Button variant="ghost" size="sm" disabled={submitting} onClick={openSettings}>
          {t("definition.settings")}
        </Button>
      </div>
      {submitting && <p role="status">{t("definition.checking")}</p>}
      {operationId && (
        <OperationCancellation operationId={operationId} label={t("definition.cancel")} />
      )}
      {notice && <p role="status">{noticeCopy(t, notice)}</p>}
      {error && (
        <p role="alert">{error.kind === "text" ? error.text : t("definition.unsupported")}</p>
      )}
    </section>
  );
}
