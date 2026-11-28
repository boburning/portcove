import { focusableControls } from "../../focus";
import { VirtualCollectionRows } from "./VirtualCollectionRows";
import { ImplementationFacts } from "./ImplementationFacts";
import { useGameComparison } from "../recommendations/use-game-comparison";
import {
  GameComparisonControls,
  GameComparisonEvidence,
} from "../recommendations/GameComparisonEvidence";
import { presentPortAction, useOperationPresentation } from "../operations/operation-presentation";
import type { CollectionLayout } from "./use-collection-layout";
import type { useFavorites } from "../favorites/use-favorites";
import {
  FavoriteGameButton,
  FavoritePreferenceFailure,
  type FavoriteFocusRestore,
  type Organization,
} from "../organization/OrganizationControls";
import type { TFunction } from "i18next";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
import { ArrowRight, GitCompareArrows } from "lucide-react";
import { ArtworkFrame, artworkDisplayNotice } from "../../components/Artwork";
import { useArtwork, useArtworkVisibility, useCompanionCover } from "../../artwork";
import { ExternalLink } from "../../components/ExternalLink";
import { CapabilityNoticeScope } from "../../components/PortCapabilities";
import { LaunchBehaviorStages } from "../../components/LaunchBehaviorStages";
import { ReleaseWithdrawalBadge } from "../../components/ReleaseWithdrawal";
import { Button } from "../../components/ui/button";
import { Chip } from "../../components/ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { gameIdentityLabel, gameProjectLabel } from "../../port-identity";
import {
  platformLabel,
  installationMethodLabel,
  releaseChannelPresentation,
  type DetailDestination,
} from "../../view-model";
import type { PortDefinition, PortStatus } from "../../types";
import { IdentityIcon } from "../identity/IdentityIcon";
import { identityLabel, identityStyle } from "../identity/identity-style";
import { availablePlatforms } from "./catalog-entry";
import type { CatalogEntry } from "./catalog-entry";
import type {
  ExactNativeSourceDrop,
  NativeSourceGameDrop,
  NativeSourceDragState,
} from "../../native-source-drop";
import { browsePortPresentation } from "../port-actions/browse-presentation";
import { BrowsePortObservationsContent } from "../port-actions/BrowsePortObservations";
import {
  gameGroupPresentationPort,
  gameGroupTitle,
  groupCatalog,
  originalSystems,
  type GameGroup,
} from "./original-game";
import { ImplementationChoice, ownsChoiceFocus } from "./ImplementationChoice";
import { resolveGameChoice } from "./game-choice";

type IdentityChipsProps = {
  port: CatalogEntry;
  includeUnknown?: boolean;
};

export function IdentityChips(props: IdentityChipsProps) {
  const { t } = useAppTranslation("browsing");
  return <IdentityChipsContent {...props} t={t} />;
}

function IdentityChipsContent({
  port,
  includeUnknown = false,
  t,
}: IdentityChipsProps & { t: TFunction<"browsing"> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {originalSystems(port)
        .filter((system) => includeUnknown || system !== "not-specified")
        .map((system) => (
          <Chip key={system} style={identityStyle(system)} title={t("discover.chip.system")}>
            <IdentityIcon name={system} />
            {identityLabel(system)}
          </Chip>
        ))}
      {availablePlatforms(port).map((platform) => (
        <Chip key={platform} title={t("discover.chip.platform")}>
          <IdentityIcon name={platform.split("-")[0]!} />
          {platformLabel(platform)}
        </Chip>
      ))}
      {port.channels?.map((channel) => (
        <Chip key={channel} style={identityStyle(channel, true)} title={t("discover.chip.channel")}>
          <IdentityIcon name={channel} channel />
          {releaseChannelPresentation(channel).label}
        </Chip>
      ))}
    </div>
  );
}

// One shared default keeps unchanged cards from re-rendering on an omitted prop.
const idleNativeSourceDrag: NativeSourceDragState = { active: false, pathCount: 0 };

export function GroupedDiscover({
  resultsReady = true,
  queryKey = "",
  layout = "covers",
  all,
  onTask,
  matching,
  statuses,
  onSelect,
  organization,
  favorites,
  restoreAfter,
  nativeSourceDrag = idleNativeSourceDrag,
  devicePlatform,
  pendingGameDrop,
  onGameDropSelect,
  onGameDropDismiss,
}: {
  pendingGameDrop?: NativeSourceGameDrop | undefined;
  onGameDropSelect?: ((drop: ExactNativeSourceDrop) => void) | undefined;
  onGameDropDismiss?: (() => void) | undefined;
  resultsReady?: boolean | undefined;
  queryKey?: string | undefined;
  /** Known only when Core reports this device; otherwise platforms stay listed. */
  devicePlatform?: PortDefinition["platforms"][number] | undefined;
  layout?: CollectionLayout;
  organization?: Organization | undefined;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  restoreAfter?: FavoriteFocusRestore | undefined;
  nativeSourceDrag?: NativeSourceDragState | undefined;
  onTask?: ((activityId?: string) => void) | undefined;
  all: readonly CatalogEntry[];
  matching: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  onSelect: (portId: string, originKey?: string, destination?: DetailDestination) => void;
}) {
  const { t } = useAppTranslation("browsing");
  const groups = useMemo(() => groupCatalog(all, matching), [all, matching]);
  const descriptionPrefix = useId();
  const [comparisonSelection, setComparison] = useState<GameGroup>();
  const dropComparison =
    resultsReady && pendingGameDrop
      ? groups.find((group) => group.id === pendingGameDrop.gameId)
      : undefined;
  const comparison =
    dropComparison ??
    (comparisonSelection &&
      groupCatalog(all, all).find((group) =>
        group.ports.some((port) => port.id === comparisonSelection.ports[0]?.id),
      ));
  const owner = useOperationPresentation();
  const comparisonObservationKey = JSON.stringify([
    comparison?.ports,
    comparison?.ports.map((port) => statuses.get(port.id)),
    organization?.snapshot?.revision,
  ]);
  const evidence = useGameComparison({
    portId: comparison?.ports[0]?.id,
    generation: owner?.generation,
    observationKey: comparisonObservationKey,
  });
  const heading = useRef<HTMLHeadingElement>(null);
  const {
    pin,
    setPin,
    dialogRoot,
    rememberOrigin,
    dismissIntent,
    markLeaving,
    finishClose,
    finalFocus,
    choiceKeepsFocus,
  } = useComparisonReturnFocus({
    generation: owner?.generation,
    queryKey,
    comparisonId: comparison?.id,
    comparisonSelection,
    pendingGameDrop,
    onGameDropDismiss,
    clearSelection: setComparison,
  });

  // Cards are memoized, so these handlers keep their identity until something a
  // card shows changes.
  const compare = useCallback(
    (group: GameGroup, trigger: HTMLButtonElement) => {
      if (!resultsReady) return;
      rememberOrigin(group.id, trigger);
      dismissIntent();
      setPin(group.id);
      setComparison(group);
    },
    [dismissIntent, rememberOrigin, resultsReady, setPin],
  );
  const open = useCallback(
    (port: CatalogEntry, originKey: string) => {
      markLeaving();
      setComparison(undefined);
      onGameDropDismiss?.();
      onSelect(port.id, originKey);
    },
    [markLeaving, onSelect, onGameDropDismiss],
  );
  const reviewDroppedFiles = useCallback(
    (port: CatalogEntry, paths: readonly string[]) => {
      if (!port.source_profile || !onGameDropSelect) return;
      markLeaving();
      setComparison(undefined);
      onGameDropSelect({ portId: port.id, profileId: port.source_profile, paths: [...paths] });
    },
    [markLeaving, onGameDropSelect],
  );
  return (
    <>
      <VirtualCollectionRows
        ready={resultsReady}
        queryKey={queryKey}
        groups={groups}
        layout={layout}
        generation={owner?.generation}
        overlayPin={dropComparison?.id ?? pin}
        label={t("discover.label")}
      >
        {(group, index) => (
          <DiscoverGameCard
            onTask={onTask}
            key={group.id}
            group={group}
            position={index + 1}
            total={groups.length}
            showCompanion={layout === "covers"}
            statuses={statuses}
            descriptionPrefix={descriptionPrefix}
            nativeSourceDrag={resultsReady ? nativeSourceDrag : idleNativeSourceDrag}
            devicePlatform={devicePlatform}
            organization={organization}
            favorites={favorites}
            restoreAfter={restoreAfter}
            open={open}
            compare={compare}
          />
        )}
      </VirtualCollectionRows>
      <Dialog
        open={Boolean(comparison)}
        onOpenChangeComplete={finishClose}
        onOpenChange={(open) => {
          if (!open) {
            dismissIntent();
            if (dropComparison) setPin(dropComparison.id);
            setComparison(undefined);
            onGameDropDismiss?.();
          }
        }}
      >
        <DialogContent
          ref={dialogRoot}
          reviewSize="large"
          className="port-comparison-dialog"
          initialFocus={heading}
          finalFocus={finalFocus}
        >
          {comparison && (
            <>
              <DialogTitle ref={heading} tabIndex={-1}>
                {gameGroupTitle(comparison)}
              </DialogTitle>
              <DialogDescription>
                {comparison.ports.length === 1
                  ? t("discover.compare.single")
                  : t("discover.compare.several", { total: comparison.ports.length })}
              </DialogDescription>
              <FavoriteGameButton
                port={gameGroupPresentationPort(comparison)}
                groupPorts={comparison.ports}
                favorites={favorites}
                organization={organization}
              />
              <FavoritePreferenceFailure favorites={favorites} organization={organization} />
              {dropComparison && <p className="my-3 text-sm">{t("discover.drop.choose")}</p>}
              <GameComparisonControls comparison={evidence} />
              <p className="mb-4 text-xs text-pc-muted-foreground">
                {t("discover.compare.optionsIntro")}
              </p>
              <div className="port-comparison-grid">
                {comparison.ports.map((port) => (
                  <ComparisonProject
                    key={port.id}
                    port={port}
                    status={statuses.get(port.id)}
                    single={comparison.ports.length === 1}
                    matchesFilters={matching.some((candidate) => candidate.id === port.id)}
                    platform={
                      evidence.context.platform || devicePlatform || evidence.report?.platform
                    }
                    explicitOtherPlatform={Boolean(
                      evidence.context.platform && evidence.context.platform !== devicePlatform,
                    )}
                    evidence={evidence}
                    organization={organization}
                    descriptionPrefix={descriptionPrefix}
                    nativeSourceDrag={nativeSourceDrag}
                    droppedFiles={
                      dropComparison && onGameDropSelect ? pendingGameDrop?.paths : undefined
                    }
                    reviewDroppedFiles={reviewDroppedFiles}
                    open={() => open(port, `catalog:card:${comparison.matchingPorts[0]!.id}`)}
                    choiceKeepsFocus={choiceKeepsFocus}
                  />
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

type ComparisonReturnOrigin = {
  collection: HTMLElement | null;
  groupKey: string;
  originKey: string | undefined;
  controlKey: string | undefined;
  controlIndex: number;
  generation: number | undefined;
  queryKey: string;
};

function useComparisonReturnFocus({
  generation,
  queryKey,
  comparisonId,
  comparisonSelection,
  pendingGameDrop,
  onGameDropDismiss,
  clearSelection,
}: {
  generation: number | undefined;
  queryKey: string;
  comparisonId: string | undefined;
  comparisonSelection: GameGroup | undefined;
  pendingGameDrop: NativeSourceGameDrop | undefined;
  onGameDropDismiss: (() => void) | undefined;
  clearSelection: (selection: undefined) => void;
}) {
  const dialogRoot = useRef<HTMLDivElement>(null);
  const handledDrop = useRef<NativeSourceGameDrop | undefined>(undefined);
  const intentBinding = useMemo(
    () => [comparisonSelection, pendingGameDrop, comparisonId, generation] as const,
    [comparisonSelection, pendingGameDrop, comparisonId, generation],
  );
  const currentIntent = useMemo(() => ({ active: Boolean(intentBinding[2]) }), [intentBinding]);
  const comparisonIntent = useRef(currentIntent);
  useLayoutEffect(() => {
    comparisonIntent.current = currentIntent;
    return () => {
      currentIntent.active = false;
    };
  }, [currentIntent]);
  const origin = useRef<ComparisonReturnOrigin | undefined>(undefined);
  const leaving = useRef(false);
  const [pin, setPin] = useState<string>();
  const rememberOrigin = useCallback(
    (groupKey: string, trigger: HTMLButtonElement | null) => {
      leaving.current = false;
      const card = trigger?.closest<HTMLElement>("[data-detail-return-group]");
      origin.current = {
        collection: trigger?.closest<HTMLElement>("[data-virtual-collection]") ?? null,
        groupKey,
        originKey: trigger?.dataset.detailOrigin,
        controlKey: trigger?.dataset.collectionControl,
        controlIndex: card && trigger ? focusableControls(card).indexOf(trigger) : -1,
        generation,
        queryKey,
      };
    },
    [generation, queryKey],
  );
  const dismissIntent = useCallback(() => {
    comparisonIntent.current.active = false;
  }, []);
  const markLeaving = useCallback(() => {
    dismissIntent();
    leaving.current = true;
  }, [dismissIntent]);
  useLayoutEffect(() => {
    if (handledDrop.current !== pendingGameDrop) {
      handledDrop.current = pendingGameDrop;
      if (pendingGameDrop) {
        const trigger = document.querySelector<HTMLButtonElement>(
          `[data-detail-return-group="${CSS.escape(pendingGameDrop.gameId)}"] .discover-game-identity`,
        );
        rememberOrigin(pendingGameDrop.gameId, trigger);
        return;
      }
    }
    const saved = origin.current;
    if (!saved || (saved.generation === generation && saved.queryKey === queryKey)) return;
    markLeaving();
    origin.current = undefined;
    clearSelection(undefined);
    setPin(undefined);
    if (pendingGameDrop) onGameDropDismiss?.();
  }, [
    clearSelection,
    generation,
    markLeaving,
    onGameDropDismiss,
    pendingGameDrop,
    queryKey,
    rememberOrigin,
  ]);
  useLayoutEffect(() => {
    if (!pin) return;
    const release = (event: FocusEvent) => {
      if (
        comparisonIntent.current.active ||
        (event.target instanceof Node && dialogRoot.current?.contains(event.target))
      )
        return;
      document.removeEventListener("focusin", release, true);
      setPin(undefined);
    };
    // Base UI 1.9 resolves finalFocus in cleanup and focuses in a microtask.
    // Keep the virtual row until that real focus event transfers its pin to the
    // collection; releasing on transition completion can detach the return node.
    document.addEventListener("focusin", release, true);
    return () => document.removeEventListener("focusin", release, true);
  }, [pin]);
  const finishClose = (open: boolean) => {
    if (!open && leaving.current) setPin(undefined);
  };
  const finalFocus = (): HTMLElement | null | false => {
    const saved = origin.current;
    if (leaving.current || saved?.generation !== generation || saved?.queryKey !== queryKey)
      return false;
    const target = comparisonReturnTarget(saved);
    if (!target) setPin(undefined);
    return target;
  };
  function choiceKeepsFocus(trigger: HTMLButtonElement) {
    return (
      comparisonIntent.current === currentIntent &&
      currentIntent.active &&
      ownsChoiceFocus(trigger, dialogRoot.current)
    );
  }
  return {
    pin,
    setPin,
    dialogRoot,
    rememberOrigin,
    dismissIntent,
    markLeaving,
    finishClose,
    finalFocus,
    choiceKeepsFocus,
  };
}

function comparisonReturnTarget(saved: ComparisonReturnOrigin | undefined) {
  const card = saved?.collection?.isConnected
    ? saved.collection.querySelector<HTMLElement>(
        `[data-detail-return-group="${CSS.escape(saved.groupKey)}"]`,
      )
    : null;
  // Base UI resolves finalFocus in layout cleanup before its passive
  // aria-hidden cleanup. The dialog's temporary outside masking must
  // not hide this exact return target from the resolver.
  const controls = card
    ? [...card.querySelectorAll<HTMLButtonElement>("button")].filter(
        (control) =>
          !control.matches(":disabled, [aria-disabled=true], [aria-hidden=true]") &&
          !control.closest("[hidden], [inert]") &&
          control.getClientRects().length > 0 &&
          getComputedStyle(control).visibility !== "hidden",
      )
    : [];
  const target =
    controls.find((control, index) =>
      saved?.originKey
        ? control.dataset.detailOrigin === saved.originKey
        : saved?.controlKey
          ? control.dataset.collectionControl === saved.controlKey
          : index === saved?.controlIndex,
    ) ??
    controls[0] ??
    null;
  // Responsive regrouping keeps the return card mounted, but it can
  // move outside the viewport while focus belongs to the dialog.
  target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  return target;
}

type ComparisonProjectActionsProps = {
  port: CatalogEntry;
  status: PortStatus | undefined;
  single: boolean;
  organization: Organization | undefined;
  describedBy: string | undefined;
  droppedFiles: readonly string[] | undefined;
  reviewDroppedFiles: (port: CatalogEntry, paths: readonly string[]) => void;
  open: () => void;
  choiceKeepsFocus: (trigger: HTMLButtonElement) => boolean;
};

function ComparisonProject({
  port,
  status,
  single,
  organization,
  droppedFiles,
  reviewDroppedFiles,
  open,
  choiceKeepsFocus,
  matchesFilters,
  platform,
  explicitOtherPlatform,
  evidence,
  descriptionPrefix,
  nativeSourceDrag,
}: Omit<ComparisonProjectActionsProps, "describedBy"> & {
  matchesFilters: boolean;
  platform: ComparisonPortFactsProps["platform"];
  explicitOtherPlatform: boolean;
  evidence: ReturnType<typeof useGameComparison>;
  descriptionPrefix: string;
  nativeSourceDrag: NativeSourceDragState;
}) {
  const { t } = useAppTranslation("browsing");
  const observation = browsePortPresentation(port, status, "catalog");
  const descriptionId = `${descriptionPrefix}:comparison:${encodeURIComponent(port.id)}`;
  const describedBy = observation.input || observation.setup ? descriptionId : undefined;
  const dropEligible = sourceDropEligible(port, status, nativeSourceDrag);
  const checkedDrop =
    droppedFiles &&
    sourceDropEligible(port, status, { active: true, pathCount: droppedFiles.length })
      ? droppedFiles
      : undefined;
  return (
    <article
      className="port-comparison-project min-w-0 wrap-anywhere"
      aria-label={t("discover.cardLabel", {
        game: gameIdentityLabel(port),
        state: observation.state.label,
      })}
      aria-describedby={describedBy}
      data-source-drop-port-id={dropEligible ? port.id : undefined}
      data-source-drop-profile-id={dropEligible ? port.source_profile : undefined}
    >
      <header>
        <h3>{gameProjectLabel(port) || port.name}</h3>
        <p>{port.summary}</p>
        <IdentityChips port={port} includeUnknown />
        {!single && !port.platforms.length && <p>{t("discover.compare.noPlatform")}</p>}
        {!single && !port.channels?.length && <p>{t("discover.compare.noChannel")}</p>}
        {!matchesFilters && (
          <p className="text-sm text-pc-muted-foreground">{t("discover.compare.outsideFilters")}</p>
        )}
      </header>
      <ComparisonPortFacts
        port={port}
        status={status}
        single={single}
        platform={platform}
        explicitOtherPlatform={explicitOtherPlatform}
      />
      <div className="grid min-w-0 content-start gap-2">
        <ImplementationFacts port={port} />
        <GameComparisonEvidence
          comparison={evidence}
          portId={port.id}
          organization={organization}
        />
      </div>
      <div>
        <h4>{t("discover.compare.status")}</h4>
        <BrowsePortObservationsContent
          t={t}
          port={port}
          status={status}
          observation={observation}
          descriptionId={descriptionId}
          noticeChoice={organization?.snapshot?.update_notices[port.id]}
        />
      </div>

      <ComparisonProjectActions
        port={port}
        status={status}
        single={single}
        organization={organization}
        describedBy={describedBy}
        droppedFiles={checkedDrop}
        reviewDroppedFiles={reviewDroppedFiles}
        open={open}
        choiceKeepsFocus={choiceKeepsFocus}
      />
    </article>
  );
}

function ComparisonProjectActions({
  port,
  status,
  single,
  organization,
  describedBy,
  droppedFiles,
  reviewDroppedFiles,
  open,
  choiceKeepsFocus,
}: ComparisonProjectActionsProps) {
  const { t } = useAppTranslation("browsing");
  return (
    <div className="mt-3 flex flex-wrap gap-3">
      {droppedFiles && (
        <Button
          data-focusable
          variant="outline"
          onClick={() => reviewDroppedFiles(port, droppedFiles)}
        >
          <Trans
            t={t}
            i18nKey="discover.drop.checkWith"
            components={{ name: <bdi>{gameProjectLabel(port) || port.name}</bdi> }}
          />
        </Button>
      )}
      {!single && (
        <ImplementationChoice
          port={port}
          organization={organization}
          onSelected={(trigger) => {
            if (!choiceKeepsFocus(trigger)) return;
            if (droppedFiles) reviewDroppedFiles(port, droppedFiles);
            else open();
          }}
        />
      )}
      <Button
        data-focusable
        variant="outline"
        onClick={open}
        data-discover-port-id={port.id}
        aria-label={t("discover.memberLabel", {
          action: memberLabel(t, port, status),
          game: gameIdentityLabel(port),
        })}
        aria-describedby={describedBy}
      >
        {memberLabel(t, port, status)}
      </Button>
      {port.project_url && (
        <ExternalLink href={port.project_url}>{t("discover.compare.instructions")}</ExternalLink>
      )}
    </div>
  );
}

type ComparisonPortFactsProps = {
  port: CatalogEntry;
  status: PortStatus | undefined;
  single: boolean;
  platform: PortDefinition["platforms"][number] | undefined;
  explicitOtherPlatform: boolean;
};

function ComparisonSetupFacts({
  port,
  single,
  platform,
  explicitOtherPlatform,
}: Omit<ComparisonPortFactsProps, "status">) {
  const { t } = useAppTranslation("browsing");
  const { t: tDetail } = useAppTranslation("detail");
  const setupLabel = installationMethodLabel(port);
  const setupKnown = setupLabel !== "Unavailable in this catalog";
  const report = port.listingStatus?.capabilities;
  // Launch advisories display their own edition scope. The comparison uses separate edition IDs.
  const launchNotices =
    report?.format_version === 1 && report.port_id === port.id
      ? report.advisories.filter(
          ({ notice, applicability }) =>
            notice.launch_behavior &&
            notice.platform === platform &&
            (applicability !== "historical" ||
              (explicitOtherPlatform && notice.route === "upstream-setup")),
        )
      : [];
  if (single && !setupKnown && launchNotices.length === 0) return null;
  return (
    <div>
      <h4>{t("discover.compare.setup")}</h4>
      {(setupKnown || launchNotices.length === 0) && <p>{setupLabel}</p>}
      {launchNotices.map(({ notice, applicability }) =>
        notice.launch_behavior ? (
          <div className="mt-3 grid gap-1 text-sm" key={notice.id}>
            <LaunchBehaviorStages behavior={notice.launch_behavior} />
            <p>{notice.explanation}</p>
            <p>
              {notice.evidence === "observed"
                ? tDetail("capabilities.launch.evidenceObserved")
                : tDetail("capabilities.launch.evidenceUpstream")}
            </p>
            <CapabilityNoticeScope notice={notice} discloseArtifact />
            {applicability !== "current-route" && <p>{tDetail("capabilities.notice.exact")}</p>}
            <ExternalLink href={notice.provenance}>
              {tDetail("capabilities.notice.source")}
            </ExternalLink>
          </div>
        ) : null,
      )}
    </div>
  );
}

function ComparisonPortFacts({
  port,
  status,
  single,
  platform,
  explicitOtherPlatform,
}: ComparisonPortFactsProps) {
  const { t } = useAppTranslation("browsing");
  const filesListed = Boolean(port.presentation?.source_requirements?.length);
  const ownershipKnown = Boolean(status?.active || status?.external_runtime);
  return (
    <>
      <ComparisonSetupFacts
        port={port}
        single={single}
        platform={platform}
        explicitOtherPlatform={explicitOtherPlatform}
      />
      {(!single || filesListed) && (
        <div>
          <h4>
            {port.optional_game_source && !port.bios_source_profile
              ? t("discover.compare.filesOptional")
              : t("discover.compare.files")}
          </h4>
          {port.presentation?.source_requirements?.length ? (
            <ul>
              {port.presentation.source_requirements.map((requirement) => (
                <li key={requirement.profile_id}>{requirement.label}</li>
              ))}
            </ul>
          ) : (
            <p>{t("discover.compare.filesUnlisted")}</p>
          )}
        </div>
      )}
      {(!single || ownershipKnown) && (
        <div>
          <h4>{t("discover.compare.updates")}</h4>
          {renderComparisonOwnership(t, status)}
        </div>
      )}
    </>
  );
}

function renderComparisonOwnership(t: TFunction<"browsing">, status: PortStatus | undefined) {
  return (
    <p>
      {status?.active ? t("discover.ownership.managed") : ""}
      {status?.external_runtime ? t("discover.ownership.external") : ""}
      {!status
        ? t("discover.ownership.unavailable")
        : !status.active && !status.external_runtime
          ? t("discover.ownership.notInstalled")
          : ""}
    </p>
  );
}

const DiscoverGameCard = memo(DiscoverGameCardView, (previous, next) => {
  const { group: previousGroup, ...previousRest } = previous;
  const { group: nextGroup, ...nextRest } = next;
  const same = (a: readonly CatalogEntry[], b: readonly CatalogEntry[]) =>
    a.length === b.length && a.every((port, index) => port === b[index]);
  return (
    previousGroup.id === nextGroup.id &&
    same(previousGroup.ports, nextGroup.ports) &&
    same(previousGroup.matchingPorts, nextGroup.matchingPorts) &&
    Object.keys(previousRest).length === Object.keys(nextRest).length &&
    Object.entries(previousRest).every(([key, value]) =>
      Object.is(value, (nextRest as Record<string, unknown>)[key]),
    )
  );
});

function DiscoverGameCardView({
  group,
  position,
  total,
  showCompanion,
  onTask,
  statuses,
  descriptionPrefix,
  nativeSourceDrag,
  devicePlatform,
  organization,
  favorites,
  restoreAfter,
  open,
  compare,
}: {
  group: GameGroup;
  position: number;
  total: number;
  showCompanion: boolean;
  onTask?: ((activityId?: string) => void) | undefined;
  statuses: ReadonlyMap<string, PortStatus>;
  descriptionPrefix: string;
  nativeSourceDrag: NativeSourceDragState;
  devicePlatform?: PortDefinition["platforms"][number] | undefined;
  organization?: Organization | undefined;
  favorites?: ReturnType<typeof useFavorites> | undefined;
  restoreAfter?: FavoriteFocusRestore | undefined;
  open: (port: CatalogEntry, originKey: string) => void;
  compare: (group: GameGroup, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useAppTranslation("browsing");
  const { first, dropChosen, actionGroup, status, exact, firstProject, projectLabel } =
    discoverCardIdentity(t, group, statuses, organization, devicePlatform);
  const presentation = gameGroupPresentationPort(group);
  const title = gameGroupTitle(group);
  const observation = browsePortPresentation(first, status, "catalog");
  const descriptionId = `${descriptionPrefix}:${encodeURIComponent(first.id)}`;
  const describedBy = exact && (observation.input || observation.setup) ? descriptionId : undefined;
  const labels = discoverCardLabels(t, group, title, {
    first,
    status,
    exact,
    firstProject,
    projectLabel,
    state: observation.state.label,
  });
  const drop = discoverCardDrop(group, dropChosen, statuses, nativeSourceDrag);
  const detailOrigin = `catalog:card:${first.id}`;
  const { element: artworkElement, visible, priority } = useArtworkVisibility();
  const { display: artwork } = useArtwork(presentation.id, "cover", visible, priority);
  const companion = useCompanionCover(
    presentation.id,
    showCompanion ? presentation.presentation?.companion_cover?.image_sha256 : undefined,
    artwork,
    visible,
    priority,
  );
  const artworkNotice = artworkDisplayNotice(artwork);
  return (
    <article
      aria-posinset={position}
      aria-setsize={total}
      key={group.id}
      className={`discover-game relative min-w-0${drop?.targeted ? " outline-3 outline-offset-2 outline-pc-ring" : ""}`}
      aria-label={labels.card}
      aria-describedby={describedBy}
      data-source-drop-game-id={drop?.gameId}
      data-source-drop-port-id={drop?.portId}
      data-source-drop-profile-id={drop?.profileId}
      data-discover-port-ids={JSON.stringify(group.ports.map((port) => port.id))}
      data-detail-return-group={group.id}
      data-discover-matching-port-ids={JSON.stringify(group.matchingPorts.map((port) => port.id))}
      data-discover-primary-port-id={exact ? first.id : undefined}
    >
      <Button
        variant="ghost"
        className="discover-game-identity grid w-full min-w-0 justify-start justify-items-stretch gap-x-3 gap-y-0 p-0 text-start"
        data-focusable
        data-detail-origin={detailOrigin}
        data-detail-game-id={first.id}
        aria-label={labels.identity}
        aria-describedby={describedBy}
        onClick={(event) =>
          exact ? open(first, detailOrigin) : compare(group, event.currentTarget)
        }
      >
        <ArtworkFrame
          element={artworkElement}
          display={artwork}
          portId={presentation.id}
          visible={visible}
          priority={priority}
          companion={companion}
          identityArtwork
          className="collection-art"
        />
        <h2 className="collection-title font-semibold">{title}</h2>{" "}
        {projectLabel && (
          <p className="collection-project text-pc-muted-foreground">{projectLabel}</p>
        )}
      </Button>
      {exact && <ReleaseWithdrawalBadge status={status} />}
      <div className="collection-personal-actions">
        <FavoriteGameButton
          card
          port={presentation}
          groupPorts={group.ports}
          organization={organization}
          favorites={favorites}
          restoreAfter={restoreAfter}
        />
      </div>
      <DiscoverGameMetadata
        t={t}
        port={first}
        status={status}
        exact={exact}
        devicePlatform={devicePlatform}
        artworkNotice={artworkNotice}
      />
      <DiscoverGameObservation
        t={t}
        group={actionGroup}
        first={first}
        status={status}
        observation={observation}
        descriptionId={descriptionId}
        firstProject={firstProject}
        organization={organization}
      />
      <DiscoverGameActions
        t={t}
        onTask={onTask}
        group={actionGroup}
        statuses={statuses}
        first={first}
        detailOrigin={detailOrigin}
        describedBy={describedBy}
        open={open}
        compare={compare}
      />
      {drop && (
        <div
          aria-hidden="true"
          className="source-drop-target pointer-events-none absolute inset-0 grid place-items-center rounded-pc-md border-2 border-dashed border-pc-interactive bg-pc-interactive/90 p-3 text-center text-sm font-bold text-pc-action-foreground"
        >
          {t(drop.label)}
        </div>
      )}
    </article>
  );
}

function discoverCardLabels(
  t: TFunction<"browsing">,
  group: GameGroup,
  title: string,
  {
    first,
    status,
    exact,
    firstProject,
    projectLabel,
    state,
  }: Pick<
    ReturnType<typeof discoverCardIdentity>,
    "first" | "status" | "exact" | "firstProject" | "projectLabel"
  > & { state: string },
) {
  if (!exact) {
    return {
      card: t("discover.groupLabel", {
        title,
        count: group.ports.length,
        matching: group.matchingPorts.length,
      }),
      identity: undefined,
    };
  }
  const action = memberLabel(t, first, status);
  return {
    card: t("discover.cardLabel", {
      game: firstProject.trim() === title.trim() ? title : `${title} · ${firstProject}`,
      state,
    }),
    identity:
      group.ports.length > 1
        ? t("discover.identity.matching", {
            title,
            project: projectLabel ?? "",
            port: firstProject,
            state,
            action,
          })
        : t("discover.identity.single", {
            identity: projectLabel ? `${title} ${projectLabel}` : title,
            state,
            action,
          }),
  };
}

function discoverCardDrop(
  group: GameGroup,
  exactChoice: CatalogEntry | undefined,
  statuses: ReadonlyMap<string, PortStatus>,
  drag: NativeSourceDragState,
):
  | {
      gameId?: string;
      portId?: string;
      profileId?: string;
      targeted: boolean;
      label: "discover.drop.review" | "discover.drop.release" | "discover.drop.hover";
    }
  | undefined {
  if (!drag.active) return undefined;
  // A device-based click shortcut does not choose where dropped originals belong.
  if (
    exactChoice?.source_profile &&
    sourceDropEligible(exactChoice, statuses.get(exactChoice.id), drag)
  ) {
    const targeted = drag.targetPortId === exactChoice.id;
    return {
      portId: exactChoice.id,
      profileId: exactChoice.source_profile,
      targeted,
      label: targeted ? "discover.drop.release" : "discover.drop.hover",
    };
  }
  if (group.ports.some((port) => sourceDropEligible(port, statuses.get(port.id), drag))) {
    return {
      gameId: group.id,
      targeted: drag.targetGameId === group.id,
      label: "discover.drop.review",
    };
  }
  return undefined;
}

function DiscoverGameMetadata({
  t,
  port,
  status,
  exact,
  devicePlatform,
  artworkNotice,
}: {
  t: TFunction<"browsing">;
  port: CatalogEntry;
  status: PortStatus | undefined;
  exact: boolean;
  devicePlatform: PortDefinition["platforms"][number] | undefined;
  artworkNotice: ReturnType<typeof artworkDisplayNotice>;
}) {
  return (
    <div className="discover-game-metadata grid content-start gap-2">
      {artworkNotice && <p className="text-xs text-pc-muted-foreground">{artworkNotice}</p>}
      {/* Most catalog ports offer only Stable; that chip does not help choose a game.
          Preview, Rolling, mixed channels and a differing selected channel stay visible. */}
      {/* On a known device, platform chips repeat on every card; show only the
          exception. Without a known device, the platforms stay listed. */}
      {exact && (
        <IdentityChipsContent
          t={t}
          port={{
            ...port,
            ...(devicePlatform ? { platforms: [] } : {}),
            ...(port.channels?.length === 1 &&
            port.channels[0] === "stable" &&
            (!status?.channel || status.channel === "stable")
              ? { channels: [] }
              : {}),
          }}
        />
      )}
      {exact &&
        devicePlatform &&
        availablePlatforms(port).length > 0 &&
        !availablePlatforms(port).includes(devicePlatform) && (
          <p className="m-0 text-xs text-pc-muted-foreground">
            {t("discover.unavailableFor", { platform: platformLabel(devicePlatform) })}
          </p>
        )}
    </div>
  );
}

function discoverCardIdentity(
  t: TFunction<"browsing">,
  group: GameGroup,
  statuses: ReadonlyMap<string, PortStatus>,
  organization: Organization | undefined,
  devicePlatform: PortDefinition["platforms"][number] | undefined,
) {
  const choice = resolveGameChoice(
    group,
    statuses,
    organization?.snapshot ? (organization.snapshot.preferred_port_by_game ?? {}) : undefined,
  );
  const platformMatch =
    devicePlatform && group.matchingPorts.every((port) => availablePlatforms(port).length > 0)
      ? group.matchingPorts.filter((port) => availablePlatforms(port).includes(devicePlatform))
      : [];
  const chosen =
    choice.port ??
    (choice.reason === "ambiguous" && platformMatch.length === 1 ? platformMatch[0] : undefined);
  const first = chosen ?? group.matchingPorts[0]!;
  const firstProject = gameProjectLabel(first);
  return {
    first,
    chosen,
    dropChosen: choice.port,
    actionGroup: chosen ? { ...group, matchingPorts: [chosen] } : group,
    status: statuses.get(first.id),
    exact: Boolean(chosen) || group.matchingPorts.length === 1,
    firstProject: firstProject ?? first.name,
    projectLabel:
      group.ports.length === 1
        ? firstProject
        : t("discover.separateProjects", { count: group.ports.length }),
  };
}

function DiscoverGameObservation({
  t,
  group,
  first,
  status,
  observation,
  descriptionId,
  firstProject,
  organization,
}: {
  t: TFunction<"browsing">;
  group: GameGroup;
  first: CatalogEntry;
  status: PortStatus | undefined;
  observation: ReturnType<typeof browsePortPresentation>;
  descriptionId: string;
  firstProject: string;
  organization: Organization | undefined;
}) {
  const exact = group.matchingPorts.length === 1;
  return (
    <div className="discover-game-observation grid content-start gap-1">
      {exact ? (
        <>
          {group.ports.length > 1 && (
            <p className="text-xs text-pc-muted-foreground">
              <Trans
                t={t}
                i18nKey="discover.matchingPort"
                components={{ port: <bdi>{firstProject}</bdi> }}
              />
            </p>
          )}
          <BrowsePortObservationsContent
            t={t}
            port={first}
            status={status}
            observation={observation}
            descriptionId={descriptionId}
            noticeChoice={organization?.snapshot?.update_notices[first.id]}
          />
        </>
      ) : (
        <p className="text-xs text-pc-muted-foreground">{t("discover.compareMatching")}</p>
      )}
    </div>
  );
}

function DiscoverGameActions({
  t,
  group,
  onTask,
  statuses,
  first,
  detailOrigin,
  describedBy,
  open,
  compare,
}: Pick<
  Parameters<typeof DiscoverGameCard>[0],
  "group" | "onTask" | "statuses" | "open" | "compare"
> & {
  t: TFunction<"browsing">;
  first: CatalogEntry;
  detailOrigin: string;
  describedBy: string | undefined;
}) {
  const action = presentPortAction(
    useOperationPresentation(),
    first.id,
    statuses.get(first.id),
    "launch",
  );
  const task = group.matchingPorts.length === 1 && action.pending && onTask;
  return (
    <div className="discover-game-actions grid content-start justify-items-start gap-2">
      <Button
        data-focusable
        variant="outline"
        size="sm"
        className="discover-card-action"
        data-detail-origin={`${detailOrigin}:details`}
        aria-describedby={describedBy}
        onClick={(event) =>
          task
            ? onTask?.(action.pending?.context.activityId)
            : group.matchingPorts.length === 1
              ? open(first, `${detailOrigin}:details`)
              : compare(group, event.currentTarget)
        }
      >
        {task
          ? t("discover.action.task")
          : group.matchingPorts.length === 1
            ? memberLabel(t, first, statuses.get(first.id))
            : t("discover.action.compare")}
        <ArrowRight aria-hidden="true" />
      </Button>
      {group.ports.length === 1 && (
        <Button
          data-focusable
          variant="ghost"
          size="sm"
          data-collection-control="compare-evidence"
          onClick={(event) => compare(group, event.currentTarget)}
        >
          {t("discover.action.why")}
        </Button>
      )}
      {group.ports.length > 1 && group.matchingPorts.length === 1 && (
        <Button
          data-focusable
          size="sm"
          variant="ghost"
          data-collection-control="compare-all"
          onClick={(event) => compare(group, event.currentTarget)}
        >
          <GitCompareArrows aria-hidden="true" />
          {t("discover.action.compareAll", { total: group.ports.length })}
        </Button>
      )}
    </div>
  );
}

function sourceDropEligible(
  port: CatalogEntry,
  status: PortStatus | undefined,
  drag: NativeSourceDragState,
) {
  return (
    drag.active &&
    Boolean(port.source_profile) &&
    !status?.external_runtime?.user_selected &&
    !port.pendingSetup
  );
}

function memberLabel(t: TFunction<"browsing">, port: CatalogEntry, status: PortStatus | undefined) {
  return port.pendingSetup
    ? t("discover.action.continue")
    : status?.active || status?.external_runtime
      ? t("discover.action.installation")
      : t("discover.action.port");
}
