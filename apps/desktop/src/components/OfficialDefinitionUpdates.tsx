import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { errorText, isCancellation } from "../view-model";
import type { Perform } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import { OperationCancellation } from "./OperationCancellation";
import { Button } from "./ui/button";

type Props = {
  portId: string;
  portName: string;
  generation: number;
  busy: boolean;
  perform: Perform;
  onChanged: () => Promise<unknown>;
  openSettings: () => void;
};

const outcomes = {
  selected: "Setup information checked. Review the current setup options before continuing.",
  ineligible:
    "The offered setup could not be selected. Review the current setup options and requirements.",
  revoked: "The publisher withdrew this setup. Review the current options before continuing.",
};

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
  const [submitting, setSubmitting] = useState(false);
  const [operationId, setOperationId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
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
        `Checking setup availability for ${portName}…`,
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
            throw new Error(
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
      if (current.active && result) setNotice(outcomes[result.disposition]);
    } catch (value) {
      if (current.active) {
        if (isCancellation(value))
          setNotice("Setup check cancelled. Review current setup information before continuing.");
        else setError(errorText(value));
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
    <section className="grid min-w-0 gap-2" aria-label="Official setup information">
      <p>
        Check the official catalog for setup options. Checking does not install or replace game
        files.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || submitting} onClick={() => void check()}>
          Check setup availability
        </Button>
        <Button variant="ghost" disabled={submitting} onClick={openSettings}>
          Catalog update settings
        </Button>
      </div>
      {submitting && <p role="status">Checking setup availability…</p>}
      {operationId && (
        <OperationCancellation operationId={operationId} label="Cancel setup check" />
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
