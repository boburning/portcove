import { useCallback, useState, type SetStateAction } from "react";
import { type CatalogSort, type Filter, type View } from "../../view-model";
import type { CatalogQuery } from "../browsing/catalog-query";
import type { SettingsCategory } from "./settings-categories";

type BrowserState = {
  filter: Filter | CatalogQuery;
  query: string;
  readiness?: string;
  sort?: CatalogSort;
};
export type BrowsingInputs = {
  sections: Record<View, BrowserState>;
  catalogSort: CatalogSort;
};

const initialBrowserState = (): Record<View, BrowserState> => ({
  library: { filter: "all", query: "" },
  catalog: { filter: "all", query: "" },
  updates: { filter: "all", query: "" },
  settings: { filter: "all", query: "" },
});

function restoredBrowserState(initial?: BrowsingInputs): Record<View, BrowserState> {
  if (!initial) return initialBrowserState();
  return Object.fromEntries(
    Object.entries(initial.sections).map(([section, inputs]) => [
      section,
      {
        ...inputs,
        ...(section === "library"
          ? {
              readiness:
                inputs.readiness ??
                (typeof inputs.filter === "string" && ["ready", "setup"].includes(inputs.filter)
                  ? inputs.filter
                  : "all"),
            }
          : {}),
        filter:
          section === "library" &&
          typeof inputs.filter === "string" &&
          ["ready", "setup"].includes(inputs.filter)
            ? "all"
            : typeof inputs.filter === "string" &&
                !["all", "ready", "setup", "stable", "beta", "rolling"].includes(inputs.filter)
              ? { version: 1, channels: [inputs.filter] }
              : inputs.filter,
      },
    ]),
  ) as Record<View, BrowserState>;
}

export function useAppShellState(
  initialView: View = "library",
  initial?: BrowsingInputs,
  initialSettingsCategory: SettingsCategory = "appearance",
  initialLibrarySort?: CatalogSort,
) {
  const [view, setViewState] = useState<View>(initialView);
  const [browserState, setBrowserState] = useState(() => {
    const restored = restoredBrowserState(initial);
    return initialLibrarySort !== undefined && restored.library.sort === undefined
      ? { ...restored, library: { ...restored.library, sort: initialLibrarySort } }
      : restored;
  });
  const [catalogSort, setCatalogSort] = useState<CatalogSort>(initial?.catalogSort ?? "catalog");
  const [selectedId, setSelectedId] = useState<string>();
  const [reviewedActivityId, setReviewedActivityId] = useState<string>();
  const [activitySection, setActivitySection] = useState<"tasks" | "updates" | "history">("tasks");
  const [settingsCategory, setSettingsCategory] =
    useState<SettingsCategory>(initialSettingsCategory);
  const [sourcePath, setSourcePath] = useState("");
  const [biosPath, setBiosPath] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptPath, setAdoptPath] = useState("");
  const setView = useCallback(
    (nextView: SetStateAction<View>) => {
      const resolved = typeof nextView === "function" ? nextView(view) : nextView;
      if (resolved !== view) setSelectedId(undefined);
      setViewState(resolved);
    },
    [view],
  );
  const setFilter = useCallback(
    (nextFilter: SetStateAction<Filter | CatalogQuery>) =>
      setBrowserState((current) => ({
        ...current,
        [view]: {
          ...current[view],
          ...(() => {
            const filter =
              typeof nextFilter === "function" ? nextFilter(current[view].filter) : nextFilter;
            return view === "library" && (filter === "ready" || filter === "setup")
              ? { readiness: filter }
              : { filter };
          })(),
        },
      })),
    [view],
  );
  const setQuery = useCallback(
    (nextQuery: SetStateAction<string>) =>
      setBrowserState((current) => ({
        ...current,
        [view]: {
          ...current[view],
          query: typeof nextQuery === "function" ? nextQuery(current[view].query) : nextQuery,
        },
      })),
    [view],
  );
  const setLibraryReadiness = useCallback(
    (readiness: string) =>
      setBrowserState((current) => ({
        ...current,
        library: { ...current.library, readiness },
      })),
    [],
  );
  const setLibrarySort = useCallback(
    (sort: SetStateAction<CatalogSort>) =>
      setBrowserState((current) => ({
        ...current,
        library: {
          ...current.library,
          sort: typeof sort === "function" ? sort(current.library.sort ?? "name") : sort,
        },
      })),
    [],
  );
  const librarySort = browserState.library.sort ?? "name";
  const libraryReadiness = browserState.library.readiness ?? "all";
  const { filter, query } = browserState[view];
  return {
    browsingInputs: { sections: browserState, catalogSort },
    view,
    setView,
    filter,
    setFilter,
    libraryReadiness,
    setLibraryReadiness,
    query,
    setQuery,
    catalogSort,
    setCatalogSort,
    librarySort,
    setLibrarySort,
    selectedId,
    setSelectedId,
    reviewedActivityId,
    setReviewedActivityId,
    activitySection,
    setActivitySection,
    settingsCategory,
    setSettingsCategory,
    sourcePath,
    setSourcePath,
    biosPath,
    setBiosPath,
    adoptOpen,
    setAdoptOpen,
    adoptPath,
    setAdoptPath,
  };
}
