import type { OutputLocalModPackagePlan } from "../transport-types.generated";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import {
  onStandingSetupPass,
  requestStandingSetup,
} from "../features/game-file-discovery/use-standing-setup";
import { readModSetupInventory } from "../features/mod-setups/read-mod-setup-inventory";
import { pickModPackagePath } from "../file-picker";
import { useAppTranslation } from "../localization";
import type { LiveMods, ModSetupView, ModSetupsView } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ModSetupOriginalControl } from "./ModSetupOriginalControl";
import { ModFilePreservationControl } from "./ModFilePreservationControl";
import { ChoiceSelect } from "./ChoiceSelect";
import { ExternalLink } from "./ExternalLink";
import {
  changeModEdit,
  draftHasRoom,
  draftSize,
  emptyModDraft,
  MOD_SETUP_CAPACITY,
  useModDraft,
  type LocalModSelection,
  type ModDraft,
} from "../features/mod-setups/mod-draft";
import { ModProviderBrowser, providerName, type ModDraftReviewState } from "./ModProviderBrowser";
import { ModRecipeControl } from "./ModRecipeControl";
import { CreateCleanModSetup } from "./CreateCleanModSetup";
import { ModSetupRecovery } from "./ModSetupRecovery";
import { ModSetupRuntimeRetirement } from "./ModSetupRuntimeRetirement";
import { ActionRow, Notice } from "./ui/patterns";

export type ModPlayState = {
  port: string;
  generation: number;
  name: string;
  pending: number;
  busy: boolean;
  review: ModDraftReviewState | undefined;
};

type Props = {
  portId: string;
  generation: number;
  busy: boolean;
  libraryRoot?: string | undefined;
  active?: boolean;
  onPlayState?: (state: ModPlayState | undefined) => void;
  reviewFromPlay?: number;
  onAppliedFromPlay?: () => void;
  openGameFiles?: (() => void) | undefined;
};

/** Thin view of Core-owned mod setups; Core decides support, locks and recovery. */
export function GithubModHandoff({
  view,
}: {
  view: Pick<ModSetupsView, "github_release_url" | "github_native_import_offered">;
}) {
  const { t } = useAppTranslation("gameSettings");
  if (!view.github_release_url) return null;
  return (
    <aside className="grid gap-1">
      <ExternalLink href={view.github_release_url}>{t("mods.github.browse")}</ExternalLink>
      <p className="text-sm text-pc-muted-foreground">
        {view.github_native_import_offered ? t("mods.github.setup") : t("mods.github.platform")}
      </p>
    </aside>
  );
}

export function ModSetupsControl(props: Props) {
  return (
    <BoundModSetupsControl key={JSON.stringify([props.portId, props.generation])} {...props} />
  );
}

function nativeListMessage(
  t: TFunction<"gameSettings">,
  live: LiveMods | null | undefined,
): ReactNode {
  const status = live?.native_list;
  switch (status?.state) {
    case "not-written":
      return t("mods.native.notWritten");
    case "reordered":
      return (
        <Trans
          t={t}
          i18nKey="mods.native.reordered"
          components={{ order: <bdi>{status.native_order.join(t("mods.separator"))}</bdi> }}
        />
      );
    case "differs":
      return t("mods.native.differs");
    case "unreadable":
      return t("mods.native.unreadable");
    default:
      return undefined;
  }
}

function useModSetupInventory(portId: string, generation: number, busy: boolean) {
  const { t } = useAppTranslation("gameSettings");
  const [view, setView] = useState<ModSetupsView>();
  // The app-owned mismatch is a code translated at render; Core failure text stays verbatim.
  const [failure, setFailure] = useState<
    "gameChanged" | { text: string; cleanSetupKey?: string | undefined }
  >();
  const error =
    failure === "gameChanged" ? t("mods.gameChanged") : failure ? failure.text : undefined;
  const [outcome, setOutcome] = useState<string>();
  const [working, setWorking] = useState(false);
  const [request, setRequest] = useState(0);
  const applyingProviderDraft = useRef(false);
  // False from a change until the view is read again, so no control acts on a
  // revision the change has replaced.
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    if (busy) return;
    const read = { current: true };
    void readModSetupInventory(portId, generation).then(
      (next) => {
        if (!read.current || applyingProviderDraft.current) return;
        if (next.port_id !== portId) {
          setFailure("gameChanged");
          return;
        }
        setView(next);
        setFresh(true);
      },
      (failure: unknown) => {
        if (read.current && !applyingProviderDraft.current)
          setFailure({ text: errorText(failure) });
      },
    );
    return () => {
      read.current = false;
    };
  }, [portId, generation, busy, request]);

  useEffect(() => {
    if (busy) return;
    return onStandingSetupPass(() => setRequest((value) => value + 1));
  }, [busy]);

  const reread = () => {
    setFailure(undefined);
    setRequest((value) => value + 1);
  };
  // Each change is checked again by Core under its lock; the result is re-read
  // rather than assumed.
  const perform = async (
    action: () => Promise<unknown>,
    success: string,
    cleanSetupKey?: string,
  ) => {
    setWorking(true);
    setOutcome(undefined);
    setFailure(undefined);
    let succeeded = false;
    try {
      await action();
      setOutcome(success);
      succeeded = true;
      requestStandingSetup();
    } catch (failure) {
      setFailure({ text: errorText(failure), cleanSetupKey });
    } finally {
      setWorking(false);
      setFresh(false);
      setRequest((value) => value + 1);
    }
    return succeeded;
  };

  const refreshAfterProviderInstall = (message: string) => {
    setOutcome(message);
    setFresh(false);
    requestStandingSetup();
    setRequest((value) => value + 1);
  };
  const setProviderDraftApplying = useCallback((applying: boolean) => {
    applyingProviderDraft.current = applying;
  }, []);
  return {
    view,
    error,
    failedCleanSetupKey: typeof failure === "object" ? failure.cleanSetupKey : undefined,
    outcome,
    working,
    fresh,
    reread,
    perform,
    setWorking,
    setOutcome,
    setFailure,
    refreshAfterProviderInstall,
    setProviderDraftApplying,
  };
}

function BoundModSetupsControl({
  portId,
  generation,
  libraryRoot,
  active = true,
  busy,
  openGameFiles,
  onPlayState,
  reviewFromPlay,
  onAppliedFromPlay,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const {
    view,
    error,
    failedCleanSetupKey,
    outcome,
    working,
    fresh,
    reread,
    perform,
    setWorking,
    setOutcome,
    setFailure,
    refreshAfterProviderInstall,
    setProviderDraftApplying,
  } = useModSetupInventory(portId, generation, busy);
  const [browseSelected, selectBrowse] = useState<boolean>();
  const [browserBusy, setBrowserBusy] = useState(false);
  const [draftReview, setDraftReview] = useState<ModDraftReviewState>();
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [copyName, setCopyName] = useState("");
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [localReview, setLocalReview] = useState<{
    path: string;
    review: OutputLocalModPackagePlan;
  }>();
  const setupHeading = useRef<HTMLHeadingElement>(null);
  const focusDisplacedCleanSetupError = useCallback((notice: HTMLElement | null) => {
    if (notice && document.activeElement === document.body) notice.focus();
  }, []);
  const addFile = useRef<HTMLButtonElement>(null);
  const restoreAddFileFocus = useRef(false);
  useLayoutEffect(() => {
    if (localReview || !restoreAddFileFocus.current) return;
    restoreAddFileFocus.current = false;
    addFile.current?.focus();
  }, [localReview]);
  const copyId = useId();
  const headingId = useId();
  // A picker answer that arrives after this view was replaced is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const sources = view?.providers?.length ? view.providers : view?.provider ? [view.provider] : [];
  const setup = view ? currentModSetup(view) : undefined;
  const [draft, setDraft, olderDraft, updateOlder] = useModDraft({
    library: libraryRoot,
    port: portId,
    setup: setup?.selected?.profile.id,
    revision: setup?.selected?.profile.current_revision,
    appliedRevision:
      setup?.selected &&
      view?.live?.profile_id === setup.selected.profile.id &&
      view.live.revision === setup.selected.revision.revision
        ? { revision: setup.selected.revision.revision, digest: setup.selected.revision.digest }
        : undefined,
  });
  const localFiles = (draft.localFiles ?? []).filter(
    ({ review }) =>
      review.profile_id === setup?.selected?.profile.id &&
      review.expected_revision === setup?.selected?.profile.current_revision,
  );
  const undoLocal = (digest: string) =>
    setDraft((current) => ({
      ...current,
      localFiles: (current.localFiles ?? []).filter(({ review }) => review.plan_sha256 !== digest),
    }));
  const recoverable =
    (olderDraft?.selections.receipt ? undefined : olderDraft?.selections.additions)?.filter(
      (entry) =>
        sources.includes(entry.provider) &&
        !setup?.selected?.revision.packages?.some(
          ({ provider }) =>
            provider?.provider === entry.provider &&
            provider.project === entry.project &&
            provider.file === entry.file,
        ) &&
        !draft.additions.some(
          (other) => entry.provider === other.provider && entry.project === other.project,
        ),
    ) ?? [];
  const appliedName = setup?.selected?.profile.display_name;
  const pendingCount = draftSize(draft);
  useEffect(() => {
    onPlayState?.(
      appliedName
        ? {
            port: portId,
            generation,
            name: appliedName,
            pending: pendingCount,
            busy: browserBusy || working,
            review: draftReview,
          }
        : undefined,
    );
  }, [
    appliedName,
    pendingCount,
    browserBusy,
    working,
    draftReview,
    onPlayState,
    portId,
    generation,
  ]);
  if (!view && error)
    return (
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className="text-base font-semibold">
          {t("mods.heading")}
        </h3>
        <p role="alert">{error}</p>
        <Button variant="outline" onClick={reread}>
          {t("mods.reread")}
        </Button>
      </section>
    );
  const upstreamMods = view?.github_release_url && <GithubModHandoff view={view} />;
  if (!view?.supported) return upstreamMods || null;
  // The provider browser's work or open review locks every other change, so a
  // review always lands on the setup and revision it was made for.
  const locked = busy || working || !fresh || browserBusy || recipeBusy;
  const { setups, selected, heldUpdates, onOtherBuild, blocked } = setup!;
  const materializing = Boolean(
    selected &&
    view.live?.revision != null &&
    view.live.revision < selected.profile.current_revision,
  );
  const browsing = Boolean(sources.length && (browseSelected ?? true));
  const applicableReview =
    selected &&
    localReview?.review.profile_id === selected.profile.id &&
    localReview.review.expected_revision === selected.profile.current_revision
      ? localReview
      : undefined;
  if (localReview && !applicableReview) setLocalReview(undefined);
  const changing = locked || Boolean(applicableReview);
  const hasAvailableCleanSetup = setups.some(
    (entry) =>
      setupRuntimeAvailable(entry) &&
      (entry.revision.packages ?? []).every((item) => !item.enabled),
  );
  const cleanSetupKey =
    !hasAvailableCleanSetup && selected && setupRuntimeAvailable(selected)
      ? JSON.stringify(["clean", selected.profile.id, selected.profile.current_revision])
      : undefined;
  const nativeMessage = nativeListMessage(t, view.live);
  const defaultInstallId = setups.find((entry) => entry.profile.is_default)?.revision.build
    ?.install_id;
  const staleDefault = Boolean(
    defaultInstallId && view.current_install_id && defaultInstallId !== view.current_install_id,
  );

  return (
    <section aria-labelledby={headingId} className="mod-workspace grid min-w-0 gap-3" inert={busy}>
      <h3
        ref={setupHeading}
        id={headingId}
        tabIndex={-1}
        className="scroll-mt-2 text-base font-semibold"
      >
        {t("mods.heading")}
      </h3>
      <p className="text-sm text-pc-muted-foreground">{t("mods.intro")}</p>
      {upstreamMods}
      <ModSetupFeedback
        error={failedCleanSetupKey ? undefined : error}
        fresh={fresh}
        working={working}
        outcome={outcome}
        reread={reread}
      />
      {failedCleanSetupKey && failedCleanSetupKey !== cleanSetupKey && (
        <Notice
          ref={focusDisplacedCleanSetupError}
          role="alert"
          dir="auto"
          tabIndex={-1}
          className="[overflow-wrap:anywhere]"
        >
          {error}
        </Notice>
      )}
      {setups.length === 0 ? (
        <ActionRow>
          <p className="text-sm">{t("mods.none")}</p>
          <Button
            variant="outline"
            disabled={changing}
            onClick={() =>
              void perform(
                () => desktopApi.createDefaultModSetup(portId, generation),
                t("mods.outcome.createdFirst"),
              )
            }
          >
            {t("mods.createFirst")}
          </Button>
        </ActionRow>
      ) : (
        <>
          {view.live && (
            <ModFilePreservationControl
              portId={portId}
              generation={generation}
              live={view.live}
              disabled={changing}
              setupHeading={setupHeading}
              setWorking={setWorking}
              perform={perform}
            />
          )}
          <ModSetupNotices
            nativeMessage={nativeMessage}
            browserBusy={browserBusy}
            provider={view.provider}
            heldUpdates={heldUpdates}
          />
          {staleDefault && (
            <Notice intent="warning">
              <div data-slot="notice-body">
                <p>{t("mods.defaultRefreshRequired")}</p>
                <Button
                  variant="outline"
                  disabled={changing}
                  onClick={() =>
                    void perform(
                      () => desktopApi.createDefaultModSetup(portId, generation),
                      t("mods.outcome.refreshedDefault"),
                    )
                  }
                >
                  {t("mods.refreshDefault")}
                </Button>
              </div>
            </Notice>
          )}
          {selected &&
            view.live?.revision != null &&
            view.live.revision < selected.profile.current_revision && (
              <Notice intent="warning">
                <div data-slot="notice-body">
                  <p>{t("mods.recovery.pending")}</p>
                  <Button
                    variant="outline"
                    disabled={changing}
                    onClick={() =>
                      void perform(
                        () => desktopApi.useModSetup(portId, selected.profile.id, generation),
                        t("mods.recovery.finished"),
                      )
                    }
                  >
                    {t("mods.recovery.finish", { name: selected.profile.display_name })}
                  </Button>
                </div>
              </Notice>
            )}
          {selected && (
            <div className="mod-workspace-bar flex flex-wrap items-center gap-2">
              <div role="group" aria-label={t("mods.heading")} className="mod-workspace-views">
                {sources.length > 0 && (
                  <Button
                    variant={browsing ? "selected" : "ghost"}
                    aria-pressed={browsing}
                    onClick={() => selectBrowse(true)}
                  >
                    {t("mods.workspace.browse")}
                  </Button>
                )}
                <Button
                  variant={!browsing ? "selected" : "ghost"}
                  aria-pressed={!browsing}
                  onClick={() => selectBrowse(false)}
                >
                  {t("mods.workspace.installedCount", {
                    count: view.applied_package_count ?? selected.revision.packages?.length ?? 0,
                  })}
                </Button>
              </div>
              <div className="mod-setup-select max-w-full min-w-0">
                <ChoiceSelect
                  inline
                  label={t("mods.workspace.setup")}
                  value={selected.profile.id}
                  disabled={changing || blocked}
                  options={setups
                    .filter(
                      (entry) =>
                        setupRuntimeAvailable(entry) || entry.profile.id === selected.profile.id,
                    )
                    .map((entry) => ({
                      value: entry.profile.id,
                      label: entry.profile.display_name,
                    }))}
                  onChange={(next) => {
                    const entry = setups.find(({ profile }) => profile.id === next);
                    if (!entry) return;
                    void perform(
                      () => desktopApi.useModSetup(portId, next, generation),
                      t("mods.outcome.using", { name: entry.profile.display_name }),
                    );
                  }}
                />
              </div>
            </div>
          )}
          <details hidden={browsing || browserBusy}>
            <summary className="cursor-pointer text-sm">{t("mods.setups")}</summary>
            <ul aria-label={t("mods.setups")} className="mt-2 grid list-none gap-2 p-0">
              {setups.map((entry) => (
                <SetupRow
                  key={entry.profile.id}
                  entry={entry}
                  inUse={entry.profile.id === selected?.profile.id}
                  disabled={changing || blocked}
                  onUse={() =>
                    void perform(
                      () => desktopApi.useModSetup(portId, entry.profile.id, generation),
                      t("mods.outcome.using", { name: entry.profile.display_name }),
                    )
                  }
                />
              ))}
            </ul>
          </details>
          {selected && olderDraft && (
            <Notice intent="warning">
              <div data-slot="notice-body" className="grid gap-2">
                <p>{t("mods.workspace.olderDraft", { revision: olderDraft.base })}</p>
                <ul className="list-disc ps-5">
                  {olderDraft.selections.additions.map((item) => (
                    <li key={JSON.stringify([item.provider, item.project])}>
                      <bdi>{item.name}</bdi>
                    </li>
                  ))}
                  {olderDraft.selections.packages.map((item) => (
                    <li key={item.native_id}>
                      <bdi>{item.native_id}</bdi>
                    </li>
                  ))}
                  {olderDraft.selections.localFiles?.map(({ review }) => (
                    <li key={review.plan_sha256}>
                      <bdi>{review.native_id}</bdi>
                    </li>
                  ))}
                  {olderDraft.selections.order && <li>{t("mods.workspace.pendingOrder")}</li>}
                </ul>
                <ActionRow>
                  {recoverable.length > 0 && (
                    <Button
                      variant="outline"
                      disabled={
                        changing ||
                        !draftHasRoom(
                          draft.additions.length + localFiles.length,
                          recoverable.length,
                        )
                      }
                      onClick={() => {
                        const saved = setDraft((current) => ({
                          ...current,
                          additions: [...current.additions, ...recoverable],
                        }));
                        if (!saved) return;
                        updateOlder({
                          ...olderDraft.selections,
                          additions: olderDraft.selections.additions.filter(
                            (entry) => !recoverable.includes(entry),
                          ),
                        });
                      }}
                    >
                      {t("mods.workspace.recoverAdditions")}
                    </Button>
                  )}
                  <Button variant="ghost" disabled={changing} onClick={() => updateOlder()}>
                    {t("mods.workspace.discardOlder")}
                  </Button>
                </ActionRow>
              </div>
            </Notice>
          )}
          {selected && (
            <ModProviderBrowser
              portId={portId}
              sources={sources}
              generation={generation}
              selected={selected}
              active={active && !busy}
              browsing={browsing}
              onBrowse={() => selectBrowse(true)}
              onBusyChange={setBrowserBusy}
              onReviewChange={setDraftReview}
              draft={draft}
              localFiles={localFiles}
              undoLocal={undoLocal}
              setDraft={setDraft}
              disabled={
                busy ||
                working ||
                !fresh ||
                blocked ||
                materializing ||
                recipeBusy ||
                Boolean(applicableReview)
              }
              updates={{
                policy: selected.profile.intent?.update_policy ?? "review_updates",
                automaticChecks: (view.last_automatic_checks ?? []).filter(
                  (check) => check.profile_id === selected.profile.id,
                ),
                automaticChecksIncomplete: view.last_automatic_checks_incomplete ?? false,
                setPolicy: (policy) =>
                  void perform(
                    () =>
                      desktopApi.setModUpdatePolicy(
                        portId,
                        selected.profile.id,
                        policy,
                        generation,
                      ),
                    t("mods.updates.policySaved"),
                  ),
              }}
              onInstalled={refreshAfterProviderInstall}
              onRefresh={reread}
              onApplying={setProviderDraftApplying}
              reviewFromPlay={reviewFromPlay}
              onAppliedFromPlay={onAppliedFromPlay}
            />
          )}
          {selected && (
            <section
              aria-label={t("mods.modsIn", { name: selected.profile.display_name })}
              className={browsing || browserBusy ? "hidden" : "grid gap-2"}
            >
              <h4 className="text-sm font-semibold">
                <Trans
                  t={t}
                  i18nKey="mods.modsInHeading"
                  components={{ name: <bdi>{selected.profile.display_name}</bdi> }}
                />
              </h4>
              {!selected.profile.is_default &&
                selected.originals.map((original) => (
                  <ModSetupOriginalControl
                    key={JSON.stringify([
                      selected.profile.id,
                      selected.profile.current_revision,
                      original.binding.requirement_id,
                    ])}
                    target={{
                      portId,
                      generation,
                      profileId: selected.profile.id,
                      expectedRevision: selected.profile.current_revision,
                      requirementId: original.binding.requirement_id,
                    }}
                    original={original}
                    disabled={changing}
                    perform={perform}
                    setWorking={setWorking}
                    focusReturn={setupHeading}
                  />
                ))}
              <ModSetupPackages
                key={selected.profile.id}
                selected={selected}
                draft={draft}
                localFiles={localFiles}
                orderSupported={
                  view.later_mods_take_priority ||
                  Boolean(
                    selected.revision.loader &&
                    selected.revision.orderings?.some((item) => item.domain === "asset-override"),
                  )
                }
                disabled={changing || blocked}
                queueEdit={(native_id, enabled) =>
                  setDraft((current) => changeModEdit(current, [native_id], enabled))
                }
                setOrder={(order) => setDraft((current) => ({ ...current, order }))}
              />
              {selected.profile.current_revision > 1 && (
                <ModSetupRecovery
                  key={JSON.stringify([
                    "recovery",
                    selected.profile.id,
                    selected.profile.current_revision,
                    historyEpoch,
                  ])}
                  portId={portId}
                  profileId={selected.profile.id}
                  currentRevision={selected.profile.current_revision}
                  generation={generation}
                  locked={changing}
                  blocked={blocked}
                  perform={perform}
                  pendingCount={pendingCount}
                  onRestored={() => {
                    setDraft(emptyModDraft);
                  }}
                />
              )}
              {selected.profile.current_revision > 1 && (
                <ModSetupRuntimeRetirement
                  key={JSON.stringify([selected.profile.id, selected.profile.current_revision])}
                  portId={portId}
                  profileId={selected.profile.id}
                  generation={generation}
                  locked={changing}
                  onRetired={() => setHistoryEpoch((epoch) => epoch + 1)}
                />
              )}
              <p className="text-sm text-pc-muted-foreground">
                {view.later_mods_take_priority ? t("mods.laterPriority") : t("mods.loadOrder")}
              </p>
              <ActionRow>
                <Button
                  ref={addFile}
                  variant="outline"
                  disabled={changing || blocked}
                  onClick={() =>
                    void reviewSelectedModPackage({
                      portId,
                      generation,
                      packageTypes: view.package_types,
                      selected,
                      alive,
                      setWorking,
                      setFailure,
                      setOutcome,
                      setLocalReview,
                    })
                  }
                >
                  {t("mods.add")}
                </Button>
              </ActionRow>
              {applicableReview && (
                <LocalModPackageReview
                  review={applicableReview.review}
                  locked={locked || blocked}
                  add={() => {
                    if (!draftHasRoom(localFiles.length + draft.additions.length)) {
                      setFailure({
                        text: t("mods.workspace.draftLimit", { limit: MOD_SETUP_CAPACITY }),
                      });
                      return;
                    }
                    const { path, review } = applicableReview;
                    const {
                      native_id,
                      profile_id,
                      expected_revision,
                      plan_sha256,
                      sha256,
                      needs_code_permission,
                    } = review;
                    setDraft((current) => ({
                      ...current,
                      localFiles: [
                        ...(current.localFiles ?? []).filter(
                          (entry) => entry.review.native_id !== native_id,
                        ),
                        {
                          path,
                          review: {
                            native_id,
                            profile_id,
                            expected_revision,
                            plan_sha256,
                            sha256,
                            needs_code_permission,
                          },
                        },
                      ],
                    }));
                    setLocalReview(undefined);
                    setupHeading.current?.focus();
                  }}
                  cancel={() => {
                    restoreAddFileFocus.current = true;
                    setLocalReview(undefined);
                  }}
                />
              )}
              {onOtherBuild && (
                <Notice intent="info">
                  <div data-slot="notice-body">
                    <p>{t("mods.otherBuild")}</p>
                  </div>
                </Notice>
              )}
              {cleanSetupKey && (
                <CreateCleanModSetup
                  key={cleanSetupKey}
                  runtime={selected.revision.build.artifact.asset_name}
                  locked={locked}
                  working={working}
                  error={failedCleanSetupKey === cleanSetupKey ? error : undefined}
                  onDismiss={() => {
                    if (failedCleanSetupKey === cleanSetupKey) setFailure(undefined);
                  }}
                  create={(name) =>
                    perform(
                      () =>
                        desktopApi.createCleanModSetup(
                          portId,
                          selected.profile.id,
                          name,
                          selected.profile.current_revision,
                          generation,
                        ),
                      t("mods.clean.created", { name }),
                      cleanSetupKey,
                    )
                  }
                  onCreated={() => setupHeading.current?.focus()}
                />
              )}
              <CopyModSetup
                key={selected.revision.digest}
                copyId={copyId}
                copyName={copyName}
                setCopyName={setCopyName}
                locked={locked}
                onOtherBuild={onOtherBuild}
                canCopyProgress={view.progress_copy_supported ?? false}
                copy={(name, currentBuild, copyProgress) => {
                  const targetInstallId = currentBuild
                    ? view.current_install_id
                    : selected.revision.build.install_id;
                  if (!targetInstallId) return Promise.resolve(false);
                  const targetRevision = currentBuild
                    ? view.inventory?.profiles.find((entry) => entry.profile.is_default)?.revision
                    : selected.revision;
                  return perform(
                    () =>
                      desktopApi.copyModSetup(
                        portId,
                        selected.profile.id,
                        name,
                        generation,
                        currentBuild,
                        copyProgress
                          ? {
                              source_revision_sha256: selected.revision.digest,
                              target_install_id: targetInstallId,
                              target_revision_sha256: targetRevision?.digest ?? "",
                            }
                          : undefined,
                      ),
                    copyProgress
                      ? t("mods.outcome.copiedProgress", { name })
                      : currentBuild
                        ? t("mods.outcome.copiedCurrent", { name })
                        : t("mods.outcome.copied", { name }),
                  );
                }}
              />
            </section>
          )}
        </>
      )}
      <div hidden={browsing || browserBusy}>
        <ModRecipeControl
          openGameFiles={openGameFiles}
          portId={portId}
          profileId={selected?.profile.id}
          generation={generation}
          disabled={changing}
          onBusyChange={setRecipeBusy}
          onImported={refreshAfterProviderInstall}
        />
      </div>
    </section>
  );
}

function LocalModPackageReview({
  review,
  locked,
  add,
  cancel,
}: {
  review: OutputLocalModPackagePlan;
  locked: boolean;
  add: () => void;
  cancel: () => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const heading = useRef<HTMLHeadingElement>(null);
  const title = useId();
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section aria-labelledby={title} className="grid gap-2 text-sm">
      <h4 ref={heading} id={title} tabIndex={-1} className="font-semibold">
        <Trans
          t={t}
          i18nKey="mods.local.review"
          components={{ file: <bdi>{review.native_id}</bdi> }}
        />
      </h4>
      {review.asset_count > 0 && <p>{t("mods.local.asset", { count: review.asset_count })}</p>}
      {review.replaces.length > 0 && (
        <p>
          {t("mods.local.replaces")} <bdi>{review.replaces.join(", ")}</bdi>
        </p>
      )}
      {!review.replaces_enabled && <p>{t("mods.local.staysOff")}</p>}
      {review.overlapping_mods.length > 0 && (
        <p>
          {t("mods.local.overlap")} <bdi>{review.overlapping_mods.join(", ")}</bdi>
        </p>
      )}
      {review.conflicts_truncated && <p>{t("mods.local.incomplete")}</p>}
      {review.required_mods.length > 0 && (
        <p>
          {t("mods.local.requires")} <bdi>{review.required_mods.join(", ")}</bdi>
        </p>
      )}
      {review.missing_required_mods.length > 0 && (
        <p role="status">
          {t("mods.local.missing")} <bdi>{review.missing_required_mods.join(", ")}</bdi>
        </p>
      )}
      {review.needs_code_permission && (
        <Notice intent="warning">
          <div data-slot="notice-body" className="grid gap-1">
            <p>{t("mods.local.code")}</p>
            <p>{t("mods.code.runs")}</p>
            <p className="[overflow-wrap:anywhere]">
              <Trans
                t={t}
                i18nKey="mods.code.digest"
                components={{ digest: <code dir="ltr">{review.sha256}</code> }}
              />
            </p>
          </div>
        </Notice>
      )}
      <ActionRow>
        <Button disabled={locked} onClick={add}>
          {t("mods.workspace.queueLocal")}
        </Button>
        <Button variant="outline" onClick={cancel}>
          {t("mods.code.cancel")}
        </Button>
      </ActionRow>
    </section>
  );
}

function ModSetupFeedback({
  error,
  fresh,
  working,
  outcome,
  reread,
}: {
  error: string | undefined;
  fresh: boolean;
  working: boolean;
  outcome: string | undefined;
  reread: () => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  return (
    <>
      {error && (
        <p role="alert" className="wrap-anywhere">
          {error}
        </p>
      )}
      {error && !fresh && !working && (
        <ActionRow>
          <Button variant="outline" onClick={reread}>
            {t("mods.reread")}
          </Button>
        </ActionRow>
      )}
      {outcome && <p role="status">{outcome}</p>}
    </>
  );
}

async function reviewSelectedModPackage({
  portId,
  generation,
  packageTypes,
  selected,
  alive,
  setWorking,
  setFailure,
  setOutcome,
  setLocalReview,
}: {
  portId: string;
  generation: number;
  packageTypes: ModSetupsView["package_types"];
  selected: ModSetupView;
  alive: { current: boolean };
  setWorking: (working: boolean) => void;
  setFailure: (failure: { text: string } | undefined) => void;
  setOutcome: (outcome: string | undefined) => void;
  setLocalReview: (review: { path: string; review: OutputLocalModPackagePlan }) => void;
}) {
  setWorking(true);
  try {
    const path = await pickModPackagePath(packageTypes);
    if (typeof path !== "string" || !alive.current) return;
    setFailure(undefined);
    setOutcome(undefined);
    const review = await desktopApi.planLocalModPackage(
      portId,
      selected.profile.id,
      path,
      selected.profile.current_revision,
      generation,
      true,
    );
    if (alive.current) setLocalReview({ path, review });
  } catch (failure) {
    if (alive.current) setFailure({ text: errorText(failure) });
  } finally {
    if (alive.current) setWorking(false);
  }
}

function ModSetupNotices({
  nativeMessage,
  browserBusy,
  provider,
  heldUpdates,
}: {
  nativeMessage: ReactNode;
  browserBusy: boolean;
  provider: ModSetupsView["provider"];
  heldUpdates: NonNullable<ModSetupsView["held_updates"]>;
}) {
  const { t } = useAppTranslation("gameSettings");
  return (
    <>
      {nativeMessage && <p className="text-sm">{nativeMessage}</p>}
      {browserBusy && (
        <p className="text-sm">
          {t("mods.browse.lockNote", { provider: providerName(provider ?? "") })}
        </p>
      )}
      {heldUpdates.length > 0 && (
        <Notice intent="info">
          <div data-slot="notice-body">
            <p>{t("mods.held.intro", { count: heldUpdates.length })}</p>
            <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
              {heldUpdates.map((held) => (
                <li key={`${held.project_id}-${held.candidate_file_id}`}>
                  <Trans
                    t={t}
                    i18nKey="mods.held.item"
                    components={{
                      mods: <bdi>{held.native_ids.join(t("mods.separator"))}</bdi>,
                      reason: <bdi>{held.reason}</bdi>,
                    }}
                  />
                </li>
              ))}
            </ul>
            <p>
              {t("mods.held.next", {
                count: heldUpdates.length,
                provider: providerName(provider ?? ""),
              })}
            </p>
          </div>
        </Notice>
      )}
    </>
  );
}

function CopyModSetup({
  copyId,
  copyName,
  setCopyName,
  locked,
  onOtherBuild,
  canCopyProgress,
  copy,
}: {
  copyId: string;
  copyName: string;
  setCopyName: (name: string) => void;
  locked: boolean;
  onOtherBuild: boolean;
  canCopyProgress: boolean;
  copy: (name: string, currentBuild: boolean, copyProgress: boolean) => Promise<boolean>;
}) {
  const { t } = useAppTranslation("gameSettings");
  const progressId = useId();
  const [copyProgress, setCopyProgress] = useState(false);
  const name = copyName.trim();
  const disabled = locked || name === "";
  const submit = (currentBuild: boolean) =>
    void copy(name, currentBuild, canCopyProgress && copyProgress).then((created) => {
      if (created) {
        setCopyName("");
        setCopyProgress(false);
      }
    });
  return (
    <>
      <p className="text-sm text-pc-muted-foreground">{t("mods.copyIntro")}</p>
      {canCopyProgress && (
        <div>
          <label htmlFor={progressId} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={progressId}
              aria-describedby={`${progressId}-description`}
              checked={copyProgress}
              onCheckedChange={(checked) => setCopyProgress(checked === true)}
              disabled={locked}
            />
            {t("mods.copyProgress")}
          </label>
          <p id={`${progressId}-description`} className="text-sm text-pc-muted-foreground">
            {t("mods.copyProgressDescription")}
          </p>
        </div>
      )}
      <ActionRow>
        <label htmlFor={copyId} className="text-sm">
          {t("mods.copyName")}
        </label>
        <Input id={copyId} className="max-w-64" value={copyName} onValueChange={setCopyName} />
        <Button variant="outline" disabled={disabled} onClick={() => submit(false)}>
          {t("mods.copy")}
        </Button>
        {onOtherBuild && (
          <Button variant="outline" disabled={disabled} onClick={() => submit(true)}>
            {t("mods.copyCurrent")}
          </Button>
        )}
      </ActionRow>
    </>
  );
}

function currentModSetup(view: ModSetupsView) {
  const setups = view.inventory?.profiles ?? [];
  const selectedId = view.live?.profile_id ?? undefined;
  const selected = setups.find((entry) => entry.profile.id === selectedId);
  const heldUpdates = (view.held_updates ?? []).filter((held) => held.profile_id === selectedId);
  // The default setup follows the game's current build; any other setup stays
  // on the exact build it was made with, so a different current build (after
  // an update or a rollback) offers a copy on that build instead. The notice
  // describes the revision launches use.
  const onOtherBuild = Boolean(
    selected &&
    !selected.profile.is_default &&
    view.current_install_id &&
    view.live?.revision === selected.revision.revision &&
    selected.revision.build.install_id !== view.current_install_id,
  );
  const blocked = Boolean(
    view.live &&
    (view.live.pending_preservation ||
      view.live.unmanaged.length > 0 ||
      view.live.changed_owned.length > 0),
  );

  return { setups, selectedId, selected, heldUpdates, onOtherBuild, blocked };
}

/** Packages in the setup's priority order: the last one wins when two overlap. */
function ModSetupPackages({
  selected,
  disabled,
  draft,
  localFiles,
  queueEdit,
  setOrder,
  orderSupported,
}: {
  selected: ModSetupView;
  disabled: boolean;
  draft: ModDraft;
  localFiles: LocalModSelection[];
  queueEdit: (nativeId: string, value: boolean | null | undefined) => void;
  setOrder: (order: string[] | null) => void;
  orderSupported: boolean;
}) {
  const { t } = useAppTranslation("gameSettings");
  const [choice, setChoice] = useState<{ nativeId: string; revision: number }>();
  const [editOrder, setEditOrder] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "on" | "off" | "pending">("all");
  const applied = inOverrideOrder(selected);
  const ordered = draft.order ? inOverrideOrder(selected, draft.order) : applied;
  const rank = new Map(applied.map((item, index) => [item.native_id, index]));
  const term = query.trim().toLocaleLowerCase();
  const matches = (name: string) => name.toLocaleLowerCase().includes(term);
  const showAdditions = !editOrder && (filter === "all" || filter === "pending");
  const providerAdditions = showAdditions
    ? draft.additions.filter((item) => matches(item.name) || matches(item.fileName))
    : [];
  const localAdditions = showAdditions
    ? localFiles.filter(({ review }) => matches(review.native_id))
    : [];
  const hasAdditions = draft.additions.length + localFiles.length > 0;
  const visibleAdditions = providerAdditions.length + localAdditions.length > 0;
  const visible = editOrder
    ? ordered
    : ordered.filter((item, index) => {
        if (!matches(item.native_id)) return false;
        if (filter === "on") return item.enabled;
        if (filter === "off") return !item.enabled;
        if (filter === "pending") {
          return (
            index !== rank.get(item.native_id) ||
            draft.packages.some((change) => change.native_id === item.native_id)
          );
        }
        return true;
      });
  const move = (index: number, step: number) => {
    const ids = ordered.map((item) => item.native_id);
    const target = index + step;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setOrder(ids.every((id, position) => id === applied[position]?.native_id) ? null : ids);
  };
  const revision = selected.profile.current_revision;
  const packageArea = useRef<HTMLDivElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <div ref={packageArea} tabIndex={-1}>
      <ActionRow>
        {!editOrder && (
          <Input
            type="search"
            aria-label={t("mods.workspace.searchInstalled")}
            placeholder={t("mods.workspace.searchInstalled")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        )}
        {!editOrder && (ordered.length > 0 || hasAdditions) && (
          <ChoiceSelect
            inline
            label={t("mods.workspace.installation")}
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("mods.workspace.status.all") },
              { value: "on", label: t("mods.workspace.enabledFilter") },
              { value: "off", label: t("mods.workspace.disabledFilter") },
              { value: "pending", label: t("mods.workspace.pendingFilter") },
            ]}
          />
        )}
        {(editOrder || (orderSupported && ordered.length > 1)) && (
          <Button variant="outline" disabled={disabled} onClick={() => setEditOrder(!editOrder)}>
            {t(editOrder ? "mods.workspace.done" : "mods.workspace.editOrder")}
          </Button>
        )}
      </ActionRow>
      {visibleAdditions && (
        <ul className="m-0 grid list-none gap-1 p-0">
          {providerAdditions.map((item) => (
            <li key={JSON.stringify([item.provider, item.project])}>
              <bdi>{item.name}</bdi> · {t("mods.workspace.pendingAddition")}
            </li>
          ))}
          {localAdditions.map(({ review }) => (
            <li key={review.plan_sha256}>
              <bdi>{review.native_id}</bdi> · {t("mods.workspace.pendingAddition")}
            </li>
          ))}
        </ul>
      )}
      {ordered.length === 0 && !hasAdditions && !term && filter === "all" ? (
        <p className="text-sm">{t("mods.empty")}</p>
      ) : visible.length === 0 && !visibleAdditions ? (
        <p role="status" className="text-sm">
          {t("mods.browse.noMatches")}
        </p>
      ) : null}
      {visible.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0">
          {visible.map((item, index) => {
            const pending = draft.packages.find((edit) => edit.native_id === item.native_id);
            const moved = ordered.indexOf(item) !== rank.get(item.native_id);
            return (
              <li key={item.native_id} className="grid gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm [overflow-wrap:anywhere]">
                    <Checkbox
                      checked={pending?.enabled ?? item.enabled}
                      disabled={disabled || pending?.enabled === null || editOrder}
                      onCheckedChange={(value) =>
                        queueEdit(item.native_id, value === item.enabled ? undefined : value)
                      }
                    />
                    {item.provider ? (
                      <span>
                        <Trans
                          t={t}
                          i18nKey="mods.fromProvider"
                          components={{
                            name: <bdi>{item.native_id}</bdi>,
                            provider: <bdi>{item.provider.provider}</bdi>,
                          }}
                        />
                      </span>
                    ) : (
                      <bdi>{item.native_id}</bdi>
                    )}
                  </label>
                  {pending && (
                    <span role="status">
                      {t(
                        pending.enabled === null
                          ? "mods.workspace.pendingRemoval"
                          : pending.enabled
                            ? "mods.workspace.pendingEnable"
                            : "mods.workspace.pendingDisable",
                      )}
                    </span>
                  )}
                  {moved && <span>{t("mods.workspace.pendingMove")}</span>}
                  {editOrder ? (
                    <ActionRow>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled || index === 0}
                        aria-label={t("mods.workspace.moveEarlierName", { name: item.native_id })}
                        onClick={() => move(index, -1)}
                      >
                        {t("mods.workspace.moveEarlier")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled || index === visible.length - 1}
                        aria-label={t("mods.workspace.moveLaterName", { name: item.native_id })}
                        onClick={() => move(index, 1)}
                      >
                        {t("mods.workspace.moveLater")}
                      </Button>
                    </ActionRow>
                  ) : pending?.enabled === null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => queueEdit(item.native_id, undefined)}
                    >
                      {t("mods.workspace.undoRemoval")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={t("mods.remove.choose", { name: item.native_id })}
                      onClick={(event) => {
                        removeButton.current = event.currentTarget;
                        setChoice({ nativeId: item.native_id, revision });
                      }}
                    >
                      {t("mods.remove.action")}
                    </Button>
                  )}
                </div>
                {choice?.nativeId === item.native_id && choice.revision === revision && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm">{t("mods.remove.history")}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() => {
                        setChoice(undefined);
                        packageArea.current?.focus();
                        queueEdit(choice.nativeId, null);
                      }}
                    >
                      {t("mods.remove.confirm")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setChoice(undefined);
                        if (removeButton.current?.disabled === false) removeButton.current.focus();
                        else packageArea.current?.focus();
                      }}
                    >
                      {t("mods.remove.cancel")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function inOverrideOrder(entry: ModSetupView, draftOrder?: string[]) {
  const order =
    draftOrder ??
    (entry.revision.orderings ?? []).find((ordering) => ordering.domain === "asset-override")
      ?.native_ids ??
    [];
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return (entry.revision.packages ?? []).toSorted(
    (a, b) => rank(a.native_id) - rank(b.native_id) || a.native_id.localeCompare(b.native_id),
  );
}

function setupRuntimeAvailable(entry: ModSetupView) {
  return entry.build_availability === "verified" || entry.build_availability === "present";
}

function SetupRow({
  entry,
  inUse,
  disabled,
  onUse,
}: {
  entry: ModSetupView;
  inUse: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const enabled = (entry.revision.packages ?? []).filter((item) => item.enabled).length;
  const clean = setupRuntimeAvailable(entry) && enabled === 0;
  const needsRuntime = entry.build_availability && !setupRuntimeAvailable(entry);
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-pc-md border border-pc-border p-2">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="font-semibold">{entry.profile.display_name}</span>
        <span className="text-sm text-pc-muted-foreground">
          {" "}
          · {enabled === 0 ? t("mods.noneOn") : t("mods.on", { count: enabled })}
        </span>
      </span>
      {entry.build_version && (
        <span className="text-sm text-pc-muted-foreground">
          {t("mods.runtimeVersion", { version: entry.build_version })}
        </span>
      )}
      {needsRuntime && (
        <span className="text-sm text-pc-muted-foreground">{t("mods.runtimeHeld")}</span>
      )}
      {entry.build_availability === "present" && (
        <span className="text-sm text-pc-muted-foreground">{t("mods.runtimePresent")}</span>
      )}
      {inUse ? (
        <span className="text-sm font-semibold">{t("mods.inUse")}</span>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={onUse}>
          {clean && entry.profile.is_default
            ? t("mods.useClean")
            : clean
              ? t("mods.useCleanNamed", { name: entry.profile.display_name })
              : t("mods.use", { name: entry.profile.display_name })}
        </Button>
      )}
    </li>
  );
}
