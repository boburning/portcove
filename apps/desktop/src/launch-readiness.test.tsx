import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { DetailPanel } from "./components/DetailPanel";
import { PortBrowser } from "./components/PortBrowser";
import { actions } from "./components/rendered-test-fixtures";
import { portDefinition, installedLaunchStatus, confirmedSourceAssessment } from "./test-fixtures";
import { summarizeLibrary } from "./view-model";

const port = { ...portDefinition(), source_profile: "owned-source" };

it.each([false, true])(
  "keeps byte health and clean process history separate from compatibility: confirmed=%s",
  (confirmed) => {
    const status = installedLaunchStatus({
      launchable: true,
      blockers: [],
      pending_setup: false,
      source: "current",
      ...(confirmed ? { source_assessment: confirmedSourceAssessment("owned-source") } : {}),
    });
    status.successful_launches = 999;
    const detail = renderToStaticMarkup(
      <DetailPanel
        port={port}
        status={status}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    expect(detail.includes("Compatibility unconfirmed")).toBe(!confirmed);
    expect(detail.includes(">Try launch</button>")).toBe(!confirmed);
    expect(detail.includes("Ready to play")).toBe(confirmed);
    const card = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={summarizeLibrary([port], new Map([[port.id, status]]))}
        recent={{ port, status }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        onContinue={vi.fn()}
        loading={false}
      />,
    );
    expect(card.includes("Compatibility unconfirmed")).toBe(!confirmed);
    expect(card.includes("Play again")).toBe(confirmed);
  },
);

it.each(["blocker", "action"] as const)(
  "does not offer card or Continue launch from contradictory %s claims",
  (kind) => {
    const status = installedLaunchStatus({
      launchable: true,
      blockers: kind === "blocker" ? ["missing_source"] : [],
      pending_setup: false,
      source: "current",
      source_assessment: confirmedSourceAssessment("owned-source"),
    });
    if (kind === "action")
      status.port_actions = [
        { action: "launch", availability: "held", reason: "invalid_installation" },
      ];
    const html = renderToStaticMarkup(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={summarizeLibrary([port], new Map([[port.id, status]]))}
        recent={{ port, status }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        onContinue={vi.fn()}
        loading={false}
      />,
    );
    expect(html).not.toContain(">Play</button>");
    expect(html).not.toContain("Play again");
    expect(html).not.toContain("Ready to play");
    expect(html).not.toContain("All can launch");
    expect(html).toContain("Review launch");
  },
);
