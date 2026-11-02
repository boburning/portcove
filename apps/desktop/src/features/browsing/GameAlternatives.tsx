import { useLayoutEffect, useRef } from "react";
import { Button } from "../../components/ui/button";
import { gameProjectLabel } from "../../port-identity";
import { platformLabel } from "../../view-model";
import type { PortStatus } from "../../types";
import type { Organization } from "../organization/OrganizationControls";
import type { CatalogEntry } from "./catalog-entry";
import { ImplementationChoice, ownsChoiceFocus } from "./ImplementationChoice";
import { originalGame } from "./original-game";

export function ImplementationFacts({
  port,
  status,
}: {
  port: CatalogEntry;
  status?: PortStatus | undefined;
}) {
  const editions = originalGame(port)?.source_editions ?? [];
  return (
    <div className="grid gap-1 text-xs text-pc-muted-foreground">
      <p>{port.summary}</p>
      <p>
        Runs on:{" "}
        {port.platforms.length ? port.platforms.map(platformLabel).join(", ") : "Not recorded"}
      </p>
      <p>
        Original files:{" "}
        {port.presentation?.source_requirements
          ?.map((requirement) => requirement.label)
          .join("; ") || "Check project setup instructions"}
      </p>
      {editions.length > 0 && (
        <p>Source editions: {editions.map((edition) => edition.title).join("; ")}</p>
      )}
      <p>
        {status?.active
          ? `Managed installation · ${status.active.version}`
          : status?.external_runtime
            ? `External installation · ${status.external_runtime.version}`
            : status
              ? "Not installed"
              : "Installation state unavailable"}
      </p>
    </div>
  );
}

/** Focused detail-shell control; every alternative retains its own setup and action owner. */
export function GameAlternatives({
  port,
  ports,
  statuses,
  organization,
  onSelect,
}: {
  port: CatalogEntry;
  ports: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  organization: Organization;
  onSelect: (portId: string, originKey?: string) => void;
}) {
  const root = useRef<HTMLDetailsElement>(null);
  const binding = JSON.stringify([port.id, ports.map((entry) => entry.id)]);
  const current = useRef<string | undefined>(binding);
  useLayoutEffect(() => {
    current.current = binding;
    return () => {
      current.current = undefined;
    };
  }, [binding]);
  if (ports.length < 2) return null;
  return (
    <details ref={root} className="min-w-0 basis-full text-sm">
      <summary data-focusable className="cursor-pointer py-2">
        Implementations ({ports.length})
      </summary>
      <p className="mb-2 text-xs text-pc-muted-foreground">
        Each project keeps its own files and installation. Choosing one does not transfer saves or
        choose a release.
      </p>
      <div className="grid gap-3">
        {ports.map((candidate) => (
          <div key={candidate.id} className="grid gap-2 rounded-pc-md border border-pc-border p-3">
            <strong>
              {gameProjectLabel(candidate) || candidate.name}
              {candidate.id === port.id ? " · Viewing" : ""}
            </strong>
            <ImplementationFacts port={candidate} status={statuses.get(candidate.id)} />
            <ImplementationChoice
              port={candidate}
              organization={organization}
              onSelected={(trigger) => {
                if (current.current === binding && ownsChoiceFocus(trigger, root.current))
                  onSelect(candidate.id, `detail:alternative:${candidate.id}`);
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              data-focusable
              data-detail-origin={`detail:alternative:${candidate.id}`}
              onClick={() => onSelect(candidate.id, `detail:alternative:${candidate.id}`)}
            >
              View {gameProjectLabel(candidate) || candidate.name}
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}
