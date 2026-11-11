import { useId, useRef, useState } from "react";
import { FolderOpen, ListChecks } from "lucide-react";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { LauncherKind, LauncherLibraryEntry, LauncherLibraryInventory } from "../types";

const LAUNCHERS: readonly { kind: LauncherKind; label: string }[] = [
  { kind: "github-launcher", label: "GitHub Launcher" },
  { kind: "quiver", label: "Quiver" },
];

const STATUS_LABELS: Record<LauncherLibraryEntry["status"], string> = {
  "ready-to-review": "Ready to review",
  ambiguous: "Choose the game",
  "not-in-catalog": "Not in the catalog",
  "unrecognized-files": "Files not recognized",
  "adoption-unsupported": "Cannot be copied",
  "not-installed": "Not installed",
  "unsafe-path": "Location not checked",
  duplicate: "Listed twice",
};

/** Entries the existing adoption review can open: a folder and a matched game. */
export function launcherEntryCanBeReviewed(entry: LauncherLibraryEntry) {
  return (
    Boolean(entry.install_path) &&
    (entry.status === "ready-to-review" || entry.status === "ambiguous")
  );
}

/**
 * Lists another launcher's apps without changing them. Choosing an app only fills
 * the existing copy review, which still checks the folder and asks before copying.
 */
export function LauncherLibraryImport({
  disabled,
  inspect,
  pickFolder,
  choose,
}: {
  disabled: boolean;
  inspect: (
    launcher: LauncherKind,
    dataRoot: string,
    appsRoot?: string,
  ) => Promise<LauncherLibraryInventory | undefined>;
  pickFolder?: (currentPath: string) => Promise<string | null>;
  choose: (entry: LauncherLibraryEntry) => void;
}) {
  const id = useId();
  const [launcher, setLauncher] = useState<LauncherKind>("github-launcher");
  const [dataRoot, setDataRoot] = useState("");
  const [appsRoot, setAppsRoot] = useState("");
  const [inventory, setInventory] = useState<LauncherLibraryInventory>();
  const [listing, setListing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef(0);
  const summaryRef = useRef<HTMLElement>(null);
  const reset = () => {
    request.current += 1;
    setInventory(undefined);
  };
  const list = async () => {
    const current = ++request.current;
    setListing(true);
    try {
      const result = await inspect(launcher, dataRoot.trim(), appsRoot.trim() || undefined);
      if (current === request.current) setInventory(result);
    } finally {
      if (current === request.current) setListing(false);
    }
  };
  const status = listing ? "Listing apps…" : inventory ? inventorySummary(inventory) : "";
  // An override stays visible while it is in use, so it never applies unseen.
  const needsAppsRoot =
    appsRoot.trim() !== "" ||
    (inventory !== undefined &&
      (inventory.apps_root_origin === "unresolved" ||
        inventory.entries.some((entry) => entry.status === "not-installed")));
  const launcherLabel = LAUNCHERS.find((item) => item.kind === launcher)?.label ?? "launcher";
  return (
    <details
      className="mb-4 rounded-pc-md border border-[var(--color-border)] p-3"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary ref={summaryRef} className="cursor-pointer font-medium">
        Moving from GitHub Launcher or Quiver?
      </summary>
      <p className="mt-2 text-[var(--color-text-secondary)]">
        Portcove reads that launcher&apos;s list of apps and leaves it unchanged. Choose an app to
        review copying it.
      </p>
      <div role="group" aria-label="Launcher" className="mb-3 flex flex-wrap gap-2">
        {LAUNCHERS.map((item) => (
          <Button
            key={item.kind}
            data-focusable
            type="button"
            variant={launcher === item.kind ? "primary" : "outline"}
            aria-pressed={launcher === item.kind}
            disabled={disabled || listing}
            onClick={() => {
              setLauncher(item.kind);
              setAppsRoot("");
              reset();
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <label htmlFor={`${id}-data-root`}>{launcherLabel} data folder</label>
      <p
        id={`${id}-data-root-hint`}
        className="text-[length:var(--text-xs)] text-[var(--color-text-secondary)]"
      >
        The folder that holds its apps.json and settings.json.
      </p>
      <div className="flex items-stretch gap-2 [&_input]:min-w-0">
        <Input
          data-focusable
          id={`${id}-data-root`}
          aria-describedby={`${id}-data-root-hint`}
          value={dataRoot}
          disabled={disabled || listing}
          onChange={(event) => {
            setDataRoot(event.target.value);
            setAppsRoot("");
            reset();
          }}
          placeholder="Choose or paste the full folder path"
        />
        {pickFolder && (
          <Button
            data-focusable
            type="button"
            variant="outline"
            disabled={disabled || listing}
            onClick={() => {
              void pickFolder(dataRoot).then((path) => {
                if (path) {
                  setDataRoot(path);
                  setAppsRoot("");
                  reset();
                }
              });
            }}
          >
            <Icon glyph={FolderOpen} />
            Browse
          </Button>
        )}
      </div>
      <Button
        data-focusable
        type="button"
        variant="outline"
        className="mt-3"
        disabled={disabled || listing || !dataRoot.trim()}
        onClick={() => {
          void list();
        }}
      >
        <Icon glyph={ListChecks} />
        {listing ? "Listing apps…" : "List apps"}
      </Button>
      {needsAppsRoot && (
        <div className="mb-3">
          <label htmlFor={`${id}-apps-root`}>Apps folder, if it moved</label>
          <p
            id={`${id}-apps-root-hint`}
            className="text-[length:var(--text-xs)] text-[var(--color-text-secondary)]"
          >
            Choose where the launcher&apos;s apps are now, then list the apps again.
          </p>
          <div className="flex items-stretch gap-2 [&_input]:min-w-0">
            <Input
              data-focusable
              id={`${id}-apps-root`}
              aria-describedby={`${id}-apps-root-hint`}
              value={appsRoot}
              disabled={disabled || listing}
              onChange={(event) => setAppsRoot(event.target.value)}
              placeholder="Choose or paste the full folder path"
            />
            {pickFolder && (
              <Button
                data-focusable
                type="button"
                variant="outline"
                disabled={disabled || listing}
                onClick={() => {
                  void pickFolder(appsRoot).then((path) => {
                    if (path) setAppsRoot(path);
                  });
                }}
              >
                <Icon glyph={FolderOpen} />
                Browse
              </Button>
            )}
          </div>
          <Button
            data-focusable
            type="button"
            variant="outline"
            className="mt-2"
            disabled={disabled || listing || !appsRoot.trim()}
            onClick={() => {
              void list();
            }}
          >
            <Icon glyph={ListChecks} />
            List apps again
          </Button>
        </div>
      )}
      <p aria-live="polite" className="mt-3 text-[var(--color-text-secondary)]">
        {status}
      </p>
      {inventory && (
        <section aria-label={`Apps in ${launcherLabel}`} className="mt-3">
          {inventory.apps_root_origin === "unresolved" && (
            <p role="note" className="text-[var(--color-warning-text)]">
              The launcher&apos;s apps folder could not be read from its settings, so apps listed by
              folder name were not checked.
            </p>
          )}
          <ul className="grid gap-2 ps-0" aria-label="Launcher apps">
            {inventory.entries.map((entry) => (
              <li
                key={entry.index}
                className="list-none rounded-pc-md border border-[var(--color-border)] p-2 [overflow-wrap:anywhere]"
              >
                <strong>{entry.name || entry.folder_name}</strong> — {STATUS_LABELS[entry.status]}
                <br />
                <small className="text-[var(--color-text-secondary)]">{entry.explanation}</small>
                {entryDetails(entry).map((detail) => (
                  <span key={detail}>
                    <br />
                    <small className="text-[var(--color-text-secondary)]">{detail}</small>
                  </span>
                ))}
                {entry.not_carried_over.length > 0 && (
                  <>
                    <br />
                    <small className="text-[var(--color-text-secondary)]">
                      Not carried over: {entry.not_carried_over.join(", ")}
                    </small>
                  </>
                )}
                {launcherEntryCanBeReviewed(entry) && (
                  <div>
                    <Button
                      data-focusable
                      type="button"
                      variant="outline"
                      className="mt-2"
                      disabled={disabled}
                      onClick={() => {
                        // Collapse the list so the copy review below is next; it stays available
                        // from the summary, which keeps keyboard and controller focus.
                        setExpanded(false);
                        summaryRef.current?.focus();
                        choose(entry);
                      }}
                    >
                      Review copying {entry.name || entry.folder_name}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}

/** Complete per-count messages; English suffixes are never appended. */
function inventorySummary(inventory: LauncherLibraryInventory) {
  const listed = inventory.entries.length;
  const ready = inventory.entries.filter((entry) => entry.status === "ready-to-review").length;
  const skipped = inventory.skipped_entries.length;
  const parts = [
    listed === 0 ? "No apps listed" : listed === 1 ? "1 app listed" : `${listed} apps listed`,
    ready === 0 ? "none ready to review" : `${ready} ready to review`,
  ];
  if (skipped === 1) parts.push("1 unreadable entry skipped");
  else if (skipped > 1) parts.push(`${skipped} unreadable entries skipped`);
  return parts.join(" · ");
}

const SHOWN_USER_DATA_PATHS = 5;

/** What the inventory found for an app; labels and mod records are never trusted. */
export function entryDetails(entry: LauncherLibraryEntry): string[] {
  const details: string[] = [];
  const paths = entry.user_data_paths;
  if (paths.length > 0) {
    const shown = paths.slice(0, SHOWN_USER_DATA_PATHS).join(", ");
    const more = paths.length - SHOWN_USER_DATA_PATHS;
    details.push(
      more > 0
        ? `Saves and settings found: ${shown}, and ${more === 1 ? "1 more" : `${more} more`}`
        : `Saves and settings found: ${shown}`,
    );
  }
  if (entry.mods) {
    const records = entry.mods.records;
    details.push(
      !entry.mods.readable
        ? "Launcher mod records could not be read"
        : records === 0
          ? "No launcher mod records"
          : records === 1
            ? "1 launcher mod record, listed only; it is not copied as a mod or turned on"
            : `${records} launcher mod records, listed only; they are not copied as mods or turned on`,
    );
  }
  if (entry.hints.installed_version_label)
    details.push(`Installed version label: ${entry.hints.installed_version_label} (not verified)`);
  if (entry.hints.preferred_version)
    details.push(`Launcher version setting: ${entry.hints.preferred_version} (not verified)`);
  return details;
}
