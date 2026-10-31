import { Fragment, useId, useState, useRef, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Menu } from "@base-ui/react/menu";
import { Bookmark, EyeOff, Eye, Check, Folder, Plus } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { controlFocus } from "../../components/ui/control-style";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { originalGame, gameGroupId } from "../browsing/original-game";
import { gameIdentityLabel } from "../../port-identity";
import type { useOrganization } from "./use-organization";

export type Organization = ReturnType<typeof useOrganization>;
export function savedGameId(port: CatalogEntry) {
  const identity = originalGame(port);
  return identity ? `game-${identity.id}` : `port-${port.id}`;
}
export function savedForPort(organization: Organization | undefined, port: CatalogEntry): boolean {
  const ids = organization?.snapshot?.saved_game_ids;
  return Boolean(ids?.includes(savedGameId(port)) || ids?.includes(`port-${port.id}`));
}
export function organizedPorts(
  ports: CatalogEntry[],
  organization: Organization | undefined,
  selected: string,
  discover = false,
  universe: readonly CatalogEntry[] = ports,
) {
  const snapshot = organization?.snapshot;
  if (!snapshot) return selected === "all" ? ports : [];
  const savedGroups = new Set(
    universe.filter((port) => savedForPort(organization, port)).map(gameGroupId),
  );
  return ports.filter((port) => {
    const hidden = snapshot.hidden_port_ids.includes(port.id);
    if (selected === "hidden") return hidden;
    if (hidden && !discover) return false;
    if (selected === "saved") return savedGroups.has(gameGroupId(port));
    if (selected === "followed") return snapshot.followed_port_ids.includes(port.id);
    if (selected.startsWith("collection:"))
      return snapshot.collections[selected.slice(11)]?.port_ids.includes(port.id) ?? false;
    return true;
  });
}

export function OrganizationControls({
  organization,
  selected,
  onSelect,
  discover,
  children,
  trigger,
  triggerLabel,
  afterAll,
  allSelected,
}: {
  afterAll?: ReactNode;
  allSelected?: boolean;
  children?: ReactNode;
  trigger?: ReactNode;
  triggerLabel?: string;
  organization: Organization;
  selected: string;
  onSelect: (id: string) => void;
  discover: boolean;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(Boolean(triggerLabel));
  const allGames = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const snapshot = organization.snapshot;
  const controls = (
    <div
      className="mb-3 flex basis-full flex-wrap items-center gap-2"
      role="group"
      aria-label={discover ? "Discover collections" : "Library collections"}
    >
      {[
        ["all", "All games"],
        ...(discover
          ? [
              ["saved", "Saved"],
              ["followed", "Followed"],
            ]
          : [["hidden", "Hidden"]]),
      ].map(([id, label]) => (
        <Fragment key={id}>
          <Button
            ref={id === "all" ? allGames : undefined}
            data-focusable
            variant={
              (id === "all" ? (allSelected ?? selected === id) : selected === id)
                ? "selected"
                : "ghost"
            }
            size="sm"
            aria-pressed={id === "all" ? (allSelected ?? selected === id) : selected === id}
            disabled={!snapshot && id !== "all"}
            onClick={() => onSelect(id!)}
          >
            {label}
          </Button>
          {id === "all" && afterAll}
        </Fragment>
      ))}
      {!discover &&
        snapshot &&
        Object.entries(snapshot.collections).map(([id, collection]) => (
          <Button
            key={id}
            size="sm"
            data-focusable
            aria-pressed={selected === `collection:${id}`}
            variant={selected === `collection:${id}` ? "selected" : "ghost"}
            onClick={() => onSelect(`collection:${id}`)}
          >
            {collection.name} ({collection.port_ids.length})
          </Button>
        ))}
      {!discover && (
        <details
          className="text-sm"
          open={editing}
          onToggle={(event) => setEditing(event.currentTarget.open)}
        >
          <summary className="cursor-pointer p-2">Edit collections</summary>
          <form
            className="mt-2 flex max-w-full flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const collectionName = name.trim();
              if (!collectionName || organization.busy) return;
              void organization
                .commit({
                  kind: "upsert_collection",
                  collection_id: crypto.randomUUID(),
                  name: collectionName,
                })
                .then((saved) => {
                  if (saved) setName("");
                });
            }}
          >
            <label htmlFor={inputId}>
              Collection name
              <Input
                id={inputId}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              disabled={!snapshot || organization.busy || !name.trim()}
              variant="outline"
            >
              Create collection
            </Button>
          </form>
          {snapshot &&
            Object.entries(snapshot.collections).map(([id, collection]) => (
              <p key={id} className="flex flex-wrap items-center gap-2">
                {collection.name}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={organization.busy}
                  onClick={() => {
                    void organization
                      .commit({ kind: "remove_collection", collection_id: id })
                      .then((removed) => {
                        if (removed && selected === `collection:${id}`) {
                          onSelect("all");
                          allGames.current?.focus();
                        }
                      });
                  }}
                >
                  Remove collection
                </Button>
              </p>
            ))}
          <p className="text-xs text-pc-muted-foreground">
            Collections organize entries. Removing a collection keeps every game and file.
          </p>
        </details>
      )}
      {children}
      {organization.failure && (
        <p role="alert" className="basis-full text-sm text-pc-warning-foreground">
          {organization.failure === "read"
            ? "Organization choices could not be read. Games are shown without hidden or collection choices."
            : "These choices could not be saved. Your previous choices were kept."}
          <Button
            variant="link"
            size="sm"
            onClick={() => void organization.refresh()}
            disabled={organization.busy}
          >
            Reload choices
          </Button>
        </p>
      )}
    </div>
  );
  if (discover) return controls;
  const current =
    selected === "hidden"
      ? "Hidden"
      : selected.startsWith("collection:")
        ? (snapshot?.collections[selected.slice(11)]?.name ?? "Unavailable collection")
        : "All games";
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button variant={selected === "all" ? "outline" : "selected"} size="sm" />}
        aria-label={triggerLabel}
      >
        {trigger ?? (selected === "all" ? "Collections" : `Collections · ${current}`)}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="start" className="z-(--layer-floating)">
          <Popover.Popup
            data-portcove-focus-scope
            className="shadow-floating max-h-(--available-height) w-[min(30rem,var(--available-width))] overflow-auto rounded-pc-lg border border-pc-border bg-pc-surface p-4 text-sm text-pc-foreground outline-none"
          >
            <Popover.Title className="mb-3 text-base font-semibold">Collections</Popover.Title>
            {controls}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Collection navigation shares the existing revision-bound preference owner. */
export function SidebarCollections({
  organization,
  selected,
  onSelect,
  children,
}: {
  organization: Organization;
  children?: ReactNode;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const snapshot = organization.snapshot;
  const collections = Object.entries(snapshot?.collections ?? {});
  return (
    <section className="sidebar-collections" aria-label="Collections">
      <div className="sidebar-collections-heading">
        <span>Collections</span>
        <OrganizationControls
          organization={organization}
          selected={selected}
          onSelect={onSelect}
          discover={false}
          trigger={<Plus aria-hidden="true" />}
          triggerLabel="Manage collections"
        >
          {children}
        </OrganizationControls>
      </div>
      {collections.map(([id, collection]) => (
        <Button
          key={id}
          data-focusable
          className="sidebar-collection"
          variant={selected === `collection:${id}` ? "selected" : "ghost"}
          aria-pressed={selected === `collection:${id}`}
          aria-label={`Collection: ${collection.name}`}
          title={collection.name}
          onClick={() => onSelect(`collection:${id}`)}
        >
          <Folder aria-hidden="true" />
          <span>{collection.name}</span>
          <small>{collection.port_ids.length}</small>
        </Button>
      ))}
      {collections.length === 0 && (
        <p className="sidebar-collections-empty">
          {snapshot ? "Keep your games in collections." : "Loading collections…"}
        </p>
      )}
      {Boolean(snapshot?.hidden_port_ids.length) && (
        <Button
          data-focusable
          className="sidebar-collection"
          variant={selected === "hidden" ? "selected" : "ghost"}
          aria-pressed={selected === "hidden"}
          onClick={() => onSelect("hidden")}
        >
          <EyeOff aria-hidden="true" />
          <span>Hidden games</span>
          <small>{snapshot?.hidden_port_ids.length}</small>
        </Button>
      )}
      {organization.failure && (
        <p className="sidebar-collections-empty" role="status">
          {organization.failure === "read"
            ? "Collections could not be refreshed. Open Manage collections to retry."
            : "Collection changes could not be saved. Your previous choices were kept."}
        </p>
      )}
    </section>
  );
}

export function SaveGameButton({
  port,
  organization,
  groupPorts = [port],
  card = false,
}: {
  port: CatalogEntry;
  groupPorts?: readonly CatalogEntry[];
  card?: boolean;
  organization?: Organization | undefined;
}) {
  if (!organization) return null;
  const gameId = savedGameId(port);
  const saved = groupPorts.some((entry) => savedForPort(organization, entry));
  return (
    <Button
      size={card ? "icon-sm" : "sm"}
      className={card ? "collection-art-action collection-save" : undefined}
      title={saved ? "Remove saved game" : "Save for later"}
      variant={saved ? "selected" : "ghost"}
      data-focusable
      aria-pressed={saved}
      aria-label={`Save ${gameIdentityLabel(port)} for later`}
      disabled={!organization.snapshot || organization.busy}
      onClick={(event) => {
        const button = event.currentTarget;
        const root = button.closest("[data-focus-region=workspace]") ?? document;
        void organization
          .commit({
            kind: "set_saved_group",
            game_id: gameId,
            legacy_port_ids: groupPorts.map((entry) => entry.id),
            saved: !saved,
          })
          .then((accepted) => {
            if (accepted)
              requestAnimationFrame(() => {
                if (!button.isConnected && document.activeElement === document.body)
                  root
                    .querySelector<HTMLButtonElement>('[aria-label="Discover collections"] button')
                    ?.focus();
              });
          });
      }}
    >
      <Bookmark aria-hidden="true" />
      {!card && (saved ? "Saved" : "Save")}
    </Button>
  );
}

export function OrganizationMenuItems({
  port,
  organization,
  after,
}: {
  port: CatalogEntry;
  organization: Organization;
  after: (action: () => Promise<boolean>) => void;
}) {
  const snapshot = organization.snapshot;
  const hidden = snapshot?.hidden_port_ids.includes(port.id) ?? false;
  const itemClass = `${controlFocus} flex cursor-default items-center gap-2 rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`;
  return (
    <>
      <Menu.Item
        className={itemClass}
        disabled={!snapshot || organization.busy}
        onClick={() =>
          after(() =>
            organization.commit({ kind: "set_hidden", port_id: port.id, hidden: !hidden }),
          )
        }
      >
        {hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        {hidden ? "Show in Library" : "Hide from Library"}
      </Menu.Item>
      {snapshot &&
        Object.entries(snapshot.collections).map(([id, collection]) => {
          const member = collection.port_ids.includes(port.id);
          return (
            <Menu.CheckboxItem
              key={id}
              className={itemClass}
              checked={member}
              disabled={organization.busy}
              onCheckedChange={(included) =>
                after(() =>
                  organization.commit({
                    kind: "set_collection_port",
                    collection_id: id,
                    port_id: port.id,
                    included,
                  }),
                )
              }
            >
              <Menu.CheckboxItemIndicator>
                <Check aria-hidden="true" />
              </Menu.CheckboxItemIndicator>
              {collection.name}
            </Menu.CheckboxItem>
          );
        })}
    </>
  );
}
