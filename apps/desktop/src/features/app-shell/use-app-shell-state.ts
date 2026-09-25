import { useCallback, useState, type SetStateAction } from "react";
import { type CatalogSort, type Filter, type View } from "../../view-model";

type BrowserState = { filter: Filter; query: string };
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

export function useAppShellState(initialView: View = "library", initial?: BrowsingInputs) {
  const [view, setViewState] = useState<View>(initialView);
  const [browserState, setBrowserState] = useState(
    () => initial?.sections ?? initialBrowserState(),
  );
  const [catalogSort, setCatalogSort] = useState<CatalogSort>(initial?.catalogSort ?? "catalog");
  const [selectedId, setSelectedId] = useState<string>();
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
    (nextFilter: SetStateAction<Filter>) =>
      setBrowserState((current) => ({
        ...current,
        [view]: {
          ...current[view],
          filter: typeof nextFilter === "function" ? nextFilter(current[view].filter) : nextFilter,
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
  const { filter, query } = browserState[view];
  return {
    browsingInputs: { sections: browserState, catalogSort },
    view,
    setView,
    filter,
    setFilter,
    query,
    setQuery,
    catalogSort,
    setCatalogSort,
    selectedId,
    setSelectedId,
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
