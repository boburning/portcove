import {
  useRef,
  useState,
  useId,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ListFilter, X } from "lucide-react";
import type { CatalogEntry } from "./catalog-entry";
import {
  platformLabel,
  releaseChannelPresentation,
  installationMethodLabels,
  type Filter,
} from "../../view-model";
import { Button } from "../../components/ui/button";
import { ChipButton } from "../../components/ui/chip";
import { IdentityIcon } from "../identity/IdentityIcon";
import { identityLabel, identityStyle } from "../identity/identity-style";
import {
  evaluateCatalogQuery,
  sourceSystemOptions,
  type CatalogQuery,
  type CatalogQueryContext,
} from "./catalog-query";
import { states } from "./game-file-query-context";
import { GameFileFilterControls } from "./GameFileFilterControls";
import type { GameFileFilterState } from "./use-game-file-filter-context";

const fixedGroups = [
  {
    key: "platforms",
    label: "Target OS",
    values: ["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64", "this-device"],
  },
  { key: "portOptions", label: "Port options", values: ["single", "multiple"] },
  { key: "channels", label: "Release channels", values: ["stable", "beta", "rolling"] },
  {
    key: "installationMethods",
    label: "Setup methods",
    values: [
      "portable-package",
      "portable-recompilation",
      "staged-game-files",
      "referenced-disc",
      "generated-game-data",
      "upstream-setup",
      "managed-recompilation",
      "user-prepared-runtime",
    ],
  },
  { key: "membership", label: "Library membership", values: ["in-library", "not-in-library"] },
  { key: "updates", label: "Observed updates", values: ["available", "staged"] },
  {
    key: "gameFiles",
    label: "Game files for the observed route",
    values: [
      "files_available",
      "files_missing",
      "needs_checking",
      "no_files_required",
      "unavailable_context",
    ],
  },
  {
    key: "attention",
    label: "Installation attention",
    values: ["missing-source", "missing-bios", "missing-runtime", "repair-needed", "finish-setup"],
  },
] as const;
type Group = (typeof fixedGroups)[number]["key"] | "originalSystems";
interface FilterGroup {
  key: Group;
  label: string;
  values: readonly string[];
}

function queryFromFilter(filter: Filter | CatalogQuery): CatalogQuery {
  return typeof filter === "string"
    ? {
        version: ["all", "stable", "beta", "rolling"].includes(filter) ? 1 : 0,
        channels: ["stable", "beta", "rolling"].includes(filter) ? [filter] : [],
      }
    : filter;
}
function label(group: Group, value: string) {
  if (group === "originalSystems") return identityLabel(value);
  if (group === "portOptions") return value === "multiple" ? "Multiple ports" : "Single port";
  if (group === "installationMethods")
    return installationMethodLabels[value as keyof typeof installationMethodLabels];
  if (group === "platforms" && value === "this-device") return "For this device";
  if (group === "gameFiles") return states[value as keyof typeof states];
  if (group === "updates")
    return value === "available" ? "Available at last check" : "Matching update staged";
  if (group === "attention") {
    const labels: Record<string, string> = {
      "missing-source": "Missing game files",
      "missing-bios": "Missing BIOS",
      "missing-runtime": "Missing runtime",
      "repair-needed": "Repair needed",
      "finish-setup": "Finish setup",
    };
    return labels[value];
  }
  if (group === "membership") return value === "in-library" ? "In my library" : "Not in my library";
  return group === "platforms" ? platformLabel(value) : releaseChannelPresentation(value).label;
}

/** Presentation of declarations and Core observations; the evaluator owns matching/counts. */
export function CatalogFilters({
  candidates,
  context,
  filter,
  setFilter,
  gameFileQuery,
  view = "catalog",
}: {
  candidates?: readonly CatalogEntry[] | undefined;
  context?: CatalogQueryContext | undefined;
  view?: "catalog" | "library";
  filter: Filter | CatalogQuery;
  setFilter: Dispatch<SetStateAction<Filter | CatalogQuery>>;
  gameFileQuery?: GameFileFilterState | undefined;
}) {
  const groups: FilterGroup[] = [
    {
      key: "originalSystems",
      label: "Original system",
      values: sourceSystemOptions(candidates ?? [], filter),
    },
    ...fixedGroups,
  ];
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !panel.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, close]);
  const query = queryFromFilter(filter);
  const result = evaluateCatalogQuery(candidates ?? [], query, context);
  const editable = result.state === "matched";
  const supported = result.state !== "unresolved";
  const selected = supported
    ? groups.flatMap((group) =>
        group.values
          .filter((value) => query[group.key]?.includes(value))
          .map((value) => ({ group: group.key, value })),
      )
    : [];
  const additionalCount = !supported
    ? 0
    : Object.entries(query).reduce(
        (count, [key, values]) =>
          count +
          (!["version", ...groups.map((group) => group.key)].includes(key) && Array.isArray(values)
            ? new Set(values).size
            : 0),
        0,
      );
  const additional = additionalCount > 0;
  const hasAdvancedSelection =
    selected.some(
      ({ group }) =>
        !["originalSystems", "platforms", "channels", "membership", "portOptions"].includes(group),
    ) || additional;
  const [advancedOpen, setAdvancedOpen] = useState(hasAdvancedSelection);
  const activeCount = selected.length + additionalCount;
  const remove = (group: Group, value: string) =>
    setFilter((current) => {
      const next = queryFromFilter(current);
      if (evaluateCatalogQuery([], next, context).state === "unresolved") return current;
      return { ...next, [group]: (next[group] ?? []).filter((item) => item !== value) };
    });
  const toggle = (group: Group, value: string) =>
    setFilter((current) => {
      const next = queryFromFilter(current);
      if (evaluateCatalogQuery([], next, context).state !== "matched") return current;
      const values = next[group] ?? [];
      return {
        ...next,
        [group]: values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value],
      };
    });
  return (
    <div className="flex flex-wrap items-center gap-2" data-focus-group>
      <Button
        ref={trigger}
        data-focusable
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setAdvancedOpen((current) => current || hasAdvancedSelection);
          setOpen((current) => !current);
        }}
      >
        <ListFilter /> Filters ({activeCount})
      </Button>
      {open && (
        <section
          ref={panel}
          id={panelId}
          className="catalog-filter-panel basis-full"
          aria-label="Filter options"
        >
          <h2 ref={heading} tabIndex={-1}>
            {view === "library" ? "Library" : "Discover"} filters
          </h2>
          <p className="text-sm text-pc-muted-foreground">
            Choose any matching option within a group. A game must match every selected group for
            the same setup or installation to appear.
          </p>
          {!editable && (
            <p role="alert">
              {result.state === "unresolved"
                ? "These restored filters are not supported."
                : "These restored filters need unavailable local context."}{" "}
              Reset {view} filters to choose a supported query.
            </p>
          )}
          {additional && (
            <p role="status">
              Additional restored filters remain active. Reset {view} filters to remove them.
            </p>
          )}
          <div className="catalog-filter-groups items-start">
            {groups
              .filter((group) =>
                ["originalSystems", "platforms", "channels", "membership", "portOptions"].includes(
                  group.key,
                ),
              )
              .map(renderGroup)}
          </div>
          <details
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer py-2 font-medium">Advanced filters</summary>
            <div className="catalog-filter-groups items-start pt-3">
              {gameFileQuery && <GameFileFilterControls state={gameFileQuery} />}
              {groups
                .filter(
                  (group) =>
                    ![
                      "originalSystems",
                      "platforms",
                      "channels",
                      "membership",
                      "portOptions",
                    ].includes(group.key),
                )
                .map(renderGroup)}
            </div>
          </details>
          <div className="flex flex-wrap justify-end gap-2">
            <Button data-focusable variant="ghost" onClick={() => setFilter("all")}>
              Clear filters
            </Button>
            <Button data-focusable variant="outline" onClick={close}>
              Done
            </Button>
          </div>
        </section>
      )}
      {Boolean(result.unavailablePortIds?.length) && (
        <p role="status" className="basis-full text-xs text-pc-muted-foreground">
          {result.unavailablePortIds?.length} projects have unknown facts for these filters. Choose
          All ports or clear these filters to find them.
        </p>
      )}
      {supported &&
        selected.map(({ group, value }) => (
          <ChipButton
            style={identityStyle(value, group === "channels")}
            key={`${group}:${value}`}
            data-focusable
            size="sm"
            variant="selected"
            aria-label={`Remove ${label(group, value)} filter`}
            onClick={(event) => {
              const ownedFocus = document.activeElement === event.currentTarget;
              remove(group, value);
              if (ownedFocus) trigger.current?.focus();
            }}
          >
            {label(group, value)} <X aria-hidden="true" />
          </ChipButton>
        ))}
      {!editable && (
        <p role="status" className="text-sm text-pc-muted-foreground">
          Open Filters to review or reset the restored query.
        </p>
      )}
      {additional && (
        <p role="status" className="text-sm text-pc-muted-foreground">
          Additional restored filters are active; open Filters to review or reset them.
        </p>
      )}
    </div>
  );

  function renderGroup(group: FilterGroup) {
    return (
      <fieldset key={group.key} className="grid min-w-0 content-start items-start gap-2">
        <legend className="mb-2 font-medium">{group.label}</legend>
        {group.key === "platforms" && (
          <p>
            Platforms describe release targets, not tested compatibility. For this device uses this
            PC’s platform.
          </p>
        )}
        {group.key === "membership" && (
          <p>
            Includes managed installations, registered runtimes and downloads awaiting setup in this
            library. Readiness may still need checking.
          </p>
        )}
        {group.key === "updates" && (
          <p>
            Uses the last check for the current installation. A matching staged update is downloaded
            and verified. Filtering does not check for newer releases.
          </p>
        )}
        {group.key === "gameFiles" && (
          <p>
            Uses the same setup or installation as your other filters. Changed or unreadable files
            need checking; they are not counted as missing.
          </p>
        )}
        {group.key === "attention" && (
          <p>
            Shows recorded needs for the current installation. Unavailable details remain unknown.
          </p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          {group.values.map((value) => (
            <ChipButton
              style={identityStyle(
                group.key === "platforms" ? (value.split("-")[0] ?? value) : value,
                group.key === "channels",
              )}
              key={value}
              data-focusable
              size="sm"
              variant={supported && query[group.key]?.includes(value) ? "selected" : "outline"}
              aria-pressed={supported && query[group.key]?.includes(value) === true}
              disabled={!editable || result.counts[group.key][value] === null}
              onClick={() => toggle(group.key, value)}
            >
              {["originalSystems", "platforms", "channels"].includes(group.key) && (
                <IdentityIcon
                  name={group.key === "platforms" ? (value.split("-")[0] ?? value) : value}
                  channel={group.key === "channels"}
                />
              )}
              {label(group.key, value)} (
              {candidates === undefined
                ? "unavailable"
                : (result.counts[group.key][value] ?? "unavailable")}
              {candidates !== undefined &&
                result.counts[group.key][value] != null &&
                (result.unknownCounts?.[group.key][value] ?? 0) > 0 && (
                  <> known; {result.unknownCounts?.[group.key][value]} unknown</>
                )}
              )
            </ChipButton>
          ))}
        </div>
      </fieldset>
    );
  }
}
