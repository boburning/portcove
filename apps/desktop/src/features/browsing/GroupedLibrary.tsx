import { Fragment, useRef, type ReactNode } from "react";
import type { PortStatus } from "../../types";
import { Button } from "../../components/ui/button";
import { gameProjectLabel, gameTitle } from "../../port-identity";
import type { Organization } from "../organization/OrganizationControls";
import type { CatalogEntry } from "./catalog-entry";
import { groupCatalog, type GameGroup } from "./original-game";
import { resolveGameChoice } from "./game-choice";
import { ImplementationChoice, ownsChoiceFocus } from "./ImplementationChoice";
import { ImplementationFacts } from "./GameAlternatives";
import type { CollectionLayout } from "./use-collection-layout";
import { ArtworkFrame } from "../../components/Artwork";
import { useArtwork, useArtworkVisibility } from "../../artwork";

/** Group presentation never rewrites the port/install identity of an action. */
export function GroupedLibrary({
  all,
  matching,
  statuses,
  organization,
  renderPort,
  onSelect,
  layout = "covers",
}: {
  all: readonly CatalogEntry[];
  matching: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  organization?: Organization | undefined;
  renderPort: (port: CatalogEntry) => ReactNode;
  onSelect: (portId: string, originKey?: string) => void;
  layout?: CollectionLayout;
}) {
  return groupCatalog(all, matching).map((group) =>
    group.ports.length === 1 &&
    resolveGameChoice(
      group,
      statuses,
      organization?.snapshot ? (organization.snapshot.preferred_port_by_game ?? {}) : undefined,
    ).reason !== "stale" ? (
      <Fragment key={group.id}>{renderPort(group.matchingPorts[0]!)}</Fragment>
    ) : (
      <LibraryGame
        key={group.id}
        {...{ group, statuses, organization, renderPort, onSelect, layout }}
      />
    ),
  );
}

function LibraryGame({
  group,
  statuses,
  organization,
  renderPort,
  onSelect,
  layout,
}: {
  group: GameGroup;
  statuses: ReadonlyMap<string, PortStatus>;
  organization: Organization | undefined;
  renderPort: (port: CatalogEntry) => ReactNode;
  onSelect: (portId: string, originKey?: string) => void;
  layout: CollectionLayout;
}) {
  const preferences = organization?.snapshot?.preferred_port_by_game;
  const root = useRef<HTMLElement>(null);
  const restore = (trigger: HTMLButtonElement) =>
    window.requestAnimationFrame(() => {
      if (ownsChoiceFocus(trigger, root.current)) root.current?.focus();
    });
  const choice = resolveGameChoice(
    group,
    statuses,
    organization?.snapshot ? (preferences ?? {}) : undefined,
  );
  const first = group.matchingPorts[0]!;
  return (
    <section
      ref={root}
      tabIndex={-1}
      className="min-w-0"
      aria-label={`${gameTitle(first)} implementations`}
      data-library-game-id={group.id}
      data-detail-return-group={group.id}
    >
      {choice.port ? (
        renderPort(choice.port)
      ) : (
        <LibraryChoicePrompt {...{ group, first, choice, layout, organization, restore }} />
      )}
      <details className="mt-2 rounded-pc-md border border-pc-border px-3 py-2 text-sm">
        <summary data-focusable className="cursor-pointer">
          All {group.ports.length} implementations · {group.matchingPorts.length} matching
        </summary>
        <p className="my-2 text-xs text-pc-muted-foreground">
          Choosing a project does not select a release, transfer saves or replace another
          installation.
        </p>
        {group.ports.map((port) => (
          <div key={port.id} className="grid gap-2 border-t border-pc-border py-3">
            <p>
              {gameProjectLabel(port) || port.name}
              {choice.preferredPortId === port.id ? " · Your choice" : ""}
              {!group.matchingPorts.some((match) => match.id === port.id)
                ? " · Outside current filters"
                : ""}
            </p>
            <ImplementationFacts port={port} status={statuses.get(port.id)} />
            <ImplementationChoice port={port} organization={organization} onSelected={restore} />
            <Button
              variant="ghost"
              size="sm"
              data-focusable
              data-detail-origin={`library:alternative:${port.id}`}
              onClick={() => onSelect(port.id, `library:alternative:${port.id}`)}
            >
              View {gameProjectLabel(port) || port.name}
            </Button>
          </div>
        ))}
      </details>
      {organization?.failure === "read" && (
        <p role="status" className="mt-2 text-xs text-pc-warning-foreground">
          Your implementation choice could not be read. Existing installation actions remain
          available.
        </p>
      )}
    </section>
  );
}

function LibraryChoicePrompt({
  group,
  first,
  choice,
  layout,
  organization,
  restore,
}: {
  group: GameGroup;
  first: CatalogEntry;
  choice: ReturnType<typeof resolveGameChoice>;
  layout: CollectionLayout;
  organization: Organization | undefined;
  restore: (trigger: HTMLButtonElement) => void;
}) {
  const { element, visible } = useArtworkVisibility();
  const { display } = useArtwork(first.id, "cover", visible);
  return (
    <article
      className={`port-card port-card-library collection-entry collection-${layout === "rows" ? "row" : "cover"} min-w-0`}
    >
      <div className="collection-identity">
        <ArtworkFrame
          element={element}
          display={display}
          identityArtwork
          className="card-art collection-art"
        />
        <h2
          className="collection-title font-semibold wrap-anywhere"
          tabIndex={-1}
          data-detail-game-id={first.id}
        >
          {gameTitle(first)}
        </h2>
        <p className="collection-project text-pc-muted-foreground">
          {group.ports.length} independent implementations
        </p>
      </div>
      <p className="collection-state text-xs text-pc-muted-foreground">
        {choice.reason === "stale"
          ? "Your chosen implementation is no longer in this game group. Choose deliberately; installed alternatives are preserved."
          : choice.reason === "filtered"
            ? "Your usual implementation is outside these filters. Matching implementations are listed below; your choice is unchanged."
            : "Choose an implementation. Each keeps its own installation, original-file requirements and saved data."}
      </p>
      <div className="collection-actions flex flex-wrap gap-2">
        {group.matchingPorts.map((port) => (
          <ImplementationChoice
            key={port.id}
            port={port}
            organization={organization}
            onSelected={restore}
          />
        ))}
      </div>
    </article>
  );
}
