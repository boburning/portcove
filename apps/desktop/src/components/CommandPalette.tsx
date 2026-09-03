import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Search } from "lucide-react";
import { useDialogFocus } from "../dialog";
import { Icon, NavigationHints, Shortcut } from "./ui";

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

export function CommandPalette({ open, commands, close }: { open: boolean; commands: PaletteCommand[]; close: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeCommand = useRef<HTMLButtonElement>(null);
  const dialog = useDialogFocus(close, open);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => setActiveIndex(index => Math.min(index, Math.max(0, filtered.length - 1))), [filtered.length]);
  useEffect(() => { activeCommand.current?.scrollIntoView({ block: "nearest" }); }, [activeIndex, open]);
  if (!open) return null;

  const run = (command: PaletteCommand) => {
    if (command.disabled) return;
    close();
    command.action();
  };

  return <div className="scrim palette-scrim" onMouseDown={event => { if (event.currentTarget === event.target) close(); }}>
    <section ref={dialog} className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
      <h2 className="sr-only" id="command-palette-title">Portcove commands</h2>
      <label className="palette-search">
        <Icon glyph={Search} />
        <input data-autofocus data-focusable role="combobox" aria-expanded="true" aria-autocomplete="list" aria-label="Search commands" value={query} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(index => Math.min(index + 1, filtered.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(index => Math.max(index - 1, 0)); }
            else if (event.key === "Enter" && filtered[activeIndex]) { event.preventDefault(); run(filtered[activeIndex]); }
          }}
          aria-controls="command-palette-results" aria-activedescendant={filtered[activeIndex] ? `command-${filtered[activeIndex].id}` : undefined}
          placeholder="Search actions and navigation" autoComplete="off" />
        <Shortcut>Esc</Shortcut>
      </label>
      <div className="palette-results" id="command-palette-results" role="listbox" aria-label="Available commands">
        {filtered.length === 0 ? <p className="palette-empty">No command matches “{query}”.</p> : filtered.map((command, index) =>
          <button id={`command-${command.id}`} role="option" aria-selected={activeIndex === index} data-focusable key={command.id}
            ref={activeIndex === index ? activeCommand : undefined} onFocus={() => setActiveIndex(index)}
            className={activeIndex === index ? "palette-command active" : "palette-command"} disabled={command.disabled}
            onMouseEnter={() => setActiveIndex(index)} onClick={() => run(command)}>
            <span className="palette-command-icon"><Icon glyph={command.icon} /></span>
            <span><strong>{command.label}</strong><small>{command.description}</small></span>
            {command.shortcut && <Shortcut>{command.shortcut}</Shortcut>}
          </button>)}
      </div>
      <footer className="palette-footer"><NavigationHints /></footer>
    </section>
  </div>;
}

export function filterCommands(commands: PaletteCommand[], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return commands;
  return commands.filter(command => {
    const haystack = `${command.label} ${command.description} ${command.keywords ?? ""}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
