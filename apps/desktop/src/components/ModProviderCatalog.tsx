import { useId, useState } from "react";
import { ListFilter, Puzzle, RefreshCw, X } from "lucide-react";
import { Trans } from "react-i18next";
import { useFilterPanel } from "../features/browsing/useFilterPanel";
import { useAppTranslation } from "../localization";
import type { ProviderCatalog, ProviderProjectView } from "../types";
import { ChoiceSelect } from "./ChoiceSelect";
import { CollectionLayoutToggle } from "./CollectionLayoutToggle";
import { ExternalLink } from "./ExternalLink";
import { PortSearch } from "./PortSearch";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ChipButton } from "./ui/chip";

type Project = ProviderProjectView["project"];
type Sort = "downloads" | "likes" | "ratings" | "updated" | "newest" | "name";
type Installation = "all" | "hide" | "only";
type Layout = "covers" | "rows";
const PAGE_SIZE = 20;

function preference<T extends string>(key: string, values: readonly T[], fallback: T) {
  try {
    const stored = localStorage.getItem(key);
    return values.find((value) => value === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A session still works when the browser cannot store preferences.
  }
}

function metric(project: Project, sort: Sort) {
  if (sort === "updated") return project.updated_at || undefined;
  if (sort === "newest") return project.listing?.created_at ?? undefined;
  if (sort === "name") return undefined;
  return project.listing?.[sort] ?? undefined;
}

export function modProjectKey(provider: string, project: string) {
  return JSON.stringify([provider, project]);
}

export function ModArtwork({ project }: { project: Project }) {
  const [failed, setFailed] = useState<string>();
  const url = project.listing?.artwork;
  return (
    <span className="mod-catalog-art" data-provider={project.provider} aria-hidden="true">
      {url && failed !== url ? (
        <img
          alt=""
          src={url}
          width={530}
          height={300}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(url)}
        />
      ) : (
        <Icon glyph={Puzzle} size="lg" />
      )}
    </span>
  );
}

export function ModProviderCatalog({
  catalog,
  source,
  sources,
  locked,
  loading,
  failed,
  browseUrl,
  setSource,
  refresh,
  installed,
  showProject,
  action,
  providerLabel,
  active,
}: {
  catalog?: ProviderCatalog | undefined;
  source: string;
  sources: readonly string[];
  locked: boolean;
  loading: boolean;
  failed: boolean;
  browseUrl?: string | undefined;
  setSource: (source: string) => void;
  refresh: () => void;
  installed: ReadonlySet<string>;
  showProject: (project: Project) => void;
  action: (project: Project) => React.ReactNode;
  providerLabel: (source: string) => string;
  active: boolean;
}) {
  const { t, i18n } = useAppTranslation("gameSettings");
  const [query, setQuery] = useState("");
  const [categoriesBySource, setCategoriesBySource] = useState<Record<string, string[]>>({});
  const categories = categoriesBySource[source] ?? [];
  const setCategories = (values: string[]) => {
    setCategoriesBySource((current) => ({ ...current, [source]: values }));
    setPage(1);
  };
  const [installation, setInstallation] = useState<Installation>(() =>
    preference("portcove.mods.installation", ["all", "hide", "only"], "all"),
  );
  const [layout, setLayout] = useState<Layout>(() =>
    preference("portcove.mods.layout", ["covers", "rows"], "covers"),
  );
  const sortOptions: Sort[] =
    source === "thunderstore"
      ? ["downloads", "ratings", "updated", "newest", "name"]
      : ["downloads", "likes", "updated", "newest", "name"];
  const sortKey = `portcove.mods.sort.${source}`;
  const [sorts, setSorts] = useState<Record<string, Sort>>({});
  const sort = sorts[source] ?? preference(sortKey, sortOptions, "downloads");
  const [page, setPage] = useState(1);
  const searchId = useId();
  const resultHeading = useId();
  const { open, setOpen, panelId, trigger, heading, panel, close } = useFilterPanel();
  const projects = catalog?.projects ?? [];
  const availableCategories = [
    ...new Set([
      ...categories,
      ...projects.flatMap((project) => project.listing?.categories ?? []),
    ]),
  ].sort((a, b) => a.localeCompare(b, i18n.resolvedLanguage));
  const activeCount = categories.length + Number(installation !== "all");
  const updateInstallation = (next: Installation) => {
    savePreference("portcove.mods.installation", next);
    setInstallation(next);
    setPage(1);
  };
  const isInstalled = (project: Project) =>
    installed.has(modProjectKey(project.provider, project.project_id));
  const term = query.trim().toLocaleLowerCase();
  const matching = projects.filter((project) => {
    if (installation !== "all" && isInstalled(project) !== (installation === "only")) return false;
    if (
      categories.length &&
      !categories.some((category) => project.listing?.categories.includes(category))
    )
      return false;
    return (
      !term ||
      [project.name, project.submitter, project.version, project.project_id].some((value) =>
        value?.toLocaleLowerCase().includes(term),
      )
    );
  });
  if (!(source === "gamebanana" && sort === "downloads")) {
    const byName = new Intl.Collator(i18n.resolvedLanguage, { numeric: true, sensitivity: "base" });
    matching.sort((a, b) => {
      const aMetric = metric(a, sort);
      const bMetric = metric(b, sort);
      if (aMetric !== bMetric) {
        if (aMetric === undefined) return 1;
        if (bMetric === undefined) return -1;
        return bMetric - aMetric;
      }
      return byName.compare(a.name, b.name) || a.project_id.localeCompare(b.project_id);
    });
  }
  const lastPage = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const currentPage = Math.min(lastPage, page);
  const visible = matching.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const alternative = sources.find((entry) => entry !== source);
  const checked = catalog ? new Date(catalog.observed_at * 1000) : undefined;
  const switchSource = (next: string) => {
    setPage(1);
    setSource(next);
  };
  const removeChip = (event: React.MouseEvent, remove: () => void) => {
    const focused = document.activeElement === event.currentTarget;
    remove();
    if (focused) trigger.current?.focus();
  };
  return (
    <section className="mod-catalog min-w-0" aria-labelledby={resultHeading}>
      <div className="library-query-tools mb-4">
        <search
          className="browse-toolbar flex flex-wrap items-center gap-2"
          data-active-mod-search={active ? "" : undefined}
        >
          <PortSearch
            id={searchId}
            searchLabel={t("mods.workspace.search")}
            placeholder={t("mods.workspace.search")}
            query={query}
            setQuery={(next) => {
              setQuery(next);
              setPage(1);
            }}
          />
          <Button
            ref={trigger}
            type="button"
            data-focusable
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => (open ? close() : setOpen(true))}
          >
            <ListFilter aria-hidden="true" /> {t("mods.workspace.filters")}
            {activeCount > 0 && <span className="catalog-filter-count">({activeCount})</span>}
          </Button>
          <div className="browse-sort w-[13rem] max-w-full min-w-0">
            <ChoiceSelect
              inline
              label={t("mods.workspace.sort")}
              value={sort}
              options={sortOptions.map((value) => ({
                value,
                label: t(`mods.workspace.sorts.${value}`),
              }))}
              onChange={(next) => {
                savePreference(sortKey, next);
                setSorts((current) => ({ ...current, [source]: next }));
                setPage(1);
              }}
            />
          </div>
          <CollectionLayoutToggle
            layout={layout}
            labels={{
              group: t("mods.workspace.view"),
              view: t("mods.workspace.view"),
              covers: t("mods.workspace.covers"),
              rows: t("mods.workspace.rows"),
              rowsName: t("mods.workspace.rows"),
            }}
            onChange={(next) => {
              savePreference("portcove.mods.layout", next);
              setLayout(next);
            }}
          />
        </search>
        {open && (
          <section
            id={panelId}
            ref={panel}
            className="catalog-filter-panel"
            aria-labelledby={`${panelId}-title`}
          >
            <h5 id={`${panelId}-title`} ref={heading} tabIndex={-1}>
              {t("mods.workspace.filters")}
            </h5>
            <div className="flex flex-wrap items-start gap-4">
              <fieldset className="grid max-w-full min-w-0 gap-1">
                <legend>{t("mods.workspace.category")}</legend>
                {availableCategories.length === 0 && (
                  <span>{t("mods.workspace.noCategories")}</span>
                )}
                {availableCategories.map((category) => (
                  <label key={category} className="mod-filter-choice flex items-center gap-2">
                    <Checkbox
                      checked={categories.includes(category)}
                      onCheckedChange={(checked) =>
                        setCategories(
                          checked === true
                            ? [...categories, category]
                            : categories.filter((existing) => existing !== category),
                        )
                      }
                    />
                    <bdi>{category}</bdi>
                  </label>
                ))}
              </fieldset>
              <fieldset className="grid max-w-full min-w-0 gap-1">
                <legend>{t("mods.workspace.installation")}</legend>
                {(["all", "hide", "only"] as const).map((value) => (
                  <label key={value} className="mod-filter-choice flex items-center gap-2">
                    <input
                      type="radio"
                      name={`${panelId}-installed`}
                      value={value}
                      checked={installation === value}
                      onChange={() => updateInstallation(value)}
                    />
                    {t(`mods.workspace.status.${value}`)}
                  </label>
                ))}
              </fieldset>
            </div>
            <Button variant="outline" size="sm" onClick={close}>
              {t("mods.workspace.done")}
            </Button>
          </section>
        )}
        <div className="collection-result-summary mod-catalog-summary">
          <span id={resultHeading} role="status">
            {catalog &&
              t(catalog.complete ? "mods.workspace.count" : "mods.workspace.partialCount", {
                count: matching.length,
              })}
            {!catalog && t("mods.workspace.browse")}
          </span>
          {sources.length > 1 ? (
            <div className="mod-catalog-source min-w-0">
              <ChoiceSelect
                inline
                label={t("mods.workspace.source")}
                value={source}
                onChange={switchSource}
                disabled={locked}
                options={sources.map((value) => ({ value, label: providerLabel(value) }))}
              />
            </div>
          ) : (
            <span>{t("mods.workspace.oneSource", { provider: providerLabel(source) })}</span>
          )}
          {categories.map((category) => (
            <ChipButton
              key={category}
              size="sm"
              variant="selected"
              aria-label={t("mods.workspace.removeFilter", { filter: category })}
              onClick={(event) =>
                removeChip(event, () =>
                  setCategories(categories.filter((existing) => existing !== category)),
                )
              }
            >
              <bdi>{category}</bdi> <X aria-hidden="true" />
            </ChipButton>
          ))}
          {installation !== "all" && (
            <ChipButton
              size="sm"
              variant="selected"
              aria-label={t("mods.workspace.removeFilter", {
                filter: t(`mods.workspace.status.${installation}`),
              })}
              onClick={(event) => removeChip(event, () => updateInstallation("all"))}
            >
              {t(`mods.workspace.status.${installation}`)} <X aria-hidden="true" />
            </ChipButton>
          )}
          {activeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) =>
                removeChip(event, () => {
                  setCategories([]);
                  updateInstallation("all");
                })
              }
            >
              {t("mods.workspace.clearFilters")}
            </Button>
          )}
          <span className="mod-catalog-refresh">
            {checked && Number.isFinite(checked.getTime()) && (
              <span>
                {t("mods.workspace.checked", {
                  time: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                    dateStyle: "short",
                    timeStyle: "short",
                  }).format(checked),
                })}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked || loading}
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" /> {t("mods.workspace.refresh")}
            </Button>
          </span>
        </div>
      </div>
      {catalog?.freshness === "stale" && <p role="status">{t("mods.workspace.cached")}</p>}
      {catalog && !catalog.complete && <p role="status">{t("mods.workspace.partial")}</p>}
      {failed && <p role="alert">{t("mods.workspace.refreshFailed")}</p>}
      {browseUrl && (
        <ExternalLink href={browseUrl}>
          {t("mods.browse.sourcePage", { provider: providerLabel(source) })}
        </ExternalLink>
      )}
      {loading && (
        <p role="status">{t("mods.browse.checking", { provider: providerLabel(source) })}</p>
      )}
      {catalog && !loading && visible.length === 0 && (
        <div className="grid gap-2 text-sm">
          {catalog.complete && projects.length === 0 ? (
            <>
              <p>{t("mods.workspace.emptySource", { provider: providerLabel(source) })}</p>
              {alternative && (
                <div>
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => switchSource(alternative)}
                  >
                    {t("mods.workspace.trySource", { provider: providerLabel(alternative) })}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p>{t(catalog.complete ? "mods.browse.noMatches" : "mods.workspace.noKnownMatches")}</p>
          )}
        </div>
      )}
      <ul className="mod-catalog-results" data-layout={layout}>
        {visible.map((project) => (
          <li
            className="mod-catalog-item"
            key={modProjectKey(project.provider, project.project_id)}
          >
            <button
              type="button"
              className="mod-catalog-project"
              aria-label={project.name}
              onClick={() => showProject(project)}
            >
              <ModArtwork project={project} />
              <span className="mod-catalog-identity">
                <span className="mod-catalog-category">
                  <bdi>{project.listing?.categories[0] ?? t("mods.workspace.uncategorized")}</bdi>
                </span>
                <strong>
                  <bdi>{project.name}</bdi>
                </strong>
                {project.submitter && (
                  <span className="mod-catalog-credit">
                    <Trans
                      t={t}
                      i18nKey="mods.browse.submittedBy"
                      components={{ name: <bdi>{project.submitter}</bdi> }}
                    />
                  </span>
                )}
              </span>
            </button>
            <span className="mod-catalog-metric">
              <ModMetric project={project} sort={sort} />
            </span>
            <span className="mod-catalog-status">
              {isInstalled(project) && t("mods.workspace.installed")}
            </span>
            <span className="mod-catalog-action">{action(project)}</span>
          </li>
        ))}
      </ul>
      {lastPage > 1 && (
        <nav aria-label={t("mods.workspace.pages")} className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            {t("mods.browse.previous")}
          </Button>
          <span>{t("mods.workspace.page", { page: currentPage, total: lastPage })}</span>
          <Button
            variant="outline"
            disabled={currentPage >= lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            {t("mods.browse.next")}
          </Button>
        </nav>
      )}
    </section>
  );
}

function ModMetric({ project, sort }: { project: Project; sort: Sort }) {
  const { t, i18n } = useAppTranslation("gameSettings");
  const value = metric(project, sort);
  if (value === undefined || sort === "name") return <bdi>{project.version ?? "—"}</bdi>;
  if (sort === "updated" || sort === "newest") {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? (
      new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium" }).format(date)
    ) : (
      <bdi>{project.version ?? "—"}</bdi>
    );
  }
  const values = {
    count: value,
    value: new Intl.NumberFormat(i18n.resolvedLanguage).format(value),
  };
  switch (sort) {
    case "downloads":
      return t("mods.workspace.metrics.downloads", values);
    case "likes":
      return t("mods.workspace.metrics.likes", values);
    case "ratings":
      return t("mods.workspace.metrics.ratings", values);
  }
}
