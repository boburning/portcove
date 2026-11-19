import {
  maxSetupReviewSelection,
  useSetupReviewSelection,
} from "../features/game-file-discovery/setup-review-selection";
import { useEffect, useRef } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
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
  onReviewInstall?:
    | ((portIds: string[], origin: HTMLButtonElement, owner: HTMLElement) => void)
    | undefined;
  focusFallback?: (() => HTMLElement | null) | undefined;
}) {
  const { t } = useAppTranslation("gameFiles");
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
  // Versions are counted across every catalog game using the same files, so a
  // lone reviewable version whose sibling is installed or blocked still waits
  // for the player's choice.
  const versions = new Map<string, number>();
  for (const port of ports)
    if (port.source_profile)
      versions.set(port.source_profile, (versions.get(port.source_profile) ?? 0) + 1);
  const needsChoice = available.filter(
    (port) => port.source_profile && (versions.get(port.source_profile) ?? 0) > 1,
  );
  const choiceGames = new Set(needsChoice.map((port) => port.source_profile)).size;
  const eligible = available.filter((port) => !needsChoice.includes(port));
  const unselectedEligible = eligible.filter((port) => !selected.includes(port.id));
  const room = Math.max(0, maxSetupReviewSelection - selected.length);
  const toSelect = Math.min(unselectedEligible.length, room);
  if (!available.length && !selected.length) return null;
  return (
    <section ref={section} aria-label={t("setupReviews.label")} className="col-span-full">
      <h3>{t("setupReviews.heading")}</h3>
      <p>{t("setupReviews.intro")}</p>
      <p>
        {choiceGames > 0 ? (
          <Trans
            t={t}
            i18nKey="setupReviews.countsWithChoice"
            count={choiceGames}
            values={{ selected: selected.length, eligible: eligible.length }}
            components={{ status: <span role="status" /> }}
          />
        ) : (
          <Trans
            t={t}
            i18nKey="setupReviews.counts"
            values={{ selected: selected.length, eligible: eligible.length }}
            components={{ status: <span role="status" /> }}
          />
        )}
      </p>
      {choiceGames > 0 && <p>{t("setupReviews.choiceNote", { count: choiceGames })}</p>}
      {toSelect > 0 && (
        <Button
          data-focusable
          variant="outline"
          onClick={() => {
            // The button disappears once everything is selected; keep focus in the section.
            restoreFocus.current = true;
            selectAll(unselectedEligible.map((port) => port.id));
          }}
        >
          {toSelect === unselectedEligible.length && toSelect === eligible.length
            ? t("setupReviews.selectAll", { total: toSelect })
            : t("setupReviews.selectMore", { total: toSelect })}
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
            <span className="block text-pc-muted-foreground">{t("setupReviews.unvalidated")}</span>
          )}
        </label>
      ))}
      {selected.length > 0 && (
        <>
          <p className="mt-3">{t("setupReviews.returnNote")}</p>
          <ol className="mt-2 grid list-decimal gap-3 ps-5">
            {selected.map((id) => {
              const name = ports.find((port) => port.id === id)?.name ?? id;
              const reviewable = canReview(id);
              return (
                <li key={id} className="min-w-0">
                  <bdi className="block font-medium wrap-anywhere">{name}</bdi>
                  {!reviewable && (
                    <p className="text-xs text-pc-muted-foreground">
                      {t("setupReviews.unavailable")}
                    </p>
                  )}
                  <div className="mt-2 flex min-w-0 flex-wrap gap-2">
                    <Button
                      data-focusable
                      variant="outline"
                      disabled={!reviewable}
                      onClick={() => {
                        const channel = statuses.get(id)?.channel;
                        if (!channel) return;
                        requestReview(id, channel);
                        onOpenPort?.(id, "game-file-libraries-setup");
                      }}
                    >
                      <span className="min-w-0">
                        <Trans
                          t={t}
                          i18nKey="setupReviews.review"
                          components={{ name: <bdi>{name}</bdi> }}
                        />
                      </span>
                    </Button>
                    <Button
                      data-focusable
                      variant="ghost"
                      onClick={() => {
                        restoreFocus.current = true;
                        toggle(id);
                      }}
                    >
                      <span className="min-w-0">
                        <Trans
                          t={t}
                          i18nKey="setupReviews.remove"
                          components={{ name: <bdi>{name}</bdi> }}
                        />
                      </span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-3 flex min-w-0 flex-wrap gap-2">
            {onAddToLibrary && (
              <Button
                data-focusable
                disabled={!current || busy}
                onClick={() => {
                  onAddToLibrary(selected);
                  clear();
                }}
              >
                {t("setupReviews.add", { total: selected.length })}
              </Button>
            )}
            {onReviewInstall && (
              <Button
                data-focusable
                disabled={!current || busy || !selected.some(canReview)}
                onClick={(event) => {
                  if (!section.current) return;
                  onReviewInstall(selected, event.currentTarget, section.current);
                  clear();
                }}
              >
                {t("setupReviews.reviewInstall", { total: selected.length })}
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
              {t("setupReviews.clear")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
