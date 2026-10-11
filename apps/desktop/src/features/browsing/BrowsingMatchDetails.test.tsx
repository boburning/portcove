// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowsingMatchDetails } from "./BrowsingMatchDetails";
import type { CatalogBrowsingContext } from "../../types";
import type { CatalogQueryResult } from "./catalog-query";

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
    const render = async (binding: string) =>
      act(async () =>
        root.render(<BrowsingMatchDetails portId="port" result={result} binding={binding} />),
      );
    try {
      await render("first-workspace");
      const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(
        true,
      );
      await act(async () => buttons()[1]!.click());
      expect(host.textContent).toContain("Retained setup method unknown");
      expect(host.textContent).toContain("observation unavailable");
      await render("first-workspace");
      expect(buttons()[1]!.getAttribute("aria-pressed")).toBe("true");
      result.matchingContexts = new Map([["port", [installed]]]);
      await render(replacementBinding);
      expect(buttons().every((button) => button.getAttribute("aria-pressed") === "false")).toBe(
        true,
      );
      expect(host.textContent).not.toContain("Retained setup method unknown");
      expect(host.textContent).toContain("Your previous choice is no longer current");
      expect(host.textContent).not.toContain("This is the matching retained installation");
      await act(async () => buttons()[0]!.click());
      expect(buttons()[0]!.getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain("This is the matching retained installation");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);
