import { Fragment, useRef, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
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
  const { t } = useAppTranslation("browsing");
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
      aria-label={t("library.portsLabel", { title: gameTitle(first) })}
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
          {t("library.allPorts", {
            count: group.ports.length,
            matching: group.matchingPorts.length,
          })}
        </summary>
        <p className="my-2 text-xs text-pc-muted-foreground">{t("library.independence")}</p>
        {group.ports.map((port) => (
          <div key={port.id} className="grid gap-2 border-t border-pc-border py-3">
            <p>
              <AlternativeName
                t={t}
                name={gameProjectLabel(port) || port.name}
                chosen={choice.preferredPortId === port.id}
                outside={!group.matchingPorts.some((match) => match.id === port.id)}
              />
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
              <Trans
                t={t}
                i18nKey="alternatives.view"
                components={{ name: <bdi>{gameProjectLabel(port) || port.name}</bdi> }}
              />
            </Button>
          </div>
        ))}
      </details>
      {organization?.failure === "read" && (
        <p role="status" className="mt-2 text-xs text-pc-warning-foreground">
          {t("library.choiceReadFailed")}
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
  const { t } = useAppTranslation("browsing");
  const { element, visible } = useArtworkVisibility();
  const { display } = useArtwork(first.id, "cover", visible);
  return (
    <article
      className={`port-card port-card-library collection-entry collection-${layout === "rows" ? "row" : "cover"} min-w-0`}
    >
      <div className="collection-main">
        <div className="collection-identity">
          <ArtworkFrame
            element={element}
            display={display}
            identityArtwork
            className="card-art collection-art"
          />
          <div className="collection-caption">
            <h2
              className="collection-title font-semibold wrap-anywhere"
              tabIndex={-1}
              data-detail-game-id={first.id}
            >
              {gameTitle(first)}
            </h2>
            <p className="collection-project text-pc-muted-foreground">
              {t("library.portCount", { count: group.ports.length })}
            </p>
          </div>
        </div>
      </div>
      <div className="library-entry-footer">
        <p className="collection-state text-xs text-pc-muted-foreground">
          {choice.reason === "stale"
            ? t("library.choiceStale")
            : choice.reason === "filtered"
              ? t("library.choiceFiltered")
              : t("library.choosePrompt")}
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
      </div>
    </article>
  );
}

/** One complete message per marker combination; the project name stays exact. */
function AlternativeName({
  t,
  name,
  chosen,
  outside,
}: {
  t: TFunction<"browsing">;
  name: string;
  chosen: boolean;
  outside: boolean;
}) {
  const components = { name: <bdi>{name}</bdi> };
  if (chosen && outside)
    return <Trans t={t} i18nKey="library.chosenOutside" components={components} />;
  if (chosen) return <Trans t={t} i18nKey="library.chosen" components={components} />;
  if (outside) return <Trans t={t} i18nKey="library.outside" components={components} />;
  return <bdi>{name}</bdi>;
}
