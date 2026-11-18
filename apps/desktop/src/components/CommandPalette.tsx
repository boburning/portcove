import { Button } from "./ui/button";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { Icon, NavigationHints, Shortcut } from "./ui";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { escapeKeyName } from "../keyboard-shortcuts";
import { normalizeGameSearchText } from "../search-text";
import { focusableControls } from "../focus";

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  group?: string;
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string;
  /** Listed only once the player types a query, so long game lists do not bury navigation. */
  searchOnly?: boolean;
  /** False when the description is generic and should not widen search matches. */
  matchDescription?: boolean;
  /** Exact option results used when the query does not match the parent game title. */
  searchAlternatives?: PaletteCommand[];
  /** Exact stable references take precedence over a similarly named game. */
  exactQueries?: readonly string[];
  disabled?: boolean;
  action: () => void;
}

export function CommandPalette({
  open,
  commands,
  close,
}: {
  open: boolean;
  commands: PaletteCommand[];
  close: () => void;
}) {
  if (!open) return null;
  return <OpenCommandPalette commands={commands} close={close} />;
}

function OpenCommandPalette({
  commands,
  close,
}: {
  commands: PaletteCommand[];
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const { t } = useAppTranslation("commands");
  const { t: commonT } = useAppTranslation("common");
  const [selectedId, setSelectedId] = useState<string>();
  const activeCommand = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const dispatched = useRef(false);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const eligible = filtered.filter((command) => !command.disabled);
  const fallbackId = preferredCommandId(filtered);
  const activeId = eligible.some((command) => command.id === selectedId) ? selectedId : fallbackId;
  const activeIndex = filtered.findIndex((command) => command.id === activeId);
  useEffect(() => {
    if (activeCommand.current) activeCommand.current.scrollIntoView({ block: "nearest" });
    else palette.current?.scrollTo({ top: 0 });
  }, [activeId, query]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        palette.current &&
        (!(focused instanceof HTMLElement) ||
          !palette.current.contains(focused) ||
          focused === palette.current ||
          (focused instanceof HTMLButtonElement && focused.disabled))
      )
        searchInput.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [filtered]);

  const run = (command: PaletteCommand) => {
    if (command.disabled || dispatched.current) return;
    // Consume this opening before close/action can synchronously send more input.
    dispatched.current = true;
    close();
    command.action();
  };

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      <DialogContent
        ref={palette}
        onFocus={(event) => {
          // Base UI moves focus to the popup when its focused option vanishes.
          if (event.target === event.currentTarget) searchInput.current?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.defaultPrevented) return;
          const controls = focusableControls(event.currentTarget).filter(
            (control) => control.tabIndex >= 0,
          );
          const first = controls[0];
          const last = controls.at(-1);
          const boundary = event.shiftKey ? first : last;
          const target = event.shiftKey ? last : first;
          if (target && event.target === boundary) {
            // Keep focus in the palette before the portal guard restores it on the next frame.
            event.preventDefault();
            target.focus();
          }
        }}
        initialFocus={searchInput}
        showCloseButton={false}
        className="command-palette top-[12dvh] w-[min(40rem,_calc(100vw_-_var(--space-12)))] max-w-none -translate-y-0 gap-0 overflow-x-hidden rounded-pc-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] p-0 shadow-[var(--shadow-floating)] sm:max-w-none min-[42rem]:max-h-[calc(88dvh_-_var(--space-2))]"
        aria-modal={true}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only" id="command-palette-title">
          {t("palette.title")}
        </DialogTitle>
        <label className="palette-search grid min-h-[3.25rem] grid-cols-[auto_minmax(0,_1fr)_auto] items-center gap-3 bg-[var(--color-bg-inset)] p-[0_var(--space-4)] text-[var(--color-text-muted)] [border-bottom:1px_solid_var(--color-border)] focus-within:shadow-[inset_0_-2px_var(--color-focus)]">
          <Icon glyph={Search} />
          <input
            className="min-h-[3.25rem] w-full border-0 bg-[var(--color-transparent)] p-0 text-[length:var(--text-md)] text-[var(--color-text)] [outline:0]"
            ref={searchInput}
            data-focusable
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-autocomplete="list"
            aria-label={t("palette.search")}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setSelectedId(preferredCommandId(filterCommands(commands, nextQuery)));
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
                return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                const nextIndex = Math.min(
                  eligible.findIndex((command) => command.id === activeId) + 1,
                  eligible.length - 1,
                );
                setSelectedId(eligible[nextIndex]?.id);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                const nextIndex = Math.max(
                  eligible.findIndex((command) => command.id === activeId) - 1,
                  0,
                );
                setSelectedId(eligible[nextIndex]?.id);
              } else if (event.key === "Enter" && filtered[activeIndex]) {
                event.preventDefault();
                if (!event.repeat) run(filtered[activeIndex]);
              }
            }}
            aria-controls={filtered.length ? "command-palette-results" : undefined}
            aria-activedescendant={
              filtered[activeIndex] ? `command-${filtered[activeIndex].id}` : undefined
            }
            placeholder={t("palette.placeholder")}
            autoComplete="off"
          />
          <Shortcut>{escapeKeyName}</Shortcut>
        </label>
        <div
          className="palette-results max-h-[min(27rem,_58vh)] overflow-auto p-2"
          id="command-palette-results"
          role={filtered.length ? "listbox" : undefined}
          aria-label={filtered.length ? t("palette.available") : undefined}
        >
          {filtered.length === 0 ? (
            <p
              className="palette-empty m-0 p-8 text-center text-[var(--color-text-muted)]"
              role="status"
            >
              {query.trim() ? (
                // The typed query is an exact player value, never interpolated.
                <Trans t={t} i18nKey="palette.noMatch" components={{ query: <bdi>{query}</bdi> }} />
              ) : (
                t("palette.empty")
              )}
            </p>
          ) : (
            contiguousCommandGroups(filtered).map((group) => (
              <div key={group.commands[0]!.id} role="group" aria-label={group.label}>
                {group.label && (
                  <div
                    aria-hidden="true"
                    className="px-3 pt-2 pb-1 text-[length:var(--text-xs)] font-medium text-[var(--color-text-muted)]"
                  >
                    {group.label}
                  </div>
                )}
                {group.commands.map((command) => (
                  <Button
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={activeId === command.id}
                    data-focusable
                    key={command.id}
                    ref={activeId === command.id ? activeCommand : undefined}
                    onFocus={() => setSelectedId(command.id)}
                    variant={activeId === command.id ? "selected" : "ghost"}
                    className="palette-command grid w-full grid-cols-[auto_minmax(0,1fr)_auto] justify-start gap-3 px-3 py-2 text-start font-normal"
                    disabled={command.disabled}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229)
                      )
                        event.preventDefault();
                    }}
                    onMouseMove={() => setSelectedId(command.id)}
                    onClick={() => run(command)}
                  >
                    <span className="palette-command-icon grid h-[2rem] w-[2rem] [place-items:center] text-[var(--color-text-muted)]">
                      <Icon glyph={command.icon} />
                    </span>
                    <span>
                      <strong className="block text-[length:var(--text-sm)]">
                        {command.label}
                      </strong>
                      <small className="mt-[0.15rem] block text-[length:var(--text-xs)] text-[var(--color-text-secondary)]">
                        {command.description}
                      </small>
                    </span>
                    {command.shortcut && <Shortcut>{command.shortcut}</Shortcut>}
                  </Button>
                ))}
              </div>
            ))
          )}
        </div>
        <footer className="palette-footer flex flex-wrap items-center gap-2 p-[var(--space-2)_var(--space-4)] text-[length:var(--text-2xs)] text-[var(--color-text-muted)] [border-top:1px_solid_var(--color-border)]">
          <NavigationHints className="mt-0 min-w-0 flex-1" />
          <Button variant="ghost" size="sm" onClick={close}>
            {commonT("close")}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

export function filterCommands(commands: PaletteCommand[], query: string) {
  const terms = normalizeGameSearchText(query.trim()).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands.filter((command) => !command.searchOnly);
  const exactQuery = query.trim().toLocaleLowerCase("en");
  const exact = commands
    .flatMap((command) => [command, ...(command.searchAlternatives ?? [])])
    .filter((command) =>
      command.exactQueries?.some((value) => value.toLocaleLowerCase("en") === exactQuery),
    );
  if (exact.length) return exact;
  const matches = (command: PaletteCommand) => {
    const searchable = normalizeGameSearchText(
      `${command.label} ${command.matchDescription === false ? "" : command.description} ${command.keywords ?? ""}`,
    );
    return terms.every((term) => searchable.includes(term));
  };
  return commands.flatMap((command) =>
    matches(command) ? [command] : (command.searchAlternatives?.filter(matches) ?? []),
  );
}

function preferredCommandId(commands: PaletteCommand[]) {
  return commands.find((command) => !command.disabled)?.id;
}

// Presentation must never reorder the registry: repeated groups stay separate.
export function contiguousCommandGroups(commands: PaletteCommand[]) {
  const groups: { label: string | undefined; commands: PaletteCommand[] }[] = [];
  for (const command of commands) {
    const previous = groups[groups.length - 1];
    if (previous && previous.label === command.group) previous.commands.push(command);
    else groups.push({ label: command.group, commands: [command] });
  }
  return groups;
}
