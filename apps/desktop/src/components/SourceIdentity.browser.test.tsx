import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { act, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { copyText } from "../clipboard";
import type { SourceInspectionReport } from "../types";
import { focusableControls } from "../focus";
import { SourceIdentityPanel } from "./SourceIdentity";

vi.mock("../clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import {
  sourceInspectionIdentityFixture as report,
  sourceIdentityCalculatedSha as calculatedSha,
} from "../test-fixtures";

describe("source identity controls", () => {
  let root: RenderResult;
  let host: HTMLDivElement;
  beforeEach(async () => {
    vi.mocked(copyText).mockReset().mockResolvedValue(undefined);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 100, 40),
    ] as unknown as DOMRectList);
    host = document.createElement("div");
    document.body.append(host);
    root = await renderComponent(null, { container: document.body.appendChild(host) });
  });
  afterEach(async () => {
    await cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("announces digest clipboard failure and keeps an exact manual fallback until retry succeeds", async () => {
    vi.mocked(copyText).mockRejectedValueOnce(new Error("private clipboard cause"));
    await root.rerender(<SourceIdentityPanel report={report()} />);
    const copy = host.querySelector<HTMLButtonElement>(
      "[aria-label='Copy Calculated SHA256 for normalized content']",
    )!;
    await act(async () => copy.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Clipboard unavailable");
    const fallback = host.querySelector<HTMLInputElement>(
      "[aria-label='Calculated SHA256 for normalized content for manual copy']",
    )!;
    expect(fallback.readOnly).toBe(true);
    expect(fallback.value).toBe(calculatedSha);
    expect(copyText).toHaveBeenLastCalledWith(calculatedSha);
    expect(host.textContent).not.toContain("private clipboard cause");
    await act(async () => copy.click());
    expect(host.textContent).toContain("Calculated SHA256 for normalized content copied.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[aria-label$="for manual copy"]')).toBeNull();
  });

  it.each(["copied", "failed"])(
    "does not show previous %s feedback on the first committed replacement render",
    async (outcome) => {
      if (outcome === "failed") vi.mocked(copyText).mockRejectedValueOnce(new Error("unavailable"));
      const observations: string[] = [];
      function Observed({ value }: { value: SourceInspectionReport }) {
        useLayoutEffect(() => {
          observations.push(host.textContent ?? "");
        });
        return <SourceIdentityPanel report={value} />;
      }
      await root.rerender(<Observed value={report()} />);
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            "[aria-label='Copy Calculated SHA256 for normalized content']",
          )!
          .click(),
      );
      const next = JSON.parse(
        JSON.stringify(report()).replaceAll(calculatedSha, "c".repeat(64)),
      ) as SourceInspectionReport;
      await root.rerender(<Observed value={next} />);
      expect(observations.at(-1)).toContain("c".repeat(64));
      expect(observations.at(-1)).not.toContain("content copied.");
      expect(observations.at(-1)).not.toContain("Clipboard unavailable");
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores an older digest copy %s after retry and content replacement",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      vi.mocked(copyText).mockReturnValueOnce(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      await root.rerender(<SourceIdentityPanel report={report()} />);
      const button = () =>
        host.querySelector<HTMLButtonElement>(
          "[aria-label='Copy Calculated SHA256 for normalized content']",
        )!;
      await act(async () => button().click());
      await act(async () => button().click());
      expect(host.textContent).toContain("Calculated SHA256 for normalized content copied.");
      const next = JSON.parse(
        JSON.stringify(report()).replaceAll(calculatedSha, "c".repeat(64)),
      ) as SourceInspectionReport;
      await root.rerender(<SourceIdentityPanel report={next} />);
      await act(async () => (outcome === "resolve" ? resolve() : reject(new Error("old attempt"))));
      expect(host.textContent).not.toContain("content copied.");
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await act(async () => button().click());
      expect(copyText).toHaveBeenLastCalledWith("c".repeat(64));
    },
  );

  it("offers the matching disc-tool route only when the source problem names a tool", async () => {
    const openHostTool = vi.fn();
    const missingTool = report("source_could_not_be_checked");
    missingTool.problem = {
      code: "source_invalid",
      message: "The disc checker is unavailable.",
      tool_id: "chdman",
    };
    await root.rerender(<SourceIdentityPanel report={missingTool} openHostTool={openHostTool} />);
    const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Review disc tool settings",
    );
    expect(link).toBeDefined();
    expect(focusableControls(host)).toContain(link);
    await act(async () => link!.click());
    expect(openHostTool).toHaveBeenCalledExactlyOnceWith("chdman");

    missingTool.problem = { code: "source_invalid", message: "The file could not be read." };
    await root.rerender(<SourceIdentityPanel report={missingTool} openHostTool={openHostTool} />);
    expect(host.textContent).not.toContain("Review disc tool settings");
  });

  it("keeps copy and evidence controls named, keyboard reachable, and focused across a current report refresh", async () => {
    const open = vi.fn();
    await root.rerender(<SourceIdentityPanel report={report()} openEvidence={open} />);
    const details = host.querySelector("details")!;
    details.open = true;
    const copy = host.querySelector<HTMLButtonElement>(
      "[aria-label='Copy Calculated SHA256 for normalized content']",
    )!;
    const evidence = host.querySelector<HTMLButtonElement>(
      "[aria-label='Open reviewed evidence from Sample authority']",
    )!;
    expect(copy.tabIndex).toBe(0);
    expect(evidence.tabIndex).toBe(0);
    expect(host.querySelector("summary")?.hasAttribute("data-focusable")).toBe(true);
    for (
      let disclosure = copy.closest("details");
      disclosure;
      disclosure = disclosure.parentElement?.closest("details") ?? null
    )
      disclosure.open = true;
    copy.focus();
    expect(document.activeElement).toBe(copy);
    await root.rerender(<SourceIdentityPanel report={report()} openEvidence={open} />);
    expect(document.activeElement).toBe(copy);
    await act(async () => evidence.click());
    expect(open).toHaveBeenCalledWith("identity-proof");
  });

  it("puts disclosure, copy, and evidence actions in the shared keyboard and controller inventory", async () => {
    await root.rerender(<SourceIdentityPanel report={report()} openEvidence={vi.fn()} />);
    host.querySelector("details")!.open = true;
    const names = focusableControls(host).map(
      (control) => control.getAttribute("aria-label") ?? control.textContent,
    );
    expect(names).toContain("Full identity and evidence");
    expect(names).toContain("Copy Calculated SHA256 for normalized content");
    expect(names).toContain("Open reviewed evidence from Sample authority");
  });
});
