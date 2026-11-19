import type { OutputLocalModPackagePlan } from "../transport-types.generated";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
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
import { ModProviderBrowser, providerName } from "./ModProviderBrowser";
import { ModRecipeControl } from "./ModRecipeControl";
import { CreateCleanModSetup } from "./CreateCleanModSetup";
import { ModSetupRecovery } from "./ModSetupRecovery";
import { ModSetupRuntimeRetirement } from "./ModSetupRuntimeRetirement";
import { ActionRow, Notice } from "./ui/patterns";

type Props = {
  portId: string;
  generation: number;
  busy: boolean;
  openGameFiles?: (() => void) | undefined;
};

/** Thin view of Core-owned mod setups; Core decides support, locks and recovery. */
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
  // False from a change until the view is read again, so no control acts on a
  // revision the change has replaced.
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    if (busy) return;
    let current = true;
    void readModSetupInventory(portId, generation).then(
      (next) => {
        if (!current) return;
        if (next.port_id !== portId) {
          setFailure("gameChanged");
          return;
        }
        setView(next);
        setFresh(true);
      },
      (failure: unknown) => {
        if (current) setFailure({ text: errorText(failure) });
      },
    );
    return () => {
      current = false;
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
  };
}

function BoundModSetupsControl({ portId, generation, busy, openGameFiles }: Props) {
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
  } = useModSetupInventory(portId, generation, busy);
  const [providerChoice, setProviderChoice] = useState<{
    portId: string;
    generation: number;
    provider: string;
  }>();
  const selectedProvider =
    providerChoice?.portId === portId && providerChoice.generation === generation
      ? providerChoice.provider
      : undefined;
  const browseProvider =
    view?.provider ??
    (selectedProvider && view?.providers?.includes(selectedProvider)
      ? selectedProvider
      : undefined);
  const [browserBusy, setBrowserBusy] = useState(false);
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
  // Games without reviewed mod support show nothing, including while loading.
  if (!view?.supported) return null;
  if (busy) return <p role="status">{t("mods.busy")}</p>;
  // The provider browser's work or open review locks every other change, so a
  // review always lands on the setup and revision it was made for.
  const locked = working || !fresh || browserBusy || recipeBusy;
  const { setups, selectedId, selected, heldUpdates, onOtherBuild, blocked } =
    currentModSetup(view);
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
    <section aria-labelledby={headingId} className="grid gap-3">
      <h3
        ref={setupHeading}
        id={headingId}
        tabIndex={-1}
        className="scroll-mt-2 text-base font-semibold"
      >
        {t("mods.heading")}
      </h3>
      <p className="text-sm text-pc-muted-foreground">{t("mods.intro")}</p>
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
            provider={browseProvider ?? null}
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
          <ul aria-label={t("mods.setups")} className="m-0 grid list-none gap-2 p-0">
            {setups.map((entry) => (
              <SetupRow
                key={entry.profile.id}
                entry={entry}
                inUse={entry.profile.id === selectedId}
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
          {selected && (
            <section
              aria-label={t("mods.modsIn", { name: selected.profile.display_name })}
              className="grid gap-2"
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
                key={JSON.stringify(["packages", selected.profile.id])}
                selected={selected}
                disabled={changing || blocked}
                setEnabled={(nativeId, value) =>
                  void perform(
                    () =>
                      desktopApi.setModPackageEnabled(
                        portId,
                        selected.profile.id,
                        nativeId,
                        value,
                        selected.profile.current_revision,
                        generation,
                      ),
                    value
                      ? t("mods.outcome.turnedOn", { name: nativeId })
                      : t("mods.outcome.turnedOff", { name: nativeId }),
                  )
                }
                remove={(nativeId, expectedRevision) =>
                  void perform(
                    () =>
                      desktopApi.removeModPackage(
                        portId,
                        selected.profile.id,
                        nativeId,
                        expectedRevision,
                        generation,
                      ),
                    t("mods.remove.removed", { name: nativeId }),
                  )
                }
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
                    const { path, review } = applicableReview;
                    setLocalReview(undefined);
                    setupHeading.current?.focus();
                    void perform(
                      () =>
                        desktopApi.applyLocalModPackage(
                          portId,
                          selected.profile.id,
                          path,
                          review.plan_sha256,
                          generation,
                          review.needs_code_permission,
                        ),
                      t("mods.outcome.added", { name: selected.profile.display_name }),
                    );
                  }}
                  cancel={() => {
                    setLocalReview(undefined);
                    requestAnimationFrame(() => addFile.current?.focus());
                  }}
                />
              )}
              {view.providers && view.providers.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {view.providers.map((provider) => (
                    <Button
                      key={provider}
                      variant="outline"
                      aria-pressed={selectedProvider === provider}
                      disabled={browserBusy || working || !fresh || recipeBusy}
                      onClick={() => setProviderChoice({ portId, generation, provider })}
                    >
                      {providerName(provider)}
                    </Button>
                  ))}
                </div>
              )}
              {browseProvider && (
                <ModProviderBrowser
                  key={JSON.stringify(["provider", selected.profile.id, browseProvider])}
                  portId={portId}
                  provider={browseProvider}
                  generation={generation}
                  profileId={selected.profile.id}
                  profileName={selected.profile.display_name}
                  inUse={selected.profile.id === selectedId}
                  onBusyChange={setBrowserBusy}
                  disabled={working || !fresh || blocked || recipeBusy || Boolean(applicableReview)}
                  updates={{
                    policy: selected.profile.intent?.update_policy ?? "review_updates",
                    automaticChecks: (view.last_automatic_checks ?? []).filter(
                      (check) => check.profile_id === selected.profile.id,
                    ),
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
      <ModRecipeControl
        openGameFiles={openGameFiles}
        portId={portId}
        profileId={selected?.profile.id}
        generation={generation}
        disabled={changing}
        onBusyChange={setRecipeBusy}
        onImported={refreshAfterProviderInstall}
      />
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
        <Button disabled={locked || review.missing_required_mods.length > 0} onClick={add}>
          {t(review.needs_code_permission ? "mods.code.allow" : "mods.local.add")}
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
  setEnabled,
  remove,
}: {
  selected: ModSetupView;
  disabled: boolean;
  setEnabled: (nativeId: string, value: boolean) => void;
  remove: (nativeId: string, expectedRevision: number) => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  const [choice, setChoice] = useState<{ nativeId: string; revision: number }>();
  const revision = selected.profile.current_revision;
  const packageArea = useRef<HTMLDivElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <div ref={packageArea} tabIndex={-1}>
      {(selected.revision.packages ?? []).length === 0 ? (
        <p className="text-sm">{t("mods.empty")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {inOverrideOrder(selected).map((item) => (
            <li key={item.native_id} className="grid gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm [overflow-wrap:anywhere]">
                  <Checkbox
                    checked={item.enabled}
                    disabled={disabled}
                    onCheckedChange={(value) => setEnabled(item.native_id, value)}
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
                      remove(choice.nativeId, choice.revision);
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
          ))}
        </ul>
      )}
    </div>
  );
}

function inOverrideOrder(entry: ModSetupView) {
  const order =
    (entry.revision.orderings ?? []).find((ordering) => ordering.domain === "asset-override")
      ?.native_ids ?? [];
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
