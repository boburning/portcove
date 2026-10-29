import { Tabs } from "@base-ui/react/tabs";
import { Menu } from "@base-ui/react/menu";
import { ArrowLeft, ArrowUpRight, FileText, MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { platformLabel, releaseChannelPresentation } from "../view-model";
import type { PortDefinition } from "../types";
import { Chip } from "./ui/chip";
import { ExternalLink } from "./ExternalLink";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { controlFocus } from "./ui/control-style";

const labels: Record<DetailSection, string> = {
  overview: "Overview",
  files: "Game files",
  saves: "Saves & backups",
  versions: "Versions & updates",
  manage: "Manage",
};
type Identity = PortIdentity & {
  id: string;
  platforms?: PortDefinition["platforms"] | undefined;
  channels?: PortDefinition["channels"] | undefined;
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
  port,
  projectUrl,
  openSupport,
  overviewRequirements,
  overviewActions,
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
  port: Identity;
  projectUrl?: string | undefined;
  openSupport?: (() => void) | undefined;
  overviewRequirements?: ReactNode;
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
            <p className="mt-2 text-sm text-pc-muted-foreground">
              {projectUrl ? (
                <ExternalLink href={projectUrl} data-focusable>
                  {gameProjectLabel(port)}
                </ExternalLink>
              ) : (
                gameProjectLabel(port)
              )}
            </p>
          )}
          <div
            className="detail-identity-chips mt-3 flex flex-wrap gap-2"
            role="group"
            aria-label="Game and port identity"
          >
            {sourceSystems.map((system) => (
              <Chip key={`system:${system}`} style={identityStyle(system)} title="Original system">
                <IdentityIcon name={system} />
                {identityLabel(system)}
              </Chip>
            ))}
            {port.platforms?.map((platform) => {
              const system = platform.split("-")[0]!;
              return (
                <Chip key={`platform:${platform}`} style={identityStyle(system)} title="Runs on">
                  <IdentityIcon name={system} />
                  {platformLabel(platform)}
                </Chip>
              );
            })}
            {port.channels?.map((channel) => (
              <Chip
                key={`channel:${channel}`}
                style={identityStyle(channel, true)}
                title="Offered release channel"
              >
                <IdentityIcon name={channel} channel />
                {releaseChannelPresentation(channel).label}
              </Chip>
            ))}
          </div>
          <div className="detail-header-actions mt-5 flex flex-wrap items-center gap-2">
            {action(reveal)}
            {favoriteControl}
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    data-focusable
                    variant="outline"
                    size="icon-lg"
                    aria-label={`More actions for ${gameIdentityLabel(port)}`}
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
                      Change artwork
                    </Menu.Item>
                    {steam && (
                      <Menu.Item
                        className={`${controlFocus} cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`}
                        onClick={() =>
                          reveal(managementSection, "detail-steam", "[data-steam-shortcut]")
                        }
                      >
                        Steam shortcut
                      </Menu.Item>
                    )}
                    {projectUrl && (
                      <Menu.Item
                        className={`${controlFocus} block rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`}
                        onClick={() => reveal("overview", "detail-project-link", "a")}
                      >
                        Upstream project
                      </Menu.Item>
                    )}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <div data-detail-readiness className="detail-readiness">
              {readiness}
            </div>
            <span className="text-pc-muted-foreground" data-installation-fact>
              {installation}
            </span>
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
          aria-label="Game detail sections"
          className="detail-tab-list flex flex-wrap gap-x-7 gap-y-1 border-b border-pc-border"
        >
          {sections.map((section) => (
            <Tabs.Tab
              key={section}
              value={section}
              data-focusable
              className={`${controlFocus} detail-tab cursor-pointer border-b-2 border-transparent bg-transparent px-0 py-3 text-sm font-semibold text-pc-muted-foreground data-active:border-pc-interactive data-active:text-pc-interactive-foreground`}
            >
              {labels[section]}
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
              {labels[section]}
            </h2>
            {section === "overview" ? (
              <div className="detail-overview">
                <div className="detail-overview-main min-w-0">
                  {panels.overview}
                  <CatalogMediaGallery port={port} />
                  {overviewActions?.(reveal)}
                </div>
                <aside className="detail-overview-support min-w-0">
                  <section className="detail-requirements" aria-label="Requirements">
                    <h3 className="mb-4 text-base">Requirements</h3>
                    {overviewRequirements ?? (
                      <p className="text-sm text-pc-muted-foreground">
                        Review Game files and the upstream instructions for this port’s
                        requirements.
                      </p>
                    )}
                  </section>
                  {(projectUrl || openSupport) && (
                    <section className="detail-resources" aria-label="Project & support">
                      <h3 className="mb-3 text-base">Project & support</h3>
                      {projectUrl && (
                        <div id="detail-project-link" tabIndex={-1}>
                          <ExternalLink
                            href={projectUrl}
                            className="flex w-full gap-2.5 border-b border-pc-border py-3 text-xs"
                          >
                            <ArrowUpRight aria-hidden="true" />
                            <span>Open upstream project</span>
                          </ExternalLink>
                        </div>
                      )}
                      {openSupport && (
                        <Button
                          variant="link"
                          className="w-full justify-start rounded-none border-b border-pc-border px-0 py-3 text-start text-xs"
                          onClick={openSupport}
                        >
                          <FileText aria-hidden="true" />
                          <span>Create support report</span>
                        </Button>
                      )}
                      {openSupport && (
                        <p className="mt-3 max-w-prose text-sm text-pc-muted-foreground">
                          Save and review a sanitized report locally before choosing to share it.
                        </p>
                      )}
                    </section>
                  )}
                </aside>
              </div>
            ) : (
              panels[section]
            )}
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </section>
  );
}
