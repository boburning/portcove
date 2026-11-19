import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import {
  changeModEdit,
  draftSize,
  emptyModDraft,
  type LocalModSelection,
  type ModDraft,
} from "../features/mod-setups/mod-draft";
import { useAppTranslation } from "../localization";
import type {
  ModSetupDraftPreview,
  ModSetupView,
  ProviderCatalog,
  ProviderInstallPlan,
  ProviderProjectView,
} from "../types";
import { errorText, failurePresentation, formatBytes } from "../view-model";
import { ExternalLink } from "./ExternalLink";
import { ModArtwork, ModProviderCatalog, modProjectKey } from "./ModProviderCatalog";
import { Button } from "./ui/button";
import { ModUpdateControl, type ModUpdateControlProps } from "./ModUpdateControl";
import { ActionRow, Notice } from "./ui/patterns";

type Project = ProviderProjectView["project"];
type File = Project["files"][number];
type Props = {
  portId: string;
  generation: number;
  sources: readonly string[];
  selected: ModSetupView;
  browsing: boolean;
  active?: boolean;
  onBrowse: () => void;
  disabled: boolean;
  draft: ModDraft;
  localFiles?: readonly LocalModSelection[];
  undoLocal?: (digest: string) => void;
  setDraft: Dispatch<SetStateAction<ModDraft>>;
  onBusyChange: (busy: boolean) => void;
  onInstalled: (message: string) => void;
  onRefresh?: () => void;
  onApplying?: (applying: boolean) => void;
  reviewFromPlay?: number | undefined;
  onAppliedFromPlay?: (() => void) | undefined;
  updates?: Pick<ModUpdateControlProps, "policy" | "setPolicy" | "automaticChecks">;
};

export function providerName(provider: string) {
  if (provider === "gamebanana") return "GameBanana";
  if (provider === "thunderstore") return "Thunderstore";
  return provider;
}

export function ModProviderBrowser({
  portId,
  generation,
  sources,
  selected,
  browsing,
  active = true,
  onBrowse,
  disabled,
  draft,
  localFiles = [],
  undoLocal,
  setDraft,
  onBusyChange,
  onInstalled,
  onRefresh,
  onApplying,
  updates,
  reviewFromPlay,
  onAppliedFromPlay,
}: Props) {
  const { t } = useAppTranslation("gameSettings");
  const { id: profileId, current_revision: revision } = selected.profile;
  const [sourceChoice, setSource] = useState<string>();
  const source =
    sourceChoice && sources.includes(sourceChoice)
      ? sourceChoice
      : sources.length === 1
        ? sources[0]
        : undefined;
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({});
  const [catalogFailures, setCatalogFailures] = useState<
    Record<string, { browseUrl?: string } | undefined>
  >({});
  const [catalogLoading, setCatalogLoading] = useState<string>();
  const [project, setProject] = useState<Project>();
  const [updateFiles, setUpdateFiles] = useState<readonly string[]>();
  const [files, setFiles] = useState<ProviderProjectView>();
  const [review, setReview] = useState(false);
  const [playOrigin, setPlayOrigin] = useState(false);
  const [lastPlayRequest, setLastPlayRequest] = useState(reviewFromPlay);
  if (lastPlayRequest !== reviewFromPlay) {
    setLastPlayRequest(reviewFromPlay);
    if (draftSize(draft) > 0) {
      setPlayOrigin(true);
      setReview(true);
    }
  }
  const [checkedDraft, setCheckedDraft] = useState<{
    plans: ProviderInstallPlan[];
    preview: ModSetupDraftPreview;
  }>();
  const plans = checkedDraft?.plans;
  const edits = {
    packages: draft.packages.map(({ native_id, enabled }) => ({ native_id, enabled })),
    order: draft.order,
    local_files: localFiles.map(({ path, review }) => ({
      path,
      expected_plan_sha256: review.plan_sha256,
    })),
  };
  const [working, setWorking] = useState<"files" | "review" | "apply">();
  const [failure, setFailure] = useState<string>();
  const reviewId = useId();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const staged = useRef<ProviderInstallPlan[]>([]);
  const cleanup = useRef<Promise<unknown>>(Promise.resolve());
  const applying = useRef(false);
  const catalogInFlight = useRef(new Set<string>());
  const requestId = useRef({ generation: 0 });
  const discard = (items: readonly ProviderInstallPlan[]) => {
    if (!items.length) return;
    cleanup.current = cleanup.current.then(() =>
      Promise.allSettled(
        items.map((plan) => desktopApi.discardProviderInstall(portId, plan, generation)),
      ),
    );
  };
  useEffect(() => {
    alive.current = true;
    const request = requestId.current;
    return () => {
      alive.current = false;
      request.generation++;
      if (!applying.current) discard(staged.current);
      staged.current = [];
    };
    // The component belongs to a single library generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const busy = Boolean(working) || review;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);
  useEffect(() => {
    if (project) detailHeading.current?.focus();
  }, [project]);

  const loadCatalog = (provider: string) => {
    if (catalogInFlight.current.has(provider)) return;
    catalogInFlight.current.add(provider);
    setCatalogLoading(provider);
    setCatalogFailures((current) => ({ ...current, [provider]: undefined }));
    void desktopApi
      .modProviderCatalog(portId, provider, generation)
      .then((result) => {
        if (alive.current) setCatalogs((current) => ({ ...current, [provider]: result }));
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        const url = failurePresentation(error)?.technical_context.provider_browse_url;
        const verifiedUrl =
          provider === "thunderstore" &&
          typeof url === "string" &&
          /^https:\/\/thunderstore\.io\/c\/[a-zA-Z0-9_-]{1,128}\/$/u.test(url);
        setCatalogFailures((current) => ({
          ...current,
          [provider]: verifiedUrl ? { browseUrl: url } : {},
        }));
      })
      .finally(() => {
        catalogInFlight.current.delete(provider);
        if (alive.current)
          setCatalogLoading((current) => (current === provider ? undefined : current));
      });
  };
  useEffect(() => {
    if (active && browsing && source && !catalogs[source] && !catalogFailures[source])
      loadCatalog(source);
    // Catalog results and pending requests are keyed by reviewed source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, browsing, source]);

  const installed = new Map<string, string[]>();
  for (const item of selected.revision.packages ?? []) {
    if (!item.provider) continue;
    const { provider, project: projectId, binding } = item.provider;
    const gameId = binding
      ? binding.provider === "gamebanana"
        ? String(binding.game_id)
        : binding.community
      : catalogs[provider]?.legacy_game_id;
    if (!gameId) continue;
    const key = modProjectKey(provider, projectId, gameId);
    installed.set(key, [...(installed.get(key) ?? []), item.native_id]);
  }
  const lookup = (item: Project) => modProjectKey(item.provider, item.project_id, item.game_id);
  const queued = (item: Project) =>
    draft.additions.some(
      (entry) => modProjectKey(entry.provider, entry.project, entry.gameId) === lookup(item),
    );
  const eligible = (view: ProviderProjectView) =>
    view.freshness === "stale" || view.project.obsolete || view.project.status_unknown
      ? []
      : view.project.files.filter(
          (file) => !file.status_unknown && view.eligible_file_ids?.includes(file.file_id),
        );
  const queue = (item: Project, file: File) => {
    if (!item.game_id) return;
    const gameId = item.game_id;
    if (draft.additions.length + localFiles.length >= 16) {
      setFailure(t("mods.workspace.draftLimit"));
      return;
    }
    setDraft((current) => ({
      ...current,
      additions: [
        ...current.additions.filter(
          (entry) => modProjectKey(entry.provider, entry.project, entry.gameId) !== lookup(item),
        ),
        {
          provider: item.provider,
          gameId,
          project: item.project_id,
          file: file.file_id,
          fileName: file.file_name,
          name: item.name,
        },
      ],
    }));
  };
  const undo = (provider: string, projectId: string, gameId: string | null | undefined) =>
    setDraft((current) => ({
      ...current,
      additions: current.additions.filter(
        (item) =>
          modProjectKey(item.provider, item.project, item.gameId) !==
          modProjectKey(provider, projectId, gameId),
      ),
    }));
  const inspect = async (item: Project, add: boolean) => {
    const id = ++requestId.current.generation;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailure(undefined);
    setWorking("files");
    if (!add) {
      setUpdateFiles(undefined);
      setProject(item);
      setFiles(undefined);
    }
    try {
      const read = await desktopApi.providerProject(
        portId,
        item.project_id,
        generation,
        item.provider,
      );
      if (!alive.current || id !== requestId.current.generation) return;
      if (
        read.project.provider !== item.provider ||
        read.project.project_id !== item.project_id ||
        (read.project.game_id !== null && read.project.game_id !== item.game_id)
      ) {
        throw new Error(t("mods.gameChanged"));
      }
      const candidates = eligible(read);
      if (add && candidates.length === 1 && !read.project.unreadable_files) {
        queue(item, candidates[0]!);
        return;
      }
      setProject(item);
      setFiles(read);
    } catch (error) {
      if (alive.current && id === requestId.current.generation) setFailure(errorText(error));
    } finally {
      if (alive.current && id === requestId.current.generation) setWorking(undefined);
    }
  };
  const closeDetails = () => {
    requestId.current.generation++;
    setWorking(undefined);
    setProject(undefined);
    setUpdateFiles(undefined);
    setFiles(undefined);
    setFailure(undefined);
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const clearPlans = () => {
    discard(staged.current);
    staged.current = [];
    setCheckedDraft(undefined);
  };
  const closeReview = () => {
    clearPlans();
    setReview(false);
    setPlayOrigin(false);
    setFailure(undefined);
    requestAnimationFrame(() => reviewButton.current?.focus());
  };
  const prepare = async () => {
    setFailure(undefined);
    setWorking("review");
    const prepared: ProviderInstallPlan[] = [];
    try {
      await cleanup.current;
      if (!alive.current) return;
      for (const entry of draft.additions) {
        if (!entry.gameId) throw new Error(t("mods.workspace.chooseFileAgain"));
        const result = await desktopApi.planProviderInstall(
          portId,
          profileId,
          entry.project,
          entry.file,
          generation,
          entry.provider,
          entry.gameId,
        );
        prepared.push(result);
        if (!alive.current) {
          discard(prepared);
          return;
        }
        if (
          result.expected_revision !== revision ||
          result.profile_id !== profileId ||
          result.port_id !== portId ||
          result.provider.provider !== entry.provider ||
          result.provider.project !== entry.project ||
          result.file.file_id !== entry.file
        ) {
          throw new Error(t("mods.workspace.staleDraft"));
        }
      }
      const preview = await desktopApi.previewModSetupDraft(
        portId,
        profileId,
        revision,
        prepared,
        edits,
        generation,
      );
      if (!alive.current) {
        discard(prepared);
        return;
      }
      staged.current = prepared;
      setCheckedDraft({ plans: prepared, preview });
    } catch (error) {
      discard(prepared);
      if (alive.current) setFailure(errorText(error));
    } finally {
      if (alive.current) setWorking(undefined);
    }
  };
  const apply = async (allowCode: boolean) => {
    if (!plans) return;
    setFailure(undefined);
    setWorking("apply");
    applying.current = true;
    onApplying?.(true);
    try {
      await desktopApi.applyModSetupDraft(
        portId,
        profileId,
        revision,
        plans,
        edits,
        generation,
        allowCode,
      );
      setDraft(emptyModDraft);
      if (alive.current) {
        staged.current = [];
        closeReview();
        onInstalled(t("mods.workspace.applied"));
        if (playOrigin) onAppliedFromPlay?.();
      }
    } catch (error) {
      if (alive.current) {
        clearPlans();
        const presentation = failurePresentation(error);
        if (
          presentation &&
          (presentation.mutation_state === "committed" ||
            presentation.mutation_state === "recovery_required")
        ) {
          const committedRevision = Number(presentation.technical_context.setup_revision);
          const digest = presentation.technical_context.setup_revision_digest ?? "";
          if (
            Number.isSafeInteger(committedRevision) &&
            committedRevision > revision &&
            /^[a-f0-9]{64}$/u.test(digest)
          ) {
            setDraft((current) => ({
              ...current,
              receipt: { revision: committedRevision, digest },
            }));
            setReview(false);
            setPlayOrigin(false);
          }
        }
        setFailure(errorText(error));
        onRefresh?.();
      } else {
        discard(plans);
      }
    } finally {
      applying.current = false;
      onApplying?.(false);
      if (alive.current) setWorking(undefined);
    }
  };

  const projectKey = project ? lookup(project) : undefined;
  const installedIds = projectKey ? installed.get(projectKey) : undefined;
  const count = draftSize(draft);
  const codeMembers = (plan: ProviderInstallPlan) =>
    plan.members.filter((item) => item.runs_code?.length).map((item) => item.file_name);
  const needsPermission =
    Boolean(plans?.some((plan) => codeMembers(plan).length > 0)) ||
    Boolean(checkedDraft?.preview.local_code_packages?.length);
  const pendingAction = (item: Project) => (
    <>
      <span>{t("mods.workspace.pendingAddition")}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => undo(item.provider, item.project_id, item.game_id)}
      >
        {t("mods.workspace.undo")}
      </Button>
    </>
  );
  const rowAction = (item: Project) =>
    queued(item) ? (
      pendingAction(item)
    ) : (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || Boolean(working)}
        onClick={() => void inspect(item, !installed.has(lookup(item)))}
      >
        {t(installed.has(lookup(item)) ? "mods.workspace.details" : "mods.workspace.add")}
      </Button>
    );
  const root = useRef<HTMLDivElement>(null);
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (!active || event.key !== "Escape" || event.defaultPrevented) return;
    if (review && !working) closeReview();
    else if (project && !review) closeDetails();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  useEffect(() => {
    const owner = root.current;
    const onKey = (event: KeyboardEvent) => onEscape(event);
    owner?.addEventListener("keydown", onKey);
    return () => owner?.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="grid min-w-0 gap-3" ref={root}>
      {count > 0 && (
        <ActionRow>
          <span role="status">{t("mods.workspace.pendingCount", { count })}</span>
          <Button
            ref={reviewButton}
            disabled={disabled || Boolean(working)}
            aria-expanded={review}
            aria-controls={review ? reviewId : undefined}
            onClick={() => {
              if (review) closeReview();
              else {
                setFailure(undefined);
                setReview(true);
              }
            }}
          >
            {t("mods.workspace.review")}
          </Button>
        </ActionRow>
      )}
      {failure && (
        <p role="alert">
          <bdi>{failure}</bdi>
        </p>
      )}
      {working === "files" && source && (
        <p role="status">{t("mods.browse.checking", { provider: providerName(source) })}</p>
      )}
      <div hidden={review || !browsing || Boolean(project)}>
        {sources.length > 0 && (
          <ModProviderCatalog
            catalog={source ? catalogs[source] : undefined}
            source={source ?? ""}
            sources={sources}
            loading={Boolean(source && catalogLoading === source)}
            failed={Boolean(source && catalogFailures[source])}
            browseUrl={source ? catalogFailures[source]?.browseUrl : undefined}
            locked={disabled}
            setSource={setSource}
            refresh={() => {
              if (source) loadCatalog(source);
            }}
            installed={new Set(installed.keys())}
            showProject={(item) => void inspect(item, false)}
            action={rowAction}
            providerLabel={providerName}
            active={active && browsing && !review && !project}
          />
        )}
      </div>
      {!review && browsing && project && (
        <section className="mod-project-detail grid gap-3">
          <ActionRow>
            <Button variant="outline" size="sm" onClick={closeDetails}>
              {t("mods.browse.back")}
            </Button>
          </ActionRow>
          <h4 ref={detailHeading} tabIndex={-1} className="font-semibold">
            <bdi>{project.name}</bdi>
          </h4>
          <ModArtwork project={project} />
          {project.submitter && (
            <p>
              <Trans
                t={t}
                i18nKey="mods.browse.submittedBy"
                components={{ name: <bdi>{project.submitter}</bdi> }}
              />
            </p>
          )}
          <div>
            <ExternalLink
              href={project.profile_url}
              openUrl={() =>
                desktopApi.openProviderModProject(
                  portId,
                  project.project_id,
                  generation,
                  project.provider,
                )
              }
            >
              {t("mods.browse.sourcePage", { provider: providerName(project.provider) })}
            </ExternalLink>
          </div>
          {files?.freshness === "stale" && <p>{t("mods.workspace.cached")}</p>}
          {files?.project.status_unknown ? (
            <p>{t("mods.browse.eligibilityUnknown")}</p>
          ) : files?.project.obsolete ? (
            <p>{t("mods.browse.obsolete")}</p>
          ) : null}
          {installedIds && (
            <ActionRow>
              <span>{t("mods.workspace.installed")}</span>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setDraft((current) =>
                    changeModEdit(
                      current,
                      installedIds,
                      installedIds.every((id) =>
                        current.packages.some(
                          (edit) => edit.native_id === id && edit.enabled === null,
                        ),
                      )
                        ? undefined
                        : null,
                    ),
                  );
                }}
              >
                {t(
                  installedIds.every((id) =>
                    draft.packages.some((edit) => edit.native_id === id && edit.enabled === null),
                  )
                    ? "mods.workspace.undoRemoval"
                    : "mods.workspace.remove",
                )}
              </Button>
            </ActionRow>
          )}
          {queued(project) ? (
            <ActionRow>{pendingAction(project)}</ActionRow>
          ) : (
            files &&
            (!installedIds || updateFiles) && (
              <>
                {eligible(files).length === 0 && <p>{t("mods.workspace.browseOnly")}</p>}
                {files.project.unreadable_files > 0 && (
                  <p>
                    {t("mods.browse.unreadable", {
                      count: files.project.unreadable_files,
                      provider: providerName(project.provider),
                    })}
                  </p>
                )}
                <ul className="m-0 grid list-none gap-2 p-0">
                  {files.project.files
                    .filter((file) => file.status_unknown)
                    .map((file) => (
                      <li key={file.file_id} className="flex flex-wrap items-center gap-2">
                        <bdi>{file.file_name}</bdi>
                        <span>{t("mods.browse.eligibilityUnknown")}</span>
                      </li>
                    ))}
                  {eligible(files)
                    .filter((file) => !updateFiles || updateFiles.includes(file.file_id))
                    .map((file) => (
                      <li key={file.file_id} className="flex flex-wrap items-center gap-2">
                        <bdi>{file.file_name}</bdi>
                        <span>{formatBytes(file.size)}</span>
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() => queue(project, file)}
                        >
                          {t("mods.workspace.addFile", { file: file.file_name })}
                        </Button>
                      </li>
                    ))}
                </ul>
              </>
            )
          )}
        </section>
      )}
      {!browsing && !review && updates && sources.length > 0 && (
        <ModUpdateControl
          portId={portId}
          profileId={profileId}
          generation={generation}
          disabled={disabled || busy}
          {...updates}
          providerForPackage={(nativeId) =>
            selected.revision.packages?.find((item) => item.native_id === nativeId)?.provider
              ?.provider
          }
          showProject={(projectId, provider, candidateFiles) => {
            if (!sources.includes(provider)) return;
            onBrowse();
            const request = ++requestId.current.generation;
            setWorking("files");
            setProject(undefined);
            setFiles(undefined);
            setFailure(undefined);
            setSource(provider);
            void desktopApi
              .providerProject(portId, projectId, generation, provider)
              .then((item) => {
                if (!alive.current || request !== requestId.current.generation) return;
                if (item.project.provider !== provider || item.project.project_id !== projectId) {
                  throw new Error(t("mods.gameChanged"));
                }
                setProject(item.project);
                setFiles(item);
                setUpdateFiles(candidateFiles);
              })
              .catch((error) => {
                if (alive.current && request === requestId.current.generation)
                  setFailure(errorText(error));
              })
              .finally(() => {
                if (alive.current && request === requestId.current.generation)
                  setWorking(undefined);
              });
          }}
        />
      )}
      {review && (
        <Notice intent="info">
          <div id={reviewId} data-slot="notice-body" className="grid gap-3">
            <h4 ref={reviewHeading} tabIndex={-1} className="font-semibold">
              {t("mods.workspace.review")}
            </h4>
            <p>
              <bdi>{selected.profile.display_name}</bdi>
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              {draft.additions.map((entry) => (
                <li key={modProjectKey(entry.provider, entry.project, entry.gameId)}>
                  <ActionRow>
                    <span>
                      {t("mods.workspace.pendingAddition")} <bdi>{entry.name}</bdi> ·{" "}
                      <bdi>{entry.fileName}</bdi>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(working)}
                      onClick={() => {
                        clearPlans();
                        undo(entry.provider, entry.project, entry.gameId);
                        if (count === 1) closeReview();
                      }}
                    >
                      {t("mods.workspace.undo")}
                    </Button>
                  </ActionRow>
                </li>
              ))}
              {localFiles.map(({ review }) => (
                <li key={review.plan_sha256}>
                  <ActionRow>
                    <span>
                      {t("mods.workspace.pendingAddition")} <bdi>{review.native_id}</bdi>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(working)}
                      onClick={() => {
                        clearPlans();
                        undoLocal?.(review.plan_sha256);
                        if (count === 1) closeReview();
                      }}
                    >
                      {t("mods.workspace.undo")}
                    </Button>
                  </ActionRow>
                  {checkedDraft?.preview.local_code_packages?.includes(review.native_id) && (
                    <Notice intent="warning">
                      <div data-slot="notice-body">
                        <p>
                          <Trans
                            t={t}
                            i18nKey="mods.browse.code"
                            count={1}
                            components={{ names: <bdi>{review.native_id}</bdi> }}
                          />
                        </p>
                        <code dir="ltr">{review.sha256}</code>
                      </div>
                    </Notice>
                  )}
                </li>
              ))}
              {draft.packages.map((edit) => (
                <li key={edit.native_id}>
                  <ActionRow>
                    <span>
                      {t(
                        edit.enabled === null
                          ? "mods.workspace.pendingRemoval"
                          : edit.enabled
                            ? "mods.workspace.pendingEnable"
                            : "mods.workspace.pendingDisable",
                      )}{" "}
                      <bdi>{edit.native_id}</bdi>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(working)}
                      onClick={() => {
                        clearPlans();
                        setDraft((current) => changeModEdit(current, [edit.native_id], undefined));
                        if (count === 1 && edit.beforeRemoval === undefined) closeReview();
                      }}
                    >
                      {t("mods.workspace.undo")}
                    </Button>
                  </ActionRow>
                </li>
              ))}
              {draft.order && (
                <li>
                  <ActionRow>
                    <span>
                      {t("mods.workspace.pendingOrder")} <bdi>{draft.order.join(" · ")}</bdi>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={Boolean(working)}
                      onClick={() => {
                        clearPlans();
                        setDraft((current) => ({ ...current, order: null }));
                        if (count === 1) closeReview();
                      }}
                    >
                      {t("mods.workspace.undo")}
                    </Button>
                  </ActionRow>
                </li>
              )}
            </ul>
            {checkedDraft && <ModDraftPrecedence preview={checkedDraft.preview} />}
            {plans?.map((plan) => (
              <div key={plan.plan_sha256} className="grid gap-2">
                <h5 className="font-semibold">
                  <bdi>{plan.project_name}</bdi>
                </h5>
                <ProviderInstallDetails plan={plan} codeMembers={codeMembers(plan)} />
              </div>
            ))}
            {working && (
              <p role="status">
                {t(working === "apply" ? "mods.browse.installing" : "mods.workspace.checkingFiles")}
              </p>
            )}
            <ActionRow>
              {plans ? (
                <Button
                  disabled={disabled || Boolean(working)}
                  onClick={() => void apply(needsPermission)}
                >
                  {t(needsPermission ? "mods.workspace.applyCode" : "mods.workspace.apply")}
                </Button>
              ) : (
                <Button disabled={disabled || Boolean(working)} onClick={() => void prepare()}>
                  {t("mods.workspace.checkFiles")}
                </Button>
              )}
              <Button variant="outline" disabled={Boolean(working)} onClick={closeReview}>
                {t("mods.browse.cancel")}
              </Button>
            </ActionRow>
          </div>
        </Notice>
      )}
    </div>
  );
}

function ModDraftPrecedence({ preview }: { preview: ModSetupDraftPreview }) {
  const { t } = useAppTranslation("gameSettings");
  return (
    <>
      {preview.order.length > 0 && (
        <div>
          <p className="font-semibold">{t("mods.workspace.pendingOrder")}</p>
          <ol className="list-decimal ps-5">
            {preview.order.map((id) => (
              <li key={id}>
                <bdi>{id}</bdi>
              </li>
            ))}
          </ol>
        </div>
      )}
      {(preview.conflicts.length > 0 || preview.conflicts_truncated) && (
        <div>
          <p className="font-semibold">{t("mods.browse.conflictsHeading")}</p>
          <ul className="list-disc ps-5">
            {preview.conflicts.map((conflict) => (
              <li key={conflict.path}>
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
          {preview.conflicts_truncated && <p>{t("mods.browse.truncated")}</p>}
        </div>
      )}
    </>
  );
}

function ProviderInstallDetails({
  plan,
  codeMembers,
}: {
  plan: ProviderInstallPlan;
  codeMembers: string[];
}) {
  const { t } = useAppTranslation("gameSettings");
  return (
    <>
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
      {(plan.wrappers?.length ?? 0) > 1 && (
        <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
          {plan.wrappers?.map((wrapper) => (
            <li key={wrapper.provider.project}>
              <Trans
                t={t}
                i18nKey="mods.browse.entryVersion"
                components={{
                  name: <bdi>{wrapper.provider.project}</bdi>,
                  version: <bdi>{wrapper.file.file_id}</bdi>,
                }}
              />
              <ul className="m-0 list-disc ps-5">
                {Object.keys(wrapper.members).map((member) => (
                  <li key={member}>
                    <bdi>{member}</bdi>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {plan.ignored_entries > 0 && (
        <p>{t("mods.browse.ignored", { count: plan.ignored_entries })}</p>
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
                count={codeMembers.length}
                components={{
                  names: <bdi>{codeMembers.join(t("mods.separator"))}</bdi>,
                }}
              />
            </p>
          </div>
        </Notice>
      )}
    </>
  );
}
