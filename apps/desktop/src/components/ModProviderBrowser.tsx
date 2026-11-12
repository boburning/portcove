import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ProviderBrowsePage, ProviderInstallPlan, ProviderProjectView } from "../types";
import { errorText, formatBytes } from "../view-model";
import { Button } from "./ui/button";
import { ActionRow, Notice } from "./ui/patterns";

type Props = {
  portId: string;
  /** The provider this game has a reviewed binding for (`gamebanana`, `thunderstore`). */
  provider: string;
  generation: number;
  profileId: string;
  profileName: string;
  /** True when this setup is the one whose mods are live now. */
  inUse: boolean;
  /** True while the setups panel is busy or holds changes. */
  disabled: boolean;
  /** Reports work or an open review, so the panel locks other changes meanwhile. */
  onBusyChange: (busy: boolean) => void;
  /** Called after an install so the setups panel reads Core again. */
  onInstalled: (message: string) => void;
};

/** The provider's own name, which is not translated. */
export function providerName(provider: string) {
  return provider === "thunderstore" ? "Thunderstore" : "GameBanana";
}

function staleNote(
  t: TFunction<"gameSettings">,
  provider: string,
  freshness: string,
  observedAt: number,
): string | undefined {
  if (freshness !== "stale") return undefined;
  const time = new Date(observedAt * 1000).toLocaleString(undefined, { timeZoneName: "short" });
  return t("mods.browse.stale", { time, provider });
}

/**
 * Thin view of Core's provider browsing and reviewed install for one setup;
 * mounted per setup. Core checks the game binding, the provider data, the
 * downloaded bytes and the setup's revision; Desktop presents them, asks for
 * consent and sends the reviewed plan back with the setup and digest it showed.
 * Provider names, file names and digests stay exact inside bdi.
 */
export function ModProviderBrowser(props: Props) {
  const {
    portId,
    provider: providerId,
    generation,
    profileId,
    profileName,
    inUse,
    disabled,
    onBusyChange,
    onInstalled,
  } = props;
  const provider = providerName(providerId);
  const { t } = useAppTranslation("gameSettings");
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ProviderBrowsePage>();
  const [project, setProject] = useState<ProviderProjectView>();
  const [plan, setPlan] = useState<ProviderInstallPlan>();
  const [working, setWorking] = useState<string>();
  // Core failure text stays verbatim; the app's own follow-up is rendered live.
  const [error, setError] = useState<{ text: string; reviewAgain?: boolean }>();
  const headingId = useId();
  const reviewId = useId();
  const alive = useRef(true);
  // The open review, so leaving this view always discards its private staging.
  const openPlan = useRef<ProviderInstallPlan | undefined>(undefined);
  const discard = (reviewed: ProviderInstallPlan | undefined) => {
    // Discarding only removes private staging; a failure changes nothing visible.
    if (reviewed)
      void desktopApi.discardProviderInstall(portId, reviewed, generation).catch(() => {});
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      discard(openPlan.current);
      openPlan.current = undefined;
    };
    // Mounted per setup and library generation; the discard uses that identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const busy = Boolean(working) || Boolean(plan);
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const showPlan = (next: ProviderInstallPlan | undefined) => {
    openPlan.current = next;
    setPlan(next);
  };

  const run = async <T,>(status: string, action: () => Promise<T>, apply: (value: T) => void) => {
    setWorking(status);
    setError(undefined);
    try {
      const value = await action();
      if (alive.current) apply(value);
      return value;
    } catch (failure) {
      if (alive.current) setError({ text: errorText(failure) });
      return undefined;
    } finally {
      if (alive.current) setWorking(undefined);
    }
  };

  const showPage = (number: number) =>
    void run(
      t("mods.browse.checking", { provider }),
      () => desktopApi.browseProviderMods(portId, number, generation),
      (next) => {
        setPage(next);
        setProject(undefined);
      },
    );

  const showProject = (projectId: string) =>
    void run(
      t("mods.browse.checking", { provider }),
      () => desktopApi.providerProject(portId, projectId, generation),
      setProject,
    );

  const cancelPlan = () => {
    discard(plan);
    showPlan(undefined);
  };

  if (!open)
    return (
      <ActionRow>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setOpen(true);
            showPage(1);
          }}
        >
          {t("mods.browse.open", { provider })}
        </Button>
      </ActionRow>
    );

  const locked = disabled || Boolean(working);
  const codeMembers = (plan?.members ?? [])
    .filter((member) => (member.runs_code ?? []).length > 0)
    .map((member) => member.file_name);
  const projectStale = project
    ? staleNote(t, provider, project.freshness, project.observed_at)
    : undefined;
  const pageStale = page ? staleNote(t, provider, page.freshness, page.observed_at) : undefined;
  const name = <bdi>{profileName}</bdi>;
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h4 id={headingId} className="text-sm font-semibold">
        <Trans t={t} i18nKey="mods.browse.heading" values={{ provider }} components={{ name }} />
      </h4>
      <p className="text-sm text-pc-muted-foreground">{t("mods.browse.intro", { provider })}</p>
      {error && (
        <p role="alert">
          {error.text}
          {error.reviewAgain ? ` ${t("mods.browse.reviewAgain")}` : ""}
        </p>
      )}
      {working && <p role="status">{working}</p>}

      {plan ? (
        <Notice intent="info" aria-labelledby={reviewId}>
          <div data-slot="notice-body" className="grid gap-2">
            <h5 id={reviewId} className="text-sm font-semibold">
              <Trans
                t={t}
                i18nKey="mods.browse.reviewHeading"
                components={{ project: <bdi>{plan.project_name}</bdi>, name }}
              />
            </h5>
            <p>
              <Trans
                t={t}
                i18nKey="mods.browse.reviewFile"
                values={{ size: formatBytes(plan.download_size) }}
                components={{ file: <bdi>{plan.file.file_name}</bdi> }}
              />{" "}
              {inUse ? t("mods.browse.inUse") : t("mods.browse.notInUse")}
            </p>
            <p className="font-semibold">{t("mods.browse.installs")}</p>
            <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
              {plan.members.map((member) => (
                <li key={member.file_name}>
                  <Trans
                    t={t}
                    i18nKey="mods.browse.member"
                    values={{ size: formatBytes(member.size) }}
                    components={{ file: <bdi>{member.file_name}</bdi> }}
                  />
                </li>
              ))}
              {plan.replaces.map((replaced) => (
                <li key={`replaces-${replaced}`}>
                  <Trans
                    t={t}
                    i18nKey="mods.browse.replaces"
                    components={{ name: <bdi>{replaced}</bdi> }}
                  />
                </li>
              ))}
            </ul>
            {plan.ignored_entries > 0 && (
              <p>{t("mods.browse.ignored", { count: plan.ignored_entries })}</p>
            )}
            {plan.conflicts.length > 0 && (
              <>
                <p className="font-semibold">{t("mods.browse.conflictsHeading")}</p>
                <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
                  {plan.conflicts.map((conflict) => (
                    <li key={`conflict-${conflict.path}`}>
                      <Trans
                        t={t}
                        i18nKey="mods.browse.conflict"
                        components={{
                          path: <bdi>{conflict.path}</bdi>,
                          providers: <bdi>{conflict.providers.join(t("mods.separator"))}</bdi>,
                          winner: <bdi>{conflict.winner}</bdi>,
                        }}
                      />
                    </li>
                  ))}
                </ul>
                {plan.conflicts_truncated && <p>{t("mods.browse.truncated")}</p>}
              </>
            )}
            {plan.unverified_claims.length > 0 && (
              <>
                <p className="font-semibold">{t("mods.browse.unverifiedHeading")}</p>
                <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
                  {plan.unverified_claims.map((claim) => (
                    <li key={`claim-${claim}`}>
                      <bdi>{claim}</bdi>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="text-sm [overflow-wrap:anywhere] text-pc-muted-foreground">
              <Trans
                t={t}
                i18nKey="mods.browse.digests"
                components={{
                  download: <code dir="ltr">{plan.download_sha256}</code>,
                  review: <code dir="ltr">{plan.plan_sha256}</code>,
                }}
              />
            </p>
            {codeMembers.length > 0 && (
              <Notice intent="warning">
                <div data-slot="notice-body">
                  <p className="[overflow-wrap:anywhere]">
                    <Trans
                      t={t}
                      i18nKey="mods.browse.code"
                      components={{
                        names: <bdi>{codeMembers.join(t("mods.separator"))}</bdi>,
                      }}
                    />
                  </p>
                </div>
              </Notice>
            )}
            <ActionRow>
              <Button
                disabled={locked}
                onClick={() =>
                  void run(
                    t("mods.browse.installing"),
                    () => {
                      // Core owns the staging during the install; leaving now must
                      // not discard it underneath the install.
                      openPlan.current = undefined;
                      // Code runs only after the player saw which packages run it
                      // and chose the button that says so.
                      return desktopApi.applyProviderInstall(
                        portId,
                        profileId,
                        plan.plan_sha256,
                        plan,
                        generation,
                        codeMembers.length > 0,
                      );
                    },
                    () => {
                      // Installed: the staging is gone, nothing to discard.
                      showPlan(undefined);
                      onInstalled(
                        t("mods.browse.installed", {
                          count: plan.members.length,
                          added: plan.members
                            .map((member) => member.file_name)
                            .join(t("mods.separator")),
                          project: plan.project_name,
                          name: profileName,
                        }),
                      );
                    },
                  ).then((applied) => {
                    // A refused install can't succeed later with this review.
                    if (applied === undefined && alive.current) {
                      discard(plan);
                      showPlan(undefined);
                      setError((current) =>
                        current ? { ...current, reviewAgain: true } : current,
                      );
                    }
                  })
                }
              >
                {codeMembers.length > 0 ? t("mods.browse.installCode") : t("mods.browse.install")}
              </Button>
              <Button variant="outline" disabled={Boolean(working)} onClick={cancelPlan}>
                {t("mods.browse.cancel")}
              </Button>
            </ActionRow>
          </div>
        </Notice>
      ) : project ? (
        <section
          aria-label={t("mods.browse.filesLabel", { name: project.project.name })}
          className="grid gap-2"
        >
          <p className="text-sm font-semibold">
            <bdi>{project.project.name}</bdi>
          </p>
          {projectStale && <p className="text-sm">{projectStale}</p>}
          {project.project.obsolete && <p className="text-sm">{t("mods.browse.obsolete")}</p>}
          {project.project.files.length === 0 ? (
            <p className="text-sm">{t("mods.browse.noFiles")}</p>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {project.project.files.map((file) => {
                const installable = !file.archived && !project.project.obsolete && !projectStale;
                return (
                  <li
                    key={file.file_id}
                    className="flex flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]"
                  >
                    <span className="min-w-0 flex-1">
                      <Trans
                        t={t}
                        i18nKey={file.archived ? "mods.browse.fileArchived" : "mods.browse.file"}
                        values={{ size: formatBytes(file.size) }}
                        components={{ file: <bdi>{file.file_name}</bdi> }}
                      />
                    </span>
                    {installable && (
                      <Button
                        variant="outline"
                        disabled={locked}
                        onClick={() =>
                          void run(
                            t("mods.browse.downloading", { file: file.file_name }),
                            () =>
                              desktopApi.planProviderInstall(
                                portId,
                                profileId,
                                project.project.project_id,
                                file.file_id,
                                generation,
                              ),
                            showPlan,
                          ).then((reviewed) => {
                            // An answer for a view that was left is discarded.
                            if (reviewed && !alive.current) discard(reviewed);
                          })
                        }
                      >
                        {t("mods.browse.review", { file: file.file_name })}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {project.project.unreadable_files > 0 && (
            <p className="text-sm">
              {t("mods.browse.unreadable", { count: project.project.unreadable_files, provider })}
            </p>
          )}
          <ActionRow>
            {projectStale && (
              <Button
                variant="outline"
                disabled={locked}
                onClick={() => showProject(project.project.project_id)}
              >
                {t("mods.browse.checkAgain", { provider })}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={Boolean(working)}
              onClick={() => {
                setError(undefined);
                setProject(undefined);
              }}
            >
              {t("mods.browse.back")}
            </Button>
          </ActionRow>
        </section>
      ) : page ? (
        <section aria-label={t("mods.browse.modsLabel", { provider })} className="grid gap-2">
          {pageStale && <p className="text-sm">{pageStale}</p>}
          {page.page.projects.length === 0 ? (
            <p className="text-sm">{t("mods.browse.noMods")}</p>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0">
              {page.page.projects.map((entry) => (
                <li
                  key={entry.project_id}
                  className="flex flex-wrap items-center gap-2 text-sm [overflow-wrap:anywhere]"
                >
                  <span className="min-w-0 flex-1">
                    <Trans
                      t={t}
                      i18nKey={entry.version ? "mods.browse.entryVersion" : "mods.browse.entry"}
                      components={{
                        name: <bdi>{entry.name}</bdi>,
                        version: <bdi>{entry.version ?? ""}</bdi>,
                      }}
                    />
                  </span>
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => showProject(entry.project_id)}
                  >
                    {t("mods.browse.showFiles", { name: entry.name })}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <ActionRow>
            <Button
              variant="outline"
              disabled={locked || page.page.page <= 1}
              onClick={() => showPage(page.page.page - 1)}
            >
              {t("mods.browse.previous")}
            </Button>
            <Button
              variant="outline"
              disabled={locked || page.page.complete || page.page.page >= page.last_page}
              onClick={() => showPage(page.page.page + 1)}
            >
              {t("mods.browse.next")}
            </Button>
            <Button variant="outline" disabled={Boolean(working)} onClick={() => setOpen(false)}>
              {t("mods.browse.close")}
            </Button>
          </ActionRow>
        </section>
      ) : working ? null : (
        <ActionRow>
          <Button variant="outline" disabled={disabled} onClick={() => showPage(1)}>
            {t("mods.browse.checkAgain", { provider })}
          </Button>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("mods.browse.close")}
          </Button>
        </ActionRow>
      )}
    </section>
  );
}
