import {
  maxSetupReviewSelection,
  useSetupReviewSelection,
} from "../features/game-file-discovery/setup-review-selection";
import { useEffect, useRef } from "react";
import type { PortDefinition, PortStatus, SourceRecord, SourceInspectionReport } from "../types";
import { preliminarySelectionRecord } from "./PreliminarySourceSelections";
import { Button } from "./ui/button";
import { gameTitle, gameProjectLabel } from "../port-identity";
import { ArtworkImage } from "./Artwork";
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
  onAddToLibrary,
  onReviewInstall,
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
  onAddToLibrary?: ((portIds: string[]) => void) | undefined;
  onReviewInstall?: ((portIds: string[]) => void) | undefined;
  focusFallback?: (() => HTMLElement | null) | undefined;
}) {
  const { selected, toggle, selectAll, clear, requestReview } = useSetupReviewSelection();
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
  // Several versions that can use the same files are never selected together
  // automatically; the player chooses between them.
  const versions = new Map<string, number>();
  for (const port of available)
    if (port.source_profile)
      versions.set(port.source_profile, (versions.get(port.source_profile) ?? 0) + 1);
  const needsChoice = available.filter(
    (port) => port.source_profile && (versions.get(port.source_profile) ?? 0) > 1,
  );
  const eligible = available.filter((port) => !needsChoice.includes(port));
  const unselectedEligible = eligible.filter((port) => !selected.includes(port.id));
  if (!available.length && !selected.length) return null;
  return (
    <section ref={section} aria-label="Selected setup reviews" className="col-span-full">
      <h3>Select ports for setup review</h3>
      <p>
        Select games to review their setup, one at a time or together. Selecting a game doesn't
        register files or install anything.
      </p>
      <p role="status">
        {selected.length} selected · {eligible.length} eligible
        {needsChoice.length > 0 && ` · ${needsChoice.length} need a version choice`}
      </p>
      {needsChoice.length > 0 && (
        <p>
          More than one version can use the same files for {needsChoice.length}{" "}
          {needsChoice.length === 1 ? "game" : "games"}. Select the version you want; selecting all
          leaves them out.
        </p>
      )}
      {unselectedEligible.length > 0 && (
        <Button
          data-focusable
          variant="outline"
          disabled={selected.length >= maxSetupReviewSelection}
          onClick={() => selectAll(unselectedEligible.map((port) => port.id))}
        >
          Select all {eligible.length} eligible
        </Button>
      )}
      {available.map((port) => (
        <label key={port.id} className="setup-review-choice">
          <Checkbox
            data-focusable
            data-setup-review-port={port.id}
            checked={selected.includes(port.id)}
            disabled={!selected.includes(port.id) && selected.length >= maxSetupReviewSelection}
            onCheckedChange={() => toggle(port.id)}
          />
          <ArtworkImage port={port} quietFallback className="setup-review-artwork" />
          <span className="setup-review-identity">
            <strong>{gameTitle(port)}</strong>
            <span>{gameProjectLabel(port)}</span>
          </span>
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
          <p>Return here after each review to continue.</p>
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
          {onAddToLibrary && (
            <Button
              data-focusable
              disabled={!current || busy}
              onClick={() => {
                onAddToLibrary(selected);
                clear();
              }}
            >
              Add {selected.length} selected to Library
            </Button>
          )}
          {onReviewInstall && (
            <Button
              data-focusable
              disabled={!current || busy || !selected.some(canReview)}
              onClick={() => {
                onReviewInstall(selected);
                clear();
              }}
            >
              Review installing {selected.length} selected
            </Button>
          )}
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
