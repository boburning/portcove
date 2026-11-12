import { Fragment, useId, useState, useRef, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { Menu } from "@base-ui/react/menu";
import { Bookmark, EyeOff, Eye, Check, Folder, Plus } from "lucide-react";
import { Trans } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { controlFocus } from "../../components/ui/control-style";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { originalGame, gameGroupId } from "../browsing/original-game";
import { useAppTranslation } from "../../localization";
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
  triggerClassName,
  afterAll,
  allSelected,
}: {
  afterAll?: ReactNode;
  allSelected?: boolean;
  children?: ReactNode;
  trigger?: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  organization: Organization;
  selected: string;
  onSelect: (id: string) => void;
  discover: boolean;
}) {
  const { t } = useAppTranslation("organization");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(Boolean(triggerLabel));
  const allGames = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const snapshot = organization.snapshot;
  const controls = (
    <div
      className="mb-3 flex basis-full flex-wrap items-center gap-2"
      role="group"
      aria-label={discover ? t("group.discover") : t("group.library")}
      data-organization-controls={discover ? "discover" : "library"}
    >
      {[
        ["all", t("view.all")],
        ...(discover
          ? [
              ["saved", t("view.saved")],
              ["followed", t("view.followed")],
            ]
          : [["hidden", t("view.hidden")]]),
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
            <Trans
              t={t}
              i18nKey="collection.withCount"
              values={{ total: collection.port_ids.length }}
              components={{ name: <bdi>{collection.name}</bdi> }}
            />
          </Button>
        ))}
      {!discover && (
        <details
          className="text-sm"
          open={editing}
          onToggle={(event) => setEditing(event.currentTarget.open)}
        >
          <summary className="cursor-pointer py-2 pe-2">{t("edit.summary")}</summary>
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
              {t("edit.nameLabel")}
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
              {t("edit.create")}
            </Button>
          </form>
          {snapshot &&
            Object.entries(snapshot.collections).map(([id, collection]) => (
              <p key={id} className="flex flex-wrap items-center gap-2">
                <bdi>{collection.name}</bdi>
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
                  {t("edit.remove")}
                </Button>
              </p>
            ))}
          <p className="text-xs text-pc-muted-foreground">{t("edit.note")}</p>
        </details>
      )}
      {children}
      {organization.failure && (
        <p role="alert" className="basis-full text-sm text-pc-warning-foreground">
          {organization.failure === "read"
            ? snapshot
              ? t("failure.refresh")
              : t("failure.read")
            : t("failure.write")}
          <Button
            variant="link"
            size="sm"
            onClick={() => void organization.refresh()}
            disabled={organization.busy}
          >
            {t("failure.reload")}
          </Button>
        </p>
      )}
    </div>
  );
  if (discover) return controls;
  const selectedCollection = selected.startsWith("collection:")
    ? snapshot?.collections[selected.slice(11)]
    : undefined;
  // One complete trigger message per selection; a collection name stays exact.
  const selectionLabel =
    selected === "all" ? (
      t("trigger.all")
    ) : selected === "hidden" ? (
      t("trigger.hidden")
    ) : selectedCollection ? (
      <Trans
        t={t}
        i18nKey="trigger.collection"
        components={{ name: <bdi>{selectedCollection.name}</bdi> }}
      />
    ) : selected.startsWith("collection:") ? (
      t("trigger.unavailable")
    ) : (
      t("trigger.allGames")
    );
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant={selected === "all" || selected === "" ? "outline" : "selected"}
            size="sm"
            className={triggerClassName}
          />
        }
        aria-label={triggerLabel}
      >
        {trigger ?? selectionLabel}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="start" className="z-(--layer-floating)">
          <Popover.Popup
            data-portcove-focus-scope
            className="shadow-floating max-h-(--available-height) w-[min(30rem,var(--available-width))] overflow-auto rounded-pc-lg border border-pc-border bg-pc-surface p-4 text-sm text-pc-foreground outline-none"
          >
            <Popover.Title className="mb-3 text-base font-semibold">{t("title")}</Popover.Title>
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
  const { t } = useAppTranslation("organization");
  const snapshot = organization.snapshot;
  const collections = Object.entries(snapshot?.collections ?? {});
  const knownEmpty = Boolean(snapshot && collections.length === 0);
  return (
    <section className="sidebar-collections" aria-label={t("title")}>
      <div className="sidebar-collections-heading">
        <span>{t("title")}</span>
        <OrganizationControls
          organization={organization}
          selected={selected}
          onSelect={onSelect}
          discover={false}
          trigger={
            knownEmpty ? (
              <>
                <Plus aria-hidden="true" />
                {t("sidebar.createFirst")}
              </>
            ) : (
              <Plus aria-hidden="true" />
            )
          }
          triggerLabel={knownEmpty ? t("sidebar.createFirst") : t("sidebar.manage")}
          triggerClassName={knownEmpty ? "sidebar-collections-create" : ""}
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
          aria-label={t("sidebar.collectionLabel", { name: collection.name })}
          title={collection.name}
          onClick={() => onSelect(`collection:${id}`)}
        >
          <Folder aria-hidden="true" />
          <span>
            <bdi>{collection.name}</bdi>
          </span>
          <small>{collection.port_ids.length}</small>
        </Button>
      ))}
      {!snapshot && <p className="sidebar-collections-empty">{t("sidebar.loading")}</p>}
      {Boolean(snapshot?.hidden_port_ids.length) && (
        <Button
          data-focusable
          className="sidebar-collection"
          variant={selected === "hidden" ? "selected" : "ghost"}
          aria-pressed={selected === "hidden"}
          onClick={() => onSelect("hidden")}
        >
          <EyeOff aria-hidden="true" />
          <span>{t("sidebar.hiddenGames")}</span>
          <small>{snapshot?.hidden_port_ids.length}</small>
        </Button>
      )}
      {organization.failure && (
        <p className="sidebar-collections-empty" role="status">
          {organization.failure === "read" ? t("sidebar.failureRead") : t("sidebar.failureWrite")}
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
  const { t } = useAppTranslation("organization");
  if (!organization) return null;
  const gameId = savedGameId(port);
  const saved = groupPorts.some((entry) => savedForPort(organization, entry));
  return (
    <Button
      size={card ? "icon-sm" : "sm"}
      className={card ? "collection-art-action collection-save" : undefined}
      title={saved ? t("save.removeTitle") : t("save.title")}
      variant={saved ? "selected" : "ghost"}
      data-focusable
      aria-pressed={saved}
      aria-label={t("save.label", { game: gameIdentityLabel(port) })}
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
                    .querySelector<HTMLButtonElement>(
                      '[data-organization-controls="discover"] button',
                    )
                    ?.focus();
              });
          });
      }}
    >
      <Bookmark aria-hidden="true" />
      {!card && (saved ? t("save.saved") : t("save.save"))}
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
  const { t } = useAppTranslation("organization");
  const snapshot = organization.snapshot;
  const hidden = snapshot?.hidden_port_ids.includes(port.id) ?? false;
  const itemClass = `${controlFocus} flex cursor-default items-center gap-2 rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection [&_svg]:size-4 [&_svg]:shrink-0`;
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
        {hidden ? t("menu.show") : t("menu.hide")}
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
              <bdi>{collection.name}</bdi>
            </Menu.CheckboxItem>
          );
        })}
    </>
  );
}
