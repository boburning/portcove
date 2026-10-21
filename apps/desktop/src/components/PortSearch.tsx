import type { Dispatch, SetStateAction } from "react";
import { Search } from "lucide-react";
import { Icon, Shortcut } from "./ui";
import { commandShortcut } from "../keyboard-shortcuts";

/** One search target for the existing keyboard shortcut and browsing owner. */
export function PortSearch({
  query,
  setQuery,
  library = false,
}: {
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  library?: boolean;
}) {
  const label = library ? "Search your library" : "Search Find games";
  return (
    <label
      className="search flex min-h-(--control-height-lg) max-w-full min-w-0 items-center gap-2 rounded-pc-md border border-pc-input bg-pc-surface px-3 text-pc-muted-foreground focus-within:outline-3 focus-within:outline-offset-3 focus-within:outline-pc-ring"
      htmlFor="port-search"
    >
      <Icon glyph={Search} />
      <input
        id="port-search"
        aria-label={label}
        className="min-h-(--control-height-lg) w-full min-w-0 border-0 bg-transparent py-0 text-pc-foreground outline-none"
        data-focusable
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Game or port name"
      />
      <Shortcut className="ms-auto shrink-0">{commandShortcut("F")}</Shortcut>
    </label>
  );
}
