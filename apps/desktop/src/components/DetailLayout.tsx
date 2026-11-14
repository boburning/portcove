import { Tabs } from "@base-ui/react/tabs";
import { Menu } from "@base-ui/react/menu";
import { ArrowLeft, ArrowRight, ArrowUpRight, FileText, MoreHorizontal } from "lucide-react";
import type { TFunction } from "i18next";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAppTranslation } from "../localization";
import {
  detailSections,
  type DetailOpening,
  type DetailSection,
} from "../features/game-details/detail-sections";
import { focusAndReveal } from "../focus";
import {
  gameIdentityLabel,
  gameProjectLabel,
  gameTitle,
  type PortIdentity,
} from "../port-identity";
import { GameHero } from "./GameHero";
import { CatalogMediaGallery } from "./CatalogMedia";
import { IdentityIcon } from "../features/identity/IdentityIcon";
import { identityLabel, identityStyle } from "../features/identity/identity-style";
import { releaseChannelPresentation } from "../view-model";
import type { PortDefinition, ReleaseChannel } from "../types";
import { availablePlatforms, type CatalogEntry } from "../features/browsing/catalog-entry";
import { Chip } from "./ui/chip";
import { ExternalLink } from "./ExternalLink";
import { FundingLinks } from "./FundingLinks";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { controlFocus } from "./ui/control-style";

function sectionLabel(t: TFunction<"detail">, section: DetailSection): string {
  switch (section) {
    case "overview":
      return t("section.overview");
    case "files":
      return t("section.files");
    case "saves":
      return t("section.saves");
    case "versions":
      return t("section.versions");
    case "manage":
      return t("section.manage");
  }
}
type Identity = PortIdentity & {
  id: string;
  platforms?: PortDefinition["platforms"] | undefined;
  channels?: PortDefinition["channels"] | undefined;
  listing?: CatalogEntry["listing"];
};
export type RevealDetailSection = (
  section: DetailSection,
  targetId?: string,
  control?: string,
) => void;

/** Presentation only: all eligibility and stateful workflow owners stay with the caller. */
export function DetailLayout({
  backLabel,
  favoriteControl,
  managementSupplement,
  supplementSection,
  port,
  projectUrl,
  openSupport,
  overviewRequirements,
  overviewActions,
  overviewDetails,
  selectedChannel,
  opening,
  initialSection,
  readiness,
  installation,
  action,
  attention,
  close,
  steam,
  children,
}: {
  backLabel?: string | undefined;
  favoriteControl?: ReactNode;
  /** Maintenance content (catalog checks) shown at the top of the management section. */
  managementSupplement?: ReactNode;
  /** Where the supplement opens; defaults to the management section. */
  supplementSection?: DetailSection | undefined;
  port: Identity;
  projectUrl?: string | undefined;
  openSupport?: (() => void) | undefined;
  overviewRequirements?: ReactNode;
  overviewDetails?: ReactNode;
  selectedChannel?: ReleaseChannel;
  overviewActions?: ((reveal: RevealDetailSection) => ReactNode) | undefined;
  opening?: DetailOpening | undefined;
  initialSection: DetailSection;
  readiness: ReactNode;
  installation: string;
  action: (reveal: RevealDetailSection) => ReactNode;
  attention?: ((reveal: RevealDetailSection) => ReactNode) | undefined;
  close: () => void;
  steam?: boolean | undefined;
  children: (reveal: RevealDetailSection) => Partial<Record<DetailSection, ReactNode>>;
}) {
  const { t } = useAppTranslation("detail");
  const identity = `${port.id}:${opening?.token ?? "standalone"}`;
  const [selection, setSelection] = useState({ identity, section: initialSection });
  // Generation/refresh changes must not reset a manual selection within an opening.
  if (selection.identity !== identity) setSelection({ identity, section: initialSection });
  const selected = selection.identity === identity ? selection.section : initialSection;
  const root = useRef<HTMLElement>(null);
  const [pending, setPending] = useState<{
    section: DetailSection;
    targetId?: string | undefined;
    control?: string | undefined;
    identity: string;
  }>();
  const focusedOpening = useRef<string | undefined>(undefined);
  const reveal: RevealDetailSection = (section, targetId, control) => {
    setPending({ section, targetId, control, identity });
    setSelection({ identity, section });
  };
  useLayoutEffect(() => {
    const request =
      pending?.identity === identity && pending.section === selected ? pending : undefined;
    const newOpening = focusedOpening.current !== identity;
    if (!request && !newOpening) return;
    if (!opening && !request) return;
    const targetId =
      request?.targetId ??
      (request || opening?.destination ? `detail-section-${selected}` : "port-detail-title");
    const element = root.current;
    const frame = requestAnimationFrame(() => {
      if (!element?.isConnected || element.dataset.detailOpening !== identity) return;
      const target = element.querySelector<HTMLElement>(`#${CSS.escape(targetId)}`);
      if (!target || target.closest("[hidden], [inert]")) return;
      for (
        let disclosure = target.closest("details");
        disclosure;
        disclosure = disclosure.parentElement?.closest("details") ?? null
      )
        disclosure.open = true;
      focusAndReveal(target);
      focusedOpening.current = identity;
      const controlScope = target.matches("h2, h3, span") ? target.parentElement : target;
      const control = request?.control
        ? controlScope?.querySelector<HTMLElement>(request.control)
        : undefined;
      if (
        control?.isConnected &&
        !control.matches(":disabled, [aria-disabled=true]") &&
        !control.closest("[hidden], [inert]") &&
        control.getClientRects().length
      ) {
        focusAndReveal(control);
        if (control.matches("summary") && control.parentElement instanceof HTMLDetailsElement)
          control.parentElement.open = true;
        else control.click();
      }
      if (request) setPending(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [identity, opening, selected, pending]);
  const panels = children(reveal);
  const sections = detailSections.filter((section) => panels[section] !== undefined);
  const managementSection = panels.manage !== undefined ? "manage" : "files";
  const sourceSystems = [
    ...new Set(
      port.presentation?.original_game?.source_editions.map(
        (edition) => edition.system ?? "not-specified",
      ) ?? [],
    ),
  ];
  if (!sourceSystems.length) sourceSystems.push("not-specified");
  return (
    <section
      ref={root}
      className="detail-panel @container/detail relative w-full min-w-0"
      aria-labelledby="port-detail-title"
      data-detail-workspace
      data-detail-port-id={port.id}
      data-detail-opening={identity}
      data-detail-section={selected}
    >
      <Button
        data-focusable
        className="detail-back mb-5"
        variant="ghost"
        size="sm"
        data-detail-back
        aria-label={backLabel ?? "Back to previous workspace"}
        onClick={close}
      >
        <Icon glyph={ArrowLeft} /> {backLabel ?? "Back"}
      </Button>
      <GameHero port={port} variant="detail" className="detail-hero">
        <div className="detail-identity min-w-0 [overflow-wrap:anywhere]">
          <h1 id="port-detail-title" tabIndex={-1} className="detail-title m-0">
            {gameTitle(port)}
          </h1>
          {gameProjectLabel(port) && (
            <p className="detail-project">
              {projectUrl ? (
                <ExternalLink href={projectUrl} data-focusable>
                  {gameProjectLabel(port)}
                  <ArrowUpRight aria-hidden="true" />
                </ExternalLink>
              ) : (
                gameProjectLabel(port)
              )}
            </p>
          )}
          <div
            className="detail-identity-chips mt-3 flex flex-wrap gap-2"
            role="group"
            aria-label={t("identity.label")}
          >
            {sourceSystems.map((system) => (
              <Chip
                key={`system:${system}`}
                style={identityStyle(system)}
                title={t("identity.originalSystem")}
              >
                <IdentityIcon name={system} />
                {system === "not-specified"
                  ? t("identity.originalSystemUnspecified")
                  : identityLabel(system)}
              </Chip>
            ))}
            {[
              ...new Set(
                (port.platforms
                  ? availablePlatforms({ platforms: port.platforms, listing: port.listing })
                  : []
                ).map((platform) => platform.split("-")[0]!),
              ),
            ].map((system) => {
              return (
                <Chip
                  key={`platform:${system}`}
                  style={identityStyle(system)}
                  title={t("identity.runsOn")}
                >
                  <IdentityIcon name={system} />
                  {identityLabel(system)}
                </Chip>
              );
            })}
            {(selectedChannel ? [selectedChannel] : port.channels)?.map((channel) => (
              <Chip
                key={`channel:${channel}`}
                style={identityStyle(channel, true)}
                title={
                  selectedChannel ? t("identity.selectedChannel") : t("identity.offeredChannel")
                }
              >
                <IdentityIcon name={channel} channel />
                {releaseChannelPresentation(channel).label}
              </Chip>
            ))}
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <div data-detail-readiness className="detail-readiness">
              {readiness}
            </div>
            <span className="text-pc-muted-foreground" data-installation-fact>
              {installation}
            </span>
          </div>
          <div className="detail-header-actions mt-6 flex flex-wrap items-center gap-2">
            {action(reveal)}
            {favoriteControl}
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    data-focusable
                    variant="outline"
                    size="icon-lg"
                    aria-label={t("actions.more", { name: gameIdentityLabel(port) })}
                  />
                }
              >
                <Icon glyph={MoreHorizontal} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner
                  side="bottom"
                  align="end"
                  sideOffset={4}
                  className="z-(--layer-floating)"
                >
                  <Menu.Popup
                    data-portcove-focus-scope
                    className="min-w-48 rounded-pc-md border border-pc-border bg-pc-surface p-1 text-pc-foreground shadow-(--shadow-floating)"
                  >
                    <Menu.Item
                      className={`${controlFocus} cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`}
                      onClick={() =>
                        reveal(managementSection, "detail-artwork", ".artwork-controls > summary")
                      }
                    >
                      {t("actions.artwork")}
                    </Menu.Item>
                    {steam && (
                      <Menu.Item
                        className={`${controlFocus} cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`}
                        onClick={() =>
                          reveal(managementSection, "detail-steam", "[data-steam-shortcut]")
                        }
                      >
                        {t("actions.steam")}
                      </Menu.Item>
                    )}
                    {projectUrl && (
                      <Menu.Item
                        className={`${controlFocus} block rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`}
                        onClick={() => reveal("overview", "detail-project-link", "a")}
                      >
                        {t("actions.project")}
                      </Menu.Item>
                    )}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </div>
      </GameHero>
      {attention && <div className="detail-attention my-3 text-sm">{attention(reveal)}</div>}
      <Tabs.Root
        value={selected}
        onValueChange={(value: unknown) => {
          if (detailSections.includes(value as DetailSection)) {
            setPending(undefined);
            setSelection({ identity, section: value as DetailSection });
          }
        }}
        className="detail-tabs"
      >
        <Tabs.List
          activateOnFocus={false}
          aria-label={t("section.label")}
          className="detail-tab-list flex flex-wrap gap-x-7 gap-y-1 border-b border-pc-border"
        >
          {sections.map((section) => (
            <Tabs.Tab
              key={section}
              value={section}
              data-focusable
              className={`${controlFocus} detail-tab cursor-pointer rounded-t-pc-sm border-b-2 border-transparent bg-transparent px-3 py-3 text-sm font-semibold text-pc-muted-foreground data-active:border-current data-active:bg-pc-selection data-active:text-pc-selection-foreground`}
            >
              {sectionLabel(t, section)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {sections.map((section) => (
          <Tabs.Panel
            key={section}
            value={section}
            keepMounted
            hidden={selected !== section}
            inert={selected !== section}
            className="detail-tab-panel min-w-0 pb-10"
          >
            <h2
              id={`detail-section-${section}`}
              tabIndex={-1}
              className={section === "overview" ? "sr-only" : "mb-5 text-xl"}
            >
              {sectionLabel(t, section)}
            </h2>
            {section === "overview" ? (
              <div className="detail-overview">
                <div className="detail-overview-main min-w-0">
                  {panels.overview}
                  <CatalogMediaGallery port={port} />
                  {overviewActions?.(reveal)}
                  {overviewDetails}
                </div>
                <aside className="detail-overview-support min-w-0">
                  <section className="detail-requirements" aria-label={t("requirements.heading")}>
                    <h3 className="mb-4 text-base">{t("requirements.heading")}</h3>
                    {overviewRequirements ?? (
                      <p className="text-sm text-pc-muted-foreground">
                        {t("requirements.fallback")}
                      </p>
                    )}
                  </section>
                  {(projectUrl || openSupport || (port.listing?.funding_urls?.length ?? 0) > 0) && (
                    <section className="detail-resources" aria-label={t("resources.heading")}>
                      <h3 className="mb-3 text-base">{t("resources.heading")}</h3>
                      {projectUrl && (
                        <div id="detail-project-link" tabIndex={-1}>
                          <ExternalLink
                            href={projectUrl}
                            className="flex w-full gap-2.5 border-b border-pc-border py-3 text-xs"
                          >
                            <FileText aria-hidden="true" />
                            <span>{t("resources.website")}</span>
                            <ArrowUpRight aria-hidden="true" />
                          </ExternalLink>
                        </div>
                      )}
                      {openSupport && (
                        <Button
                          variant="link"
                          className="w-full justify-start gap-2.5 rounded-none border-x-0 border-t-0 border-b border-pc-border px-0 py-3 text-start text-xs"
                          onClick={openSupport}
                        >
                          <FileText aria-hidden="true" />
                          <span>{t("resources.support")}</span>
                          <ArrowRight aria-hidden="true" />
                        </Button>
                      )}
                      {openSupport && (
                        <p className="mt-3 max-w-prose text-sm text-pc-muted-foreground">
                          {t("resources.supportNote")}
                        </p>
                      )}
                      <FundingLinks urls={port.listing?.funding_urls} />
                    </section>
                  )}
                </aside>
              </div>
            ) : (
              <>
                {/* Catalog checks are maintenance; they live with management, not the hero. */}
                {section === (supplementSection ?? managementSection) && managementSupplement && (
                  <div className="detail-management-supplement mb-6">{managementSupplement}</div>
                )}
                {panels[section]}
              </>
            )}
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </section>
  );
}
