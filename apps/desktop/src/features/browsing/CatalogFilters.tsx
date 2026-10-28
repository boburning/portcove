import {
  useRef,
  useState,
  useId,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
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
import { Chip, ChipButton } from "../../components/ui/chip";
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

import { Checkbox } from "../../components/ui/checkbox";
import { CompactFilterField } from "../../components/ui/field";

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
const commonGroups: readonly Group[] = [
  "platforms",
  "originalSystems",
  "channels",
  "portOptions",
  "membership",
  "gameFiles",
];
interface FilterGroup {
  key: Group;
  label: string;
  values: readonly string[];
}

export function queryFromFilter(filter: Filter | CatalogQuery): CatalogQuery {
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
  before,
  after,
  summary,
  advanced,
}: {
  advanced?: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
  summary?: ReactNode;
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
    selected.some(({ group }) => !commonGroups.includes(group)) || additional;
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
    <div className="catalog-query w-full min-w-0" data-focus-group>
      <div className="browse-toolbar flex flex-wrap items-center gap-2">
        {before}
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
        {after}
      </div>
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
          <details className="my-2 text-sm text-pc-muted-foreground">
            <summary className="cursor-pointer py-1">How filters work</summary>
            <p>
              Choose one or more options. Results match at least one option in each selected group.
            </p>
          </details>
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
            {commonGroups.map((key) => groups.find((group) => group.key === key)!).map(renderGroup)}
          </div>
          <details
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer py-2 font-medium">Advanced filters</summary>
            <p className="text-sm text-pc-muted-foreground">
              Route-dependent filters must match the same setup or installation. Unknown facts
              remain unknown.
            </p>
            <div className="catalog-filter-groups items-start pt-3">
              {advanced}
              {gameFileQuery && <GameFileFilterControls state={gameFileQuery} />}
              {groups.filter((group) => !commonGroups.includes(group.key)).map(renderGroup)}
            </div>
          </details>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              data-focusable
              variant="ghost"
              onClick={() => {
                setFilter("all");
              }}
            >
              Clear filters
            </Button>
            <Button data-focusable variant="outline" onClick={close}>
              Done
            </Button>
          </div>
        </section>
      )}
      <div className="browse-filter-summary mt-3 flex flex-wrap items-center gap-2 text-xs text-pc-muted-foreground">
        {summary}
        {Boolean(result.unavailablePortIds?.length) && (
          <p role="status" className="basis-full text-xs text-pc-muted-foreground">
            {result.unavailablePortIds?.length} projects have unknown facts for these filters.
            Choose All ports or clear these filters to find them.
          </p>
        )}
        {supported &&
          selected.map(({ group, value }) => (
            <ChipButton
              style={identityStyle(
                group === "platforms" ? (value.split("-")[0] ?? value) : value,
                group === "channels",
              )}
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
              {["originalSystems", "platforms", "channels"].includes(group) && (
                <IdentityIcon
                  name={group === "platforms" ? (value.split("-")[0] ?? value) : value}
                  channel={group === "channels"}
                />
              )}
              {groups.find((item) => item.key === group)?.label}: {label(group, value)}{" "}
              <X aria-hidden="true" />
            </ChipButton>
          ))}
        {!open && activeCount > 0 && (
          <Button
            data-focusable
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilter("all");
              trigger.current?.focus();
            }}
          >
            Clear filters
          </Button>
        )}
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
    </div>
  );

  function renderGroup(group: FilterGroup) {
    const chosen = supported ? (query[group.key] ?? []) : [];
    const help: Partial<Record<Group, string>> = {
      platforms:
        "Package targets, not tested device compatibility. For this device uses this PC’s platform; Intel and Apple silicon remain distinct.",
      membership:
        "Includes managed installations, registered runtimes and downloads awaiting setup. Membership does not imply readiness.",
      updates:
        "Uses the current installation’s last check and matching verified staged update. Choosing a filter does not check for updates.",
      gameFiles:
        "Uses the same setup or installation as your other filters. Changed or unreadable files need checking; they are not counted as missing.",
      attention: "Recorded needs for the current installation. Unavailable details remain unknown.",
    };
    return (
      <CompactFilterField
        key={group.key}
        label={group.label}
        value={
          !supported
            ? "Review restored query"
            : chosen.length > 1
              ? `${chosen.length} selected`
              : chosen.length
                ? label(group.key, chosen[0]!)!
                : "All"
        }
        help={help[group.key]}
      >
        {group.values.map((value) => {
          const count = candidates === undefined ? null : result.counts[group.key][value];
          const unknown = result.unknownCounts?.[group.key][value] ?? 0;
          const countText =
            count == null
              ? "unavailable"
              : unknown > 0
                ? `${count} known; ${unknown} unknown`
                : String(count);
          const text = label(group.key, value);
          const optionId = `${panelId}:${group.key}:${value}`;
          return (
            <label
              key={value}
              htmlFor={optionId}
              className="flex min-w-0 cursor-pointer items-start gap-2 rounded-pc-sm p-2 hover:bg-pc-secondary"
            >
              <Checkbox
                id={optionId}
                data-focusable
                aria-label={`${text} (${countText})`}
                checked={supported && query[group.key]?.includes(value) === true}
                disabled={!editable || result.counts[group.key][value] === null}
                onCheckedChange={() => toggle(group.key, value)}
              />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                <Chip
                  style={identityStyle(
                    group.key === "platforms" ? (value.split("-")[0] ?? value) : value,
                    group.key === "channels",
                  )}
                >
                  {["originalSystems", "platforms", "channels"].includes(group.key) && (
                    <IdentityIcon
                      name={group.key === "platforms" ? (value.split("-")[0] ?? value) : value}
                      channel={group.key === "channels"}
                    />
                  )}
                  {text}
                </Chip>
                <span className="text-xs text-pc-muted-foreground">({countText})</span>
              </span>
            </label>
          );
        })}
      </CompactFilterField>
    );
  }
}
