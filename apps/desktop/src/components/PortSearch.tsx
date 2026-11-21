import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Search, X } from "lucide-react";
import { Button } from "./ui/button";
import { Icon, Shortcut } from "./ui";
import { commandShortcut } from "../keyboard-shortcuts";
import { useAppTranslation } from "../localization";

/** One search target for the existing keyboard shortcut and browsing owner. */
export function PortSearch({
  query,
  setQuery,
  library = false,
  id = "port-search",
  searchLabel,
  placeholder,
}: {
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  library?: boolean;
  id?: string;
  searchLabel?: string;
  placeholder?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [searchReset, setSearchReset] = useState<"requested" | "cleared" | null>(null);
  if (searchReset === "requested" && !query) setSearchReset("cleared");
  if (searchReset === "cleared" && query) setSearchReset(null);
  const { t } = useAppTranslation("browsing");
  const label = searchLabel ?? (library ? t("search.library") : t("search.discover"));
  return (
    <div className="search flex min-h-(--control-height-lg) max-w-full min-w-0 items-center gap-2 rounded-pc-md border border-pc-input bg-pc-surface px-3 text-pc-muted-foreground focus-within:outline-3 focus-within:outline-offset-3 focus-within:outline-pc-ring">
      <Icon glyph={Search} />
      <input
        ref={input}
        id={id}
        type={searchLabel ? "search" : undefined}
        aria-label={label}
        className="min-h-(--control-height-lg) w-full min-w-0 border-0 bg-transparent py-0 text-pc-foreground outline-none"
        data-focusable
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder ?? t("search.placeholder")}
      />
      {query ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("search.clear")}
          data-focusable
          onClick={() => {
            setQuery("");
            input.current?.focus();
            setSearchReset("requested");
          }}
        >
          <X aria-hidden="true" />
        </Button>
      ) : (
        <Shortcut className="ms-auto shrink-0">{commandShortcut("F")}</Shortcut>
      )}
      <span className="sr-only" aria-live="polite">
        {searchReset === "cleared" ? t("search.cleared") : ""}
      </span>
    </div>
  );
}
