import { Tabs } from "@base-ui/react/tabs";
import { Menu } from "@base-ui/react/menu";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
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
import { ArtworkImage } from "./Artwork";
import { ExternalLink } from "./ExternalLink";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { controlFocus } from "./ui/control-style";

const labels: Record<DetailSection, string> = {
  overview: "Overview",
  files: "Files",
  saves: "Saved data",
  versions: "Versions",
};
type Identity = PortIdentity & { id: string };
export type RevealDetailSection = (
  section: DetailSection,
  targetId?: string,
  control?: string,
) => void;

/** Presentation only: all eligibility and stateful workflow owners stay with the caller. */
export function DetailLayout({
  port,
  projectUrl,
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
  port: Identity;
  projectUrl?: string | undefined;
  opening?: DetailOpening | undefined;
  initialSection: DetailSection;
  readiness: ReactNode;
  installation: string;
  action: (reveal: RevealDetailSection) => ReactNode;
  attention?: ((reveal: RevealDetailSection) => ReactNode) | undefined;
  close: () => void;
  steam?: boolean | undefined;
  children: (reveal: RevealDetailSection) => Record<DetailSection, ReactNode>;
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
  return (
    <section
      ref={root}
      className="detail-panel @container/detail relative w-full min-w-0"
      aria-labelledby="port-detail-title"
      data-detail-workspace
      data-detail-port-id={port.id}
      data-detail-opening={identity}
    >
      <Button
        data-focusable
        className="detail-back mb-6"
        variant="ghost"
        size="sm"
        aria-label="Back to previous workspace"
        onClick={close}
      >
        <Icon glyph={ArrowLeft} /> Back
      </Button>
      <div className="detail-hero">
        <ArtworkImage
          port={port}
          quietFallback
          className="detail-cover rounded-pc-md border border-pc-border"
        />
        <div className="detail-identity min-w-0 [overflow-wrap:anywhere]">
          <h1
            id="port-detail-title"
            tabIndex={-1}
            className="detail-title m-0 text-[length:var(--text-3xl)]"
          >
            {gameTitle(port)}
          </h1>
          {gameProjectLabel(port) && (
            <p className="mt-2 text-sm text-pc-muted-foreground">
              Port project: {gameProjectLabel(port)}
            </p>
          )}
          <div data-detail-readiness className="detail-readiness mt-4 text-sm">
            {readiness}
          </div>
          <div className="detail-header-actions mt-5 flex flex-wrap items-center gap-2">
            {action(reveal)}
            <Menu.Root>
              <Menu.Trigger
                render={
                  <Button
                    data-focusable
                    variant="outline"
                    size="icon"
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
                        reveal("files", "detail-artwork", ".artwork-controls > summary")
                      }
                    >
                      Change artwork
                    </Menu.Item>
                    {steam && (
                      <Menu.Item
                        className={`${controlFocus} cursor-default rounded-pc-sm px-3 py-2 text-sm data-highlighted:bg-pc-selection`}
                        onClick={() => reveal("files", "detail-steam", "[data-steam-shortcut]")}
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
          <p className="mt-3 text-xs text-pc-muted-foreground" data-installation-fact>
            {installation}
          </p>
        </div>
      </div>
      {attention && <div className="detail-attention my-6 text-sm">{attention(reveal)}</div>}
      <Tabs.Root
        value={selected}
        onValueChange={(value: unknown) => {
          if (detailSections.includes(value as DetailSection)) {
            setPending(undefined);
            setSelection({ identity, section: value as DetailSection });
          }
        }}
        className="detail-tabs mt-7"
      >
        <Tabs.List
          activateOnFocus={false}
          aria-label="Game detail sections"
          className="detail-tab-list flex flex-wrap gap-x-6 gap-y-1 border-b border-pc-border"
        >
          {detailSections.map((section) => (
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
        {detailSections.map((section) => (
          <Tabs.Panel
            key={section}
            value={section}
            keepMounted
            hidden={selected !== section}
            inert={selected !== section}
            className="detail-tab-panel min-w-0 pt-6 pb-10"
          >
            <h2 id={`detail-section-${section}`} tabIndex={-1} className="mb-5 text-xl">
              {labels[section]}
            </h2>
            {panels[section]}
            {section === "overview" && projectUrl && (
              <div id="detail-project-link" tabIndex={-1} className="mt-5">
                <ExternalLink href={projectUrl}>Open upstream project</ExternalLink>
              </div>
            )}
          </Tabs.Panel>
        ))}
      </Tabs.Root>
    </section>
  );
}
