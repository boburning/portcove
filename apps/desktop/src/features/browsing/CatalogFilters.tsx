import { useRef, type Dispatch, type SetStateAction } from "react";
import { ListFilter, X } from "lucide-react";
import type { PortDefinition } from "../../types";
import { platformLabel, releaseChannelPresentation, type Filter } from "../../view-model";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { evaluateCatalogQuery, type CatalogQuery, type CatalogQueryContext } from "./catalog-query";

const groups = [
  {
    key: "platforms",
    label: "Declared platforms",
    values: ["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"],
  },
  { key: "channels", label: "Release channels", values: ["stable", "beta", "rolling"] },
  { key: "membership", label: "Library membership", values: ["in-library", "not-in-library"] },
] as const;
type Group = (typeof groups)[number]["key"];

function queryFromFilter(filter: Filter | CatalogQuery): CatalogQuery {
  return typeof filter === "string"
    ? {
        version: ["all", "stable", "beta", "rolling"].includes(filter) ? 1 : 0,
        channels: ["stable", "beta", "rolling"].includes(filter) ? [filter] : [],
      }
    : filter;
}
function label(group: Group, value: string) {
  if (group === "membership") return value === "in-library" ? "In my library" : "Not in my library";
  return group === "platforms" ? platformLabel(value) : releaseChannelPresentation(value).label;
}

/** Presentation of declared facts only; the existing evaluator owns matching/counts. */
export function CatalogFilters({
  candidates,
  context,
  filter,
  setFilter,
  view = "catalog",
}: {
  candidates?: readonly PortDefinition[];
  context?: CatalogQueryContext;
  view?: "catalog" | "library";
  filter: Filter | CatalogQuery;
  setFilter: Dispatch<SetStateAction<Filter | CatalogQuery>>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
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
    <div className="mb-4 flex flex-wrap items-center gap-2" data-focus-group>
      <Dialog>
        <DialogTrigger render={<Button ref={trigger} data-focusable variant="outline" size="sm" />}>
          <ListFilter /> Filters ({activeCount})
        </DialogTrigger>
        <DialogContent finalFocus={trigger}>
          <DialogTitle>{view === "library" ? "Library" : "Catalog"} filters</DialogTitle>
          <DialogDescription>
            Match any selected value in each group and all groups together. Platforms describe
            catalog targets; they do not confirm installation compatibility. Library membership
            means an active managed installation or a registered external runtime in the selected
            library; it does not confirm readiness.
            {view === "library" &&
              " Ready with Linux means current Library readiness and a declared Linux target, not a ready Linux installation."}
          </DialogDescription>
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
          {groups.map((group) => (
            <fieldset key={group.key} className="grid gap-2">
              <legend className="mb-2 font-medium">{group.label}</legend>
              <div className="flex flex-wrap gap-2">
                {group.values.map((value) => (
                  <Button
                    key={value}
                    data-focusable
                    size="sm"
                    variant={
                      supported && query[group.key]?.includes(value) ? "selected" : "outline"
                    }
                    aria-pressed={supported && query[group.key]?.includes(value) === true}
                    disabled={
                      !editable ||
                      (group.key === "membership" && result.counts.membership[value] === null)
                    }
                    onClick={() => toggle(group.key, value)}
                  >
                    {label(group.key, value)} (
                    {candidates === undefined
                      ? "unavailable"
                      : (result.counts[group.key][value] ?? "unavailable")}
                    )
                  </Button>
                ))}
              </div>
            </fieldset>
          ))}
          <Button data-focusable variant="outline" onClick={() => setFilter("all")}>
            Reset {view} filters
          </Button>
        </DialogContent>
      </Dialog>
      {supported &&
        selected.map(({ group, value }) => (
          <Button
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
            {label(group, value)} <X />
          </Button>
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
}
