import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { Icon, NavigationHints, Shortcut } from "./ui";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string;
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
  const [selectedId, setSelectedId] = useState<string>();
  const activeCommand = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const eligible = filtered.filter((command) => !command.disabled);
  const fallbackId = preferredCommandId(filtered);
  const activeId = eligible.some((command) => command.id === selectedId) ? selectedId : fallbackId;
  const activeIndex = filtered.findIndex((command) => command.id === activeId);
  useEffect(() => {
    activeCommand.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        palette.current &&
        (!(focused instanceof HTMLElement) ||
          !palette.current.contains(focused) ||
          (focused instanceof HTMLButtonElement && focused.disabled))
      )
        searchInput.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [filtered]);

  const run = (command: PaletteCommand) => {
    if (command.disabled) return;
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
        initialFocus={searchInput}
        showCloseButton={false}
        className="command-palette top-[12vh] w-[min(40rem,calc(100vw-var(--space-12)))] max-w-none -translate-y-0 gap-0 p-0 sm:max-w-none"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only" id="command-palette-title">
          Portcove commands
        </DialogTitle>
        <label className="palette-search">
          <Icon glyph={Search} />
          <input
            ref={searchInput}
            data-autofocus
            data-focusable
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-autocomplete="list"
            aria-label="Search commands"
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setSelectedId(preferredCommandId(filterCommands(commands, nextQuery)));
            }}
            onKeyDown={(event) => {
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
              } else if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                filtered[activeIndex]
              ) {
                event.preventDefault();
                run(filtered[activeIndex]);
              }
            }}
            aria-controls={filtered.length ? "command-palette-results" : undefined}
            aria-activedescendant={
              filtered[activeIndex] ? `command-${filtered[activeIndex].id}` : undefined
            }
            placeholder="Search actions and navigation"
            autoComplete="off"
          />
          <Shortcut>Esc</Shortcut>
        </label>
        <div
          className="palette-results"
          id="command-palette-results"
          role={filtered.length ? "listbox" : undefined}
          aria-label={filtered.length ? "Available commands" : undefined}
        >
          {filtered.length === 0 ? (
            <p className="palette-empty" role="status">
              {query.trim() ? `No command matches “${query}”.` : "No commands are available."}
            </p>
          ) : (
            filtered.map((command) => (
              <button
                id={`command-${command.id}`}
                role="option"
                aria-selected={activeId === command.id}
                data-focusable
                key={command.id}
                ref={activeId === command.id ? activeCommand : undefined}
                onFocus={() => setSelectedId(command.id)}
                className={activeId === command.id ? "palette-command active" : "palette-command"}
                disabled={command.disabled}
                onMouseEnter={() => setSelectedId(command.id)}
                onClick={() => run(command)}
              >
                <span className="palette-command-icon">
                  <Icon glyph={command.icon} />
                </span>
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
                {command.shortcut && <Shortcut>{command.shortcut}</Shortcut>}
              </button>
            ))
          )}
        </div>
        <footer className="palette-footer">
          <NavigationHints />
        </footer>
      </DialogContent>
    </Dialog>
  );
}

export function filterCommands(commands: PaletteCommand[], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;
  return commands.filter((command) => {
    const haystack =
      `${command.label} ${command.description} ${command.keywords ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function preferredCommandId(commands: PaletteCommand[]) {
  return commands.find((command) => !command.disabled)?.id;
}
