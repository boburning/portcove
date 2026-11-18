import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { VirtualCollectionRows } from "./VirtualCollectionRows";
import { useOperationPresentation } from "../operations/operation-presentation";
import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../../localization";
import type { PortStatus } from "../../types";
import { Button } from "../../components/ui/button";
import { gameProjectLabel, gameTitle } from "../../port-identity";
import type { Organization } from "../organization/OrganizationControls";
import type { CatalogEntry } from "./catalog-entry";
import {
  gameGroupPresentationPort,
  gameGroupTitle,
  groupCatalog,
  type GameGroup,
} from "./original-game";
import { resolveGameChoice } from "./game-choice";
import { ImplementationChoice, ownsChoiceFocus } from "./ImplementationChoice";
import { ImplementationFacts } from "./GameAlternatives";
import type { CollectionLayout } from "./use-collection-layout";
import { ArtworkFrame } from "../../components/Artwork";
import { useArtwork, useArtworkVisibility } from "../../artwork";

type LibraryItem = {
  groupKey: string;
  position: number;
  total: number;
  portIds: readonly string[];
  matchingPortIds: readonly string[];
};

// The menu outlives a virtual row's regrouping and retains its trigger until the
// popup has finished dismissing. This is ephemeral interaction state, not membership.
const LibraryMenuContext = createContext<
  | {
      openPortId: string | undefined;
      highlightedAction: string | undefined;
      highlight: (portId: string, action: string | undefined) => void;
      getHighlighted: (portId: string) => string | undefined;
      canReturn: (portId: string) => boolean;
      change: (portId: string, open: boolean) => void;
      complete: (portId: string, open: boolean) => void;
    }
  | undefined
>(undefined);
export const useLibraryMenu = () => useContext(LibraryMenuContext);

/** Group presentation never rewrites the port/install identity of an action. */
export function GroupedLibrary({
  all,
  matching,
  statuses,
  organization,
  renderPort,
  onSelect,
  layout = "covers",
  resultsReady = true,
  queryKey = "",
}: {
  all: readonly CatalogEntry[];
  matching: readonly CatalogEntry[];
  statuses: ReadonlyMap<string, PortStatus>;
  organization?: Organization | undefined;
  renderPort: (port: CatalogEntry, presentationPort?: CatalogEntry) => ReactNode;
  onSelect: (portId: string, originKey?: string) => void;
  layout?: CollectionLayout;
  resultsReady?: boolean;
  queryKey?: string;
}) {
  const { t } = useAppTranslation("browsing");
  const generation = useOperationPresentation()?.generation;
  const currentGeneration = useRef(generation);

  const groups = useMemo(() => groupCatalog(all, matching), [all, matching]);
  const items = useMemo(
    () =>
      groups.map((group, index) => ({
        groupKey: group.id,
        position: index + 1,
        total: groups.length,
        portIds: group.ports.map((port) => port.id),
        matchingPortIds: group.matchingPorts.map((port) => port.id),
      })),
    [groups],
  );
  const [expansion, setExpansion] = useState({ generation, ids: new Set<string>() });
  const expanded = expansion.generation === generation ? expansion.ids : new Set<string>();
  const expand = useCallback(
    (id: string, open: boolean) => {
      if (currentGeneration.current !== generation) return;
      setExpansion((before) => {
        const ids = new Set(before.generation === generation ? before.ids : []);
        if (open) ids.add(id);
        else ids.delete(id);
        return { generation, ids };
      });
    },
    [generation],
  );
  const key = JSON.stringify([generation, queryKey]);
  const currentKey = useRef(key);
  const currentMenuPort = useRef<string | undefined>(undefined);
  const [menu, setMenu] = useState<{
    key: string;
    openPortId?: string;
    retainedPortId?: string;
    highlightedAction?: string | undefined;
  }>({
    key,
  });
  const menuGroup =
    menu.key === key && menu.retainedPortId
      ? groups.find((group) => group.ports.some((port) => port.id === menu.retainedPortId))
      : undefined;
  const hasMenuTarget =
    !menu.retainedPortId ||
    (menuGroup !== undefined &&
      resolveGameChoice(
        menuGroup,
        statuses,
        organization?.snapshot ? (organization.snapshot.preferred_port_by_game ?? {}) : undefined,
      ).port?.id === menu.retainedPortId);
  // Cancellation is final when the exact action target leaves the logical
  // results, even if the same query or collection later brings it back.
  const menuCurrent = menu.key === key && hasMenuTarget;
  if (!menuCurrent) setMenu({ key });
  const currentMenu = menuCurrent ? menu : { key };
  useLayoutEffect(() => {
    currentGeneration.current = generation;
    currentKey.current = key;
    currentMenuPort.current = currentMenu.retainedPortId;
  }, [generation, key, currentMenu.retainedPortId]);
  const menuOwner = useMemo(
    () => ({
      openPortId: currentMenu.openPortId,
      highlightedAction: currentMenu.highlightedAction,
      canReturn(portId: string) {
        return currentKey.current === key && currentMenuPort.current === portId;
      },
      getHighlighted(portId: string) {
        return currentKey.current === key &&
          currentMenuPort.current === portId &&
          currentMenu.openPortId === portId
          ? currentMenu.highlightedAction
          : undefined;
      },
      highlight(portId: string, action: string | undefined) {
        if (currentKey.current !== key) return;
        setMenu((before) =>
          before.key === key && before.openPortId === portId && before.highlightedAction !== action
            ? { ...before, highlightedAction: action }
            : before,
        );
      },
      change(portId: string, open: boolean) {
        if (currentKey.current !== key) return;
        setMenu((before) =>
          open
            ? { key, openPortId: portId, retainedPortId: portId }
            : before.key === key && before.openPortId === portId
              ? { key, retainedPortId: portId }
              : before,
        );
      },
      complete(portId: string, open: boolean) {
        if (open || currentKey.current !== key) return;
        setMenu((before) =>
          before.key === key && !before.openPortId && before.retainedPortId === portId
            ? { key }
            : before,
        );
      },
    }),
    [key, currentMenu.openPortId, currentMenu.highlightedAction],
  );
  const menuPin = currentMenu.retainedPortId ? menuGroup?.id : undefined;
  return (
    <LibraryMenuContext.Provider value={menuOwner}>
      <VirtualCollectionRows
        collection="library"
        ready={resultsReady}
        queryKey={queryKey}
        groups={groups}
        layout={layout}
        generation={generation}
        overlayPin={menuPin}
        label={t("library.label")}
        onMountDestination={(group, target) => {
          if (target.originKey?.startsWith("library:alternative:")) expand(group.id, true);
        }}
      >
        {(group, index) => (
          <LibraryGame
            key={group.id}
            {...{ group, statuses, organization, renderPort, onSelect, layout, t }}
            item={items[index]!}
            expanded={expanded.has(group.id)}
            onExpanded={expand}
          />
        )}
      </VirtualCollectionRows>
    </LibraryMenuContext.Provider>
  );
}

const LibraryGame = memo(function LibraryGame({
  group,
  item,
  expanded,
  onExpanded,
  t,
  statuses,
  organization,
  renderPort,
  onSelect,
  layout,
}: {
  group: GameGroup;
  item: LibraryItem;
  expanded: boolean;
  onExpanded: (groupId: string, open: boolean) => void;
  t: TFunction<"browsing">;
  statuses: ReadonlyMap<string, PortStatus>;
  organization: Organization | undefined;
  renderPort: (port: CatalogEntry, presentationPort?: CatalogEntry) => ReactNode;
  onSelect: (portId: string, originKey?: string) => void;
  layout: CollectionLayout;
}) {
  const preferences = organization?.snapshot?.preferred_port_by_game;
  const root = useRef<HTMLDivElement>(null);
  const restore = (trigger: HTMLButtonElement) =>
    window.requestAnimationFrame(() => {
      if (ownsChoiceFocus(trigger, root.current)) root.current?.focus();
    });
  const choice = resolveGameChoice(
    group,
    statuses,
    organization?.snapshot ? (preferences ?? {}) : undefined,
  );
  const first = gameGroupPresentationPort(group);
  const grouped = group.ports.length !== 1 || choice.reason === "stale";
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="min-w-0"
      aria-label={t("library.portsLabel", { title: gameGroupTitle(group) })}
      role="listitem"
      aria-posinset={item.position}
      aria-setsize={item.total}
      data-collection-singleton={item.total === 1}
      data-library-port-ids={JSON.stringify(item.portIds)}
      data-library-matching-port-ids={JSON.stringify(item.matchingPortIds)}
      data-library-game-id={group.id}
      data-detail-return-group={group.id}
    >
      {choice.port ? (
        renderPort(choice.port, first)
      ) : (
        <LibraryChoicePrompt {...{ group, first, choice, layout, organization, restore }} />
      )}
      {grouped && (
        <details
          open={expanded}
          onToggle={(event) => onExpanded(group.id, event.currentTarget.open)}
          className="mt-2 rounded-pc-md border border-pc-border px-3 py-2 text-sm"
        >
          <summary data-focusable data-collection-control="alternatives" className="cursor-pointer">
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
      )}
      {grouped && organization?.failure === "read" && (
        <p role="status" className="mt-2 text-xs text-pc-warning-foreground">
          {t("library.choiceReadFailed")}
        </p>
      )}
    </div>
  );
});

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
            portId={first.id}
            visible={visible}
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
