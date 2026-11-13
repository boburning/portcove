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
  filterOptionsFor,
  type CatalogQuery,
  type CatalogQueryContext,
} from "./catalog-query";
import type { TFunction } from "i18next";
import { useAppTranslation } from "../../localization";
import { gameFileStateLabel } from "./game-file-query-context";
import { isQuickViewUpdateSelection } from "./quick-view-updates";
import { GameFileFilterControls } from "./GameFileFilterControls";
import type { GameFileFilterState } from "./use-game-file-filter-context";

import { Checkbox } from "../../components/ui/checkbox";
import { CompactFilterField } from "../../components/ui/field";

const fixedGroups = [
  { key: "platforms" },
  { key: "portOptions" },
  { key: "channels" },
  { key: "installationMethods" },
  { key: "membership" },
  { key: "updates" },
  { key: "gameFiles" },
  { key: "attention" },
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
const libraryPrimaryGroups: readonly Group[] = ["platforms", "originalSystems", "channels"];
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
function label(t: TFunction<"gameFiles">, group: Group, value: string) {
  if (group === "originalSystems") return identityLabel(value);
  if (group === "portOptions")
    return value === "multiple" ? t("filters.value.multiplePorts") : t("filters.value.singlePort");
  if (group === "installationMethods")
    return installationMethodLabels[value as keyof typeof installationMethodLabels] ?? value;
  if (group === "platforms" && value === "this-device") return t("filters.value.thisDevice");
  if (group === "gameFiles")
    return gameFileStateLabel(t, value as Parameters<typeof gameFileStateLabel>[1]);
  if (group === "updates")
    return value === "available"
      ? t("filters.value.updateAvailable")
      : t("filters.value.updateStaged");
  if (group === "attention") return attentionLabel(t, value);
  if (group === "membership")
    return value === "in-library" ? t("filters.value.inLibrary") : t("filters.value.notInLibrary");
  return group === "platforms" ? platformLabel(value) : releaseChannelPresentation(value).label;
}

function attentionLabel(t: TFunction<"gameFiles">, value: string) {
  switch (value) {
    case "missing-source":
      return t("filters.value.missingSource");
    case "missing-bios":
      return t("filters.value.missingBios");
    case "missing-runtime":
      return t("filters.value.missingRuntime");
    case "repair-needed":
      return t("filters.value.repairNeeded");
    case "finish-setup":
      return t("filters.value.finishSetup");
    default:
      return undefined;
  }
}

function groupLabel(t: TFunction<"gameFiles">, group: Group): string {
  switch (group) {
    case "originalSystems":
      return t("filters.group.originalSystems");
    case "platforms":
      return t("filters.group.platforms");
    case "portOptions":
      return t("filters.group.portOptions");
    case "channels":
      return t("filters.group.channels");
    case "installationMethods":
      return t("filters.group.installationMethods");
    case "membership":
      return t("filters.group.membership");
    case "updates":
      return t("filters.group.updates");
    case "gameFiles":
      return t("filters.group.gameFiles");
    case "attention":
      return t("filters.group.attention");
  }
}

function SelectedFilterChip({
  group,
  value,
  groupLabel,
  remove,
  restoreFocus,
}: {
  group: Group;
  value: string;
  groupLabel: string;
  remove: (group: Group, value: string) => void;
  restoreFocus: () => void;
}) {
  const { t } = useAppTranslation("gameFiles");
  const valueLabel = label(t, group, value) ?? value;
  return (
    <ChipButton
      style={group === "platforms" ? undefined : identityStyle(value, group === "channels")}
      data-focusable
      size="sm"
      variant="selected"
      aria-label={t("filters.removeChip", { group: groupLabel, value: valueLabel })}
      onClick={(event) => {
        const ownedFocus = document.activeElement === event.currentTarget;
        remove(group, value);
        if (ownedFocus) restoreFocus();
      }}
    >
      {["originalSystems", "platforms", "channels"].includes(group) && (
        <IdentityIcon
          name={group === "platforms" ? (value.split("-")[0] ?? value) : value}
          channel={group === "channels"}
        />
      )}
      {t("filters.chip", { group: groupLabel, value: valueLabel })} <X aria-hidden="true" />
    </ChipButton>
  );
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
  quickViewUpdates = false,
}: {
  advanced?: ReactNode;
  /** The Library Updates quick view owns its update selection; show no chips for it. */
  quickViewUpdates?: boolean;
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
  const { t } = useAppTranslation("gameFiles");
  const groups: FilterGroup[] = [
    {
      key: "originalSystems",
      label: groupLabel(t, "originalSystems"),
      values: sourceSystemOptions(candidates ?? [], filter),
    },
    ...fixedGroups.map((group) => ({
      ...group,
      label: groupLabel(t, group.key),
      values: filterOptionsFor(group.key, candidates ?? [], queryFromFilter(filter), context),
    })),
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
  const quickViewOwnsUpdates = quickViewUpdates && isQuickViewUpdateSelection(query.updates);
  const selected = supported
    ? groups.flatMap((group) =>
        quickViewOwnsUpdates && group.key === "updates"
          ? []
          : group.values
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
  const primaryGroups = view === "library" ? libraryPrimaryGroups : commonGroups;
  const hasAdvancedSelection =
    selected.some(({ group }) => !primaryGroups.includes(group)) || additional;
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
          aria-label={t("filters.triggerLabel", { total: activeCount })}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setAdvancedOpen((current) => current || hasAdvancedSelection);
            setOpen((current) => !current);
          }}
        >
          <ListFilter /> {t("filters.trigger")}
          {activeCount > 0 && (
            <>
              {" "}
              <span aria-hidden="true" className="catalog-filter-count">
                ({activeCount})
              </span>
            </>
          )}
        </Button>
        {after}
      </div>
      {open && (
        <section
          ref={panel}
          id={panelId}
          className="catalog-filter-panel basis-full"
          data-view={view}
          aria-label={t("filters.panelLabel")}
        >
          <div className="catalog-filter-heading">
            <h2 ref={heading} tabIndex={-1}>
              {view === "library" ? t("filters.headingLibrary") : t("filters.headingDiscover")}
            </h2>
            <details className="my-2 text-sm text-pc-muted-foreground">
              <summary className="cursor-pointer py-1">{t("filters.howSummary")}</summary>
              <p>{t("filters.howBody")}</p>
            </details>
          </div>
          {!editable && (
            <p role="alert">
              {result.state === "unresolved"
                ? view === "library"
                  ? t("filters.unsupportedLibrary")
                  : t("filters.unsupportedCatalog")
                : view === "library"
                  ? t("filters.needsContextLibrary")
                  : t("filters.needsContextCatalog")}
            </p>
          )}
          {additional && (
            <p role="status">
              {view === "library" ? t("filters.additionalLibrary") : t("filters.additionalCatalog")}
            </p>
          )}
          <div className="catalog-filter-groups items-start">
            {primaryGroups
              .map((key) => groups.find((group) => group.key === key)!)
              .map(renderGroup)}
          </div>
          <details
            className="catalog-filter-advanced"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer py-2 font-medium">{t("filters.advanced")}</summary>
            <p className="text-sm text-pc-muted-foreground">{t("filters.advancedNote")}</p>
            <div className="catalog-filter-groups items-start pt-3">
              {advanced}
              {gameFileQuery && <GameFileFilterControls state={gameFileQuery} />}
              {groups.filter((group) => !primaryGroups.includes(group.key)).map(renderGroup)}
            </div>
          </details>
          <div className="catalog-filter-actions flex flex-wrap justify-end gap-2">
            <Button
              data-focusable
              variant="ghost"
              onClick={() => {
                setFilter("all");
              }}
            >
              {t("filters.clear")}
            </Button>
            <Button data-focusable variant="outline" onClick={close}>
              {t("filters.done")}
            </Button>
          </div>
        </section>
      )}
      <div
        className="browse-filter-summary mt-3 flex flex-wrap items-center gap-2 text-xs text-pc-muted-foreground"
        data-view={view}
      >
        {view !== "library" && summary}
        <div className="browse-active-filters">
          {Boolean(result.unavailablePortIds?.length) && (
            <p role="status" className="basis-full text-xs text-pc-muted-foreground">
              {t("filters.unknownFacts", { count: result.unavailablePortIds?.length ?? 0 })}
            </p>
          )}
          {selected.map(({ group, value }) => (
            <SelectedFilterChip
              key={`${group}:${value}`}
              group={group}
              value={value}
              groupLabel={groups.find((item) => item.key === group)?.label ?? ""}
              remove={remove}
              restoreFocus={() => trigger.current?.focus()}
            />
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
              {t("filters.clear")}
            </Button>
          )}
          {!editable && (
            <p role="status" className="text-sm text-pc-muted-foreground">
              {t("filters.restoredNote")}
            </p>
          )}
          {additional && (
            <p role="status" className="text-sm text-pc-muted-foreground">
              {t("filters.additionalNote")}
            </p>
          )}
        </div>
        {view === "library" && summary}
      </div>
    </div>
  );

  function renderGroup(group: FilterGroup) {
    const chosen = supported ? (query[group.key] ?? []) : [];
    const help: Partial<Record<Group, string>> = {
      platforms: t("filters.help.platforms"),
      membership: t("filters.help.membership"),
      updates: t("filters.help.updates"),
      gameFiles: t("filters.help.gameFiles"),
      attention: t("filters.help.attention"),
    };
    return (
      <CompactFilterField
        key={group.key}
        label={group.label}
        value={
          !supported
            ? t("filters.reviewRestored")
            : chosen.length > 1
              ? t("filters.selectedCount", { total: chosen.length })
              : chosen.length
                ? label(t, group.key, chosen[0]!)!
                : t("filters.all")
        }
        help={help[group.key]}
      >
        {group.values.map((value) => {
          const count = candidates === undefined ? null : result.counts[group.key][value];
          const unknown = result.unknownCounts?.[group.key][value] ?? 0;
          const countText =
            count == null
              ? t("filters.countUnavailable")
              : unknown > 0
                ? t("filters.countKnownUnknown", { known: count, unknown })
                : String(count);
          const text = label(t, group.key, value);
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
                aria-label={t("filters.optionLabel", { option: text ?? value, amount: countText })}
                checked={supported && query[group.key]?.includes(value) === true}
                disabled={!editable || result.counts[group.key][value] === null}
                onCheckedChange={() => toggle(group.key, value)}
              />
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                <Chip
                  style={
                    group.key === "platforms"
                      ? undefined
                      : identityStyle(value, group.key === "channels")
                  }
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
