import { fixtureValue } from "../../test-fixtures";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { BrowsingMatchDetails } from "./BrowsingMatchDetails";
import type { CatalogBrowsingContext } from "../../types";
import type { CatalogQueryResult } from "./catalog-query";
import type { GameFileFilterContext } from "./game-file-query-context";

it.each(["first-workspace", "changed-workspace"])(
  "requires a fresh choice when an explicit context disappears under %s",
  async (replacementBinding) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const installed: CatalogBrowsingContext = {
      context_id: "a".repeat(64),
      port_id: "port",
      route: "managed_launch",
      platform: "windows-x86-64",
      channel: "stable",
      installation_method: "referenced-disc",
      port_member: true,
      member_context: true,
      installation_id: "retained",
      definition_sha256: "b".repeat(64),
      instance_sha256: "c".repeat(64),
      release_version: "old",
      artifact_sha256: "d".repeat(64),
    };
    const unknown = {
      ...installed,
      context_id: "e".repeat(64),
      platform: null,
      installation_method: null,
    };
    const result: CatalogQueryResult = {
      state: "matched",
      query: { version: 1 },
      ports: [],
      counts: {} as CatalogQueryResult["counts"],
      matchingContexts: new Map([["port", [installed, unknown]]]),
    };
    let gameFiles: GameFileFilterContext | undefined;
    const render = async (binding: string) =>
      act(async () =>
        root.render(
          <BrowsingMatchDetails
            portId="port"
            result={result}
            binding={binding}
            gameFiles={gameFiles}
          />,
        ),
      );
    try {
      await render("first-workspace");
      const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(
        true,
      );
      await act(async () => fixtureValue(buttons()[1], "buttons()[1]").click());
      expect(host.textContent).toContain("Retained setup method unknown");
      expect(host.textContent).toContain("observation unavailable");
      await render("first-workspace");
      expect(fixtureValue(buttons()[1], "buttons()[1]").getAttribute("aria-pressed")).toBe("true");
      result.matchingContexts = new Map([["port", [installed]]]);
      await render(replacementBinding);
      expect(buttons().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(
        true,
      );
      expect(host.textContent).not.toContain("Retained setup method unknown");
      expect(host.textContent).toContain("Your previous choice is no longer current");
      expect(host.textContent).not.toContain("This is the matching retained installation");
      await act(async () => fixtureValue(buttons()[0], "buttons()[0]").click());
      expect(fixtureValue(buttons()[0], "buttons()[0]").getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain("This is the matching retained installation");
      gameFiles = {
        libraryKey: "selected",
        library: { id: "opaque", root: "selected" },
        selection: { route: "managed_launch", platform: "windows-x86-64", channel: "stable" },
        observedAt: 1,
        expiresAt: 100,
        byPort: new Map([
          [
            "port",
            {
              port_id: "port",
              route: "managed_launch",
              platform: "windows-x86-64",
              channel: "stable",
              state: "files_available",
              reason: "complete_compatible_observation",
              contract_id: "reviewed",
              identity: { game_id: "game", variant_id: "variant", representation_id: "complete" },
              source_instance_sha256: "f".repeat(64),
              route_definition_sha256: installed.definition_sha256,
              route_instance_sha256: installed.instance_sha256,
            },
          ],
        ]),
      };
      await render(replacementBinding);
      expect(host.textContent).toContain("Complete set: game / variant / complete");
      const observed = gameFiles.byPort.get("port")!;
      gameFiles = {
        ...gameFiles,
        byPort: new Map([["port", { ...observed, route_instance_sha256: "0".repeat(64) }]]),
      };
      await render(replacementBinding);
      expect(host.textContent).not.toContain("Complete set:");
      expect(host.textContent).toContain("observation unavailable");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);
