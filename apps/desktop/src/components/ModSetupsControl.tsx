import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { pickModPackagePath } from "../file-picker";
import { useAppTranslation } from "../localization";
import type { LiveMods, ModCodeReview, ModSetupView, ModSetupsView } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ModProviderBrowser, providerName } from "./ModProviderBrowser";
import { ActionRow, Notice } from "./ui/patterns";

type Props = {
  portId: string;
  generation: number;
  busy: boolean;
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
  const [failure, setFailure] = useState<"gameChanged" | { text: string }>();
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
    void desktopApi.modSetups(portId, generation).then(
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

  const reread = () => {
    setFailure(undefined);
    setRequest((value) => value + 1);
  };
  // Each change is checked again by Core under its lock; the result is re-read
  // rather than assumed.
  const perform = async (action: () => Promise<unknown>, success: string) => {
    setWorking(true);
    setOutcome(undefined);
    setFailure(undefined);
    let succeeded = false;
    try {
      await action();
      setOutcome(success);
      succeeded = true;
    } catch (failure) {
      setFailure({ text: errorText(failure) });
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
    setRequest((value) => value + 1);
  };
  return {
    view,
    error,
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

function BoundModSetupsControl({ portId, generation, busy }: Props) {
  const { t } = useAppTranslation("gameSettings");
  const {
    view,
    error,
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
  const [browserBusy, setBrowserBusy] = useState(false);
  const [copyName, setCopyName] = useState("");
  // A chosen package that runs code waits here for the player's explicit choice.
  const [codeReview, setCodeReview] = useState<{
    profileId: string;
    path: string;
    review: ModCodeReview;
  }>();
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
  const locked = working || !fresh || browserBusy;

  const { setups, selectedId, selected, heldUpdates, onOtherBuild, blocked } =
    currentModSetup(view);
  const nativeMessage = nativeListMessage(t, view.live);

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        {t("mods.heading")}
      </h3>
      <p className="text-sm text-pc-muted-foreground">{t("mods.intro")}</p>
      {error && <p role="alert">{error}</p>}
      {error && !fresh && !working && (
        <ActionRow>
          <Button variant="outline" onClick={reread}>
            {t("mods.reread")}
          </Button>
        </ActionRow>
      )}
      {outcome && <p role="status">{outcome}</p>}
      {setups.length === 0 ? (
        <ActionRow>
          <p className="text-sm">{t("mods.none")}</p>
          <Button
            variant="outline"
            disabled={locked}
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
          <ModSetupNotices
            blocked={blocked}
            live={view.live}
            nativeMessage={nativeMessage}
            browserBusy={browserBusy}
            provider={view.provider}
            heldUpdates={heldUpdates}
          />
          <ul aria-label={t("mods.setups")} className="m-0 grid list-none gap-2 p-0">
            {setups.map((entry) => (
              <SetupRow
                key={entry.profile.id}
                entry={entry}
                inUse={entry.profile.id === selectedId}
                disabled={locked || blocked}
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
              <ModSetupPackages
                selected={selected}
                disabled={locked || blocked}
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
              />
              <p className="text-sm text-pc-muted-foreground">
                {view.later_mods_take_priority ? t("mods.laterPriority") : t("mods.loadOrder")}
              </p>
              <ActionRow>
                <Button
                  variant="outline"
                  disabled={locked || blocked}
                  onClick={() =>
                    void (async () => {
                      const path = await pickModPackagePath(view.package_types);
                      // Closing the picker changes nothing and is not an error, and an
                      // answer for a view that was replaced is dropped.
                      if (typeof path !== "string" || !alive.current) return;
                      let review: ModCodeReview | null;
                      setWorking(true);
                      try {
                        review = await desktopApi.reviewModPackageCode(portId, path, generation);
                      } catch (failure) {
                        if (alive.current) setFailure({ text: errorText(failure) });
                        return;
                      } finally {
                        if (alive.current) setWorking(false);
                      }
                      if (!alive.current) return;
                      // Code the player has not allowed for these exact bytes waits for
                      // an explicit choice; bytes allowed before install directly.
                      if (review && !review.already_allowed) {
                        setOutcome(undefined);
                        setFailure(undefined);
                        setCodeReview({ profileId: selected.profile.id, path, review });
                        return;
                      }
                      await perform(
                        () =>
                          desktopApi.addModPackage(
                            portId,
                            selected.profile.id,
                            path,
                            selected.profile.current_revision,
                            generation,
                            review?.sha256 ?? null,
                          ),
                        t("mods.outcome.added", { name: selected.profile.display_name }),
                      );
                    })()
                  }
                >
                  {t("mods.add")}
                </Button>
              </ActionRow>
              {codeReview?.profileId === selected.profile.id && (
                <Notice intent="warning">
                  <div data-slot="notice-body" className="grid gap-2">
                    <p>
                      <Trans
                        t={t}
                        i18nKey="mods.code.intro"
                        components={{
                          name: <bdi>{codeReview.review.display_name}</bdi>,
                          id: <code dir="ltr">{codeReview.review.native_id}</code>,
                        }}
                      />
                    </p>
                    <p>{t("mods.code.runs")}</p>
                    <p className="[overflow-wrap:anywhere]">
                      <Trans
                        t={t}
                        i18nKey="mods.code.digest"
                        components={{ digest: <code dir="ltr">{codeReview.review.sha256}</code> }}
                      />
                    </p>
                    <ActionRow>
                      <Button
                        disabled={locked}
                        onClick={() => {
                          const { path, review } = codeReview;
                          setCodeReview(undefined);
                          void perform(
                            () =>
                              desktopApi.addModPackage(
                                portId,
                                selected.profile.id,
                                path,
                                selected.profile.current_revision,
                                generation,
                                review.sha256,
                              ),
                            t("mods.outcome.added", { name: selected.profile.display_name }),
                          );
                        }}
                      >
                        {t("mods.code.allow")}
                      </Button>
                      <Button variant="outline" onClick={() => setCodeReview(undefined)}>
                        {t("mods.code.cancel")}
                      </Button>
                    </ActionRow>
                  </div>
                </Notice>
              )}
              {view.provider && (
                <ModProviderBrowser
                  key={selected.profile.id}
                  portId={portId}
                  provider={view.provider}
                  generation={generation}
                  profileId={selected.profile.id}
                  profileName={selected.profile.display_name}
                  inUse={selected.profile.id === selectedId}
                  onBusyChange={setBrowserBusy}
                  disabled={working || !fresh || blocked}
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
              <CopyModSetup
                copyId={copyId}
                copyName={copyName}
                setCopyName={setCopyName}
                locked={locked}
                onOtherBuild={onOtherBuild}
                copy={(name, currentBuild) =>
                  perform(
                    () =>
                      currentBuild
                        ? desktopApi.copyModSetup(
                            portId,
                            selected.profile.id,
                            name,
                            generation,
                            true,
                          )
                        : desktopApi.copyModSetup(portId, selected.profile.id, name, generation),
                    currentBuild
                      ? t("mods.outcome.copiedCurrent", { name })
                      : t("mods.outcome.copied", { name }),
                  )
                }
              />
            </section>
          )}
        </>
      )}
    </section>
  );
}

function ModSetupNotices({
  blocked,
  live,
  nativeMessage,
  browserBusy,
  provider,
  heldUpdates,
}: {
  blocked: boolean;
  live: ModSetupsView["live"];
  nativeMessage: ReactNode;
  browserBusy: boolean;
  provider: ModSetupsView["provider"];
  heldUpdates: NonNullable<ModSetupsView["held_updates"]>;
}) {
  const { t } = useAppTranslation("gameSettings");
  return (
    <>
      {blocked && live && (
        <Notice intent="warning">
          <div data-slot="notice-body">
            <p>{t("mods.blocked")}</p>
            <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
              {[...live.unmanaged, ...live.changed_owned].map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        </Notice>
      )}
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
  copy,
}: {
  copyId: string;
  copyName: string;
  setCopyName: (name: string) => void;
  locked: boolean;
  onOtherBuild: boolean;
  copy: (name: string, currentBuild: boolean) => Promise<boolean>;
}) {
  const { t } = useAppTranslation("gameSettings");
  const name = copyName.trim();
  const disabled = locked || name === "";
  const submit = (currentBuild: boolean) =>
    void copy(name, currentBuild).then((created) => {
      if (created) setCopyName("");
    });
  return (
    <>
      <p className="text-sm text-pc-muted-foreground">{t("mods.copyIntro")}</p>
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
    view.live && (view.live.unmanaged.length > 0 || view.live.changed_owned.length > 0),
  );

  return { setups, selectedId, selected, heldUpdates, onOtherBuild, blocked };
}

/** Packages in the setup's priority order: the last one wins when two overlap. */
function ModSetupPackages({
  selected,
  disabled,
  setEnabled,
}: {
  selected: ModSetupView;
  disabled: boolean;
  setEnabled: (nativeId: string, value: boolean) => void;
}) {
  const { t } = useAppTranslation("gameSettings");
  return (selected.revision.packages ?? []).length === 0 ? (
    <p className="text-sm">{t("mods.empty")}</p>
  ) : (
    <ul className="m-0 grid list-none gap-1 p-0">
      {inOverrideOrder(selected).map((item) => (
        <li key={item.native_id}>
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
        </li>
      ))}
    </ul>
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
  return [...(entry.revision.packages ?? [])].sort(
    (a, b) => rank(a.native_id) - rank(b.native_id) || a.native_id.localeCompare(b.native_id),
  );
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
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-pc-md border border-pc-border p-2">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="font-semibold">{entry.profile.display_name}</span>
        <span className="text-sm text-pc-muted-foreground">
          {" "}
          · {enabled === 0 ? t("mods.noneOn") : t("mods.on", { count: enabled })}
        </span>
      </span>
      {inUse ? (
        <span className="text-sm font-semibold">{t("mods.inUse")}</span>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={onUse}>
          {t("mods.use", { name: entry.profile.display_name })}
        </Button>
      )}
    </li>
  );
}
