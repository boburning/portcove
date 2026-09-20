import { useCallback, useState, type SetStateAction } from "react";
import { type Filter, type View } from "../../view-model";

export function useAppShellState() {
  const [view, setViewState] = useState<View>("library");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [sourcePath, setSourcePath] = useState("");
  const [biosPath, setBiosPath] = useState("");
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptPath, setAdoptPath] = useState("");
  const setView = useCallback((nextView: SetStateAction<View>) => {
    setViewState((current) => (typeof nextView === "function" ? nextView(current) : nextView));
    setFilter("all");
  }, []);
  return {
    view,
    setView,
    filter,
    setFilter,
    query,
    setQuery,
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
