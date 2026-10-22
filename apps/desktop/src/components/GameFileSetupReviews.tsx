import {
  maxSetupReviewSelection,
  useSetupReviewSelection,
} from "../features/game-file-discovery/setup-review-selection";
import { useEffect, useRef } from "react";
import type { PortDefinition, PortStatus, SourceRecord, SourceInspectionReport } from "../types";
import { preliminarySelectionRecord } from "./PreliminarySourceSelections";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export function GameFileSetupReviews({
  ports,
  statuses,
  candidates,
  preliminarySelections = [],
  registeredSources,
  current,
  busy,
  onOpenPort,
  focusFallback,
}: {
  ports: PortDefinition[];
  statuses: ReadonlyMap<string, PortStatus>;
  candidates: Pick<SourceRecord, "profile_id" | "path" | "sha256">[];
  preliminarySelections?: NonNullable<SourceInspectionReport["inspection"]>[] | undefined;
  registeredSources: SourceRecord[];
  current: boolean;
  busy: boolean;
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
  focusFallback?: (() => HTMLElement | null) | undefined;
}) {
  const { selected, toggle, clear, requestReview } = useSetupReviewSelection();
  const section = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (
      section.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)") ??
      focusFallback?.() ??
      document.getElementById("game-file-libraries-heading")
    )?.focus();
  }, [selected, focusFallback]);
  const matchesRegistration = (candidate: Pick<SourceRecord, "profile_id" | "path" | "sha256">) =>
    registeredSources.some(
      (source) =>
        source.profile_id === candidate.profile_id &&
        source.path === candidate.path &&
        source.sha256 === candidate.sha256,
    );
  const registeredPreliminary = preliminarySelections.flatMap((selection) => {
    const record = preliminarySelectionRecord(selection);
    return record && matchesRegistration(record) ? [record] : [];
  });
  const profiles = new Set(
    [...candidates.filter(matchesRegistration), ...registeredPreliminary].map(
      (candidate) => candidate.profile_id,
    ),
  );
  const preliminaryProfiles = new Set(registeredPreliminary.map((record) => record.profile_id));
  const compatible = ports.filter(
    (port) =>
      (port.source_profile && profiles.has(port.source_profile)) ||
      (port.bios_source_profile && profiles.has(port.bios_source_profile)),
  );
  const canReview = (id: string) => {
    const status = statuses.get(id);
    return (
      current &&
      !busy &&
      Boolean(onOpenPort) &&
      compatible.some((port) => port.id === id) &&
      !status?.active &&
      !status?.external_runtime &&
      status?.port_actions?.some(
        (action) => action.action === "install" && action.availability === "allowed",
      )
    );
  };
  const available = compatible.filter((port) => canReview(port.id));
  if (!available.length && !selected.length) return null;
  return (
    <section ref={section} aria-label="Selected setup reviews" className="col-span-full">
      <h3>Select ports for setup review</h3>
      <p>
        Select up to {maxSetupReviewSelection} independent ports. Each opens the existing setup
        review; selecting a port does not register files or install anything.
      </p>
      {available.map((port) => (
        <label
          key={port.id}
          className="flex min-h-10 cursor-pointer flex-wrap items-center gap-3 py-2"
        >
          <Checkbox
            data-focusable
            data-setup-review-port={port.id}
            checked={selected.includes(port.id)}
            disabled={!selected.includes(port.id) && selected.length >= maxSetupReviewSelection}
            onCheckedChange={() => toggle(port.id)}
          />
          {port.name} <span className="text-pc-muted-foreground">({port.id})</span>
          {(preliminaryProfiles.has(port.source_profile ?? "") ||
            preliminaryProfiles.has(port.bios_source_profile ?? "")) && (
            <span className="block text-pc-muted-foreground">
              Validation has not run for a selected input. Review setup requirements before
              continuing.
            </span>
          )}
        </label>
      ))}
      {selected.length > 0 && (
        <>
          <p role="status">
            {selected.length} of {maxSetupReviewSelection} ports selected. Return here after each
            review to continue.
          </p>
          <ol>
            {selected.map((id) => (
              <li key={id}>
                <span>{ports.find((port) => port.id === id)?.name ?? id}</span>
                {!canReview(id) && (
                  <p>
                    Setup review is unavailable in the current view. Refresh the workspace and
                    folders, or check game details for remaining requirements.
                  </p>
                )}
                <Button
                  data-focusable
                  variant="outline"
                  disabled={!canReview(id)}
                  onClick={() => {
                    const channel = statuses.get(id)?.channel;
                    if (!channel) return;
                    requestReview(id, channel);
                    onOpenPort?.(id, "game-file-libraries-setup");
                  }}
                >
                  Review {ports.find((port) => port.id === id)?.name ?? id} setup
                </Button>
                <Button
                  data-focusable
                  variant="ghost"
                  onClick={() => {
                    restoreFocus.current = true;
                    toggle(id);
                  }}
                >
                  Remove {ports.find((port) => port.id === id)?.name ?? id} from selection
                </Button>
              </li>
            ))}
          </ol>
          <Button
            data-focusable
            variant="outline"
            onClick={() => {
              restoreFocus.current = true;
              clear();
            }}
          >
            Clear setup selection
          </Button>
        </>
      )}
    </section>
  );
}
