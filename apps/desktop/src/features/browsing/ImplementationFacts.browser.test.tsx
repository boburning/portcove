import { render, cleanup } from "vitest-browser-react";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { ImplementationFacts } from "./ImplementationFacts";
import { portDefinition } from "../../test-fixtures";
import { captureParityState } from "../../../test/parity-capture";

afterEach(cleanup);
it("opens method and shared runtime evidence with the keyboard and renders untrusted copy as text", async () => {
  const port = { ...portDefinition(), name: "Example game" };
  port.presentation = {
    ...port.presentation!,
    implementation: {
      format_version: 1,
      methods: [
        {
          kind: "engine-reimplementation",
          evidence_urls: ["https://www.scummvm.org/faq/"],
          note: "<img src=x onerror=alert(1)>",
        },
      ],
      dependencies: [
        {
          kind: "runtime",
          name: "ScummVM",
          project_url: "https://www.scummvm.org",
          confidence: "inferred",
          version_scope: "Documentation fixture",
          evidence_urls: ["https://www.scummvm.org/faq/"],
        },
      ],
    },
  };
  await render(<ImplementationFacts port={port} />);
  const summary = page.getByText("How this project works — Example game", { exact: true });
  const element = summary.element() as HTMLElement;
  element.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Engine reimplementation", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Unconfirmed relationship", { exact: false })).toBeVisible();
  expect(document.querySelector("details img")).toBeNull();
  await expect
    .element(page.getByText("<img src=x onerror=alert(1)>", { exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(document.querySelector("details")?.open).toBe(false);
});
it("omits future metadata without changing neighboring setup controls", async () => {
  const port = portDefinition();
  port.presentation = {
    ...port.presentation!,
    implementation: { format_version: 999, methods: [], dependencies: [] },
  };
  await render(
    <>
      <ImplementationFacts port={port} />
      <button type="button">Set up</button>
    </>,
  );
  expect(document.querySelector("details")).toBeNull();
  await expect.element(page.getByRole("button", { name: "Set up" })).toBeEnabled();
});

it.each([
  { width: 430, theme: "light" },
  { width: 960, theme: "dark" },
])(
  "keeps complete implementation evidence within the $width px $theme consumer",
  async ({ width, theme }) => {
    const previousViewport = { width: innerWidth, height: innerHeight };
    const previousTheme = document.documentElement.dataset.theme;
    const note =
      "SYNTHETIC text-safety/content extreme: <img src=x onerror=alert(1)> " +
      "LongUnbrokenDiagnostic".repeat(12);
    const versionScope = "SYNTHETIC scope " + "RevisionScope".repeat(16);
    const dependencyName = "SYNTHETIC" + "SharedRuntime".repeat(8);
    const port = { ...portDefinition(), name: "SYNTHETIC metadata edge fixture" };
    port.presentation = {
      ...port.presentation!,
      implementation: {
        format_version: 1,
        methods: [
          {
            kind: "engine-reimplementation",
            evidence_urls: ["https://example.invalid/method"],
            note,
          },
        ],
        dependencies: [
          {
            kind: "runtime",
            name: dependencyName,
            project_url: "https://example.invalid/runtime",
            confidence: "inferred",
            version_scope: versionScope,
            note,
            evidence_urls: ["https://example.invalid/relationship"],
          },
        ],
      },
    };
    try {
      await page.viewport(width, 780);
      document.documentElement.dataset.theme = theme;
      await render(
        <main className="grid min-w-0 px-4">
          <section className="detail-evidence" aria-label="Project information and checks">
            <ImplementationFacts port={port} />
            <button type="button">Set up</button>
          </section>
        </main>,
      );
      const summary = page.getByText(`How this project works — ${port.name}`, { exact: true });
      const opener = summary.element() as HTMLElement;
      opener.focus();
      await userEvent.keyboard("{Enter}");
      await expect
        .element(page.getByText(`Applies to: ${versionScope}`, { exact: true }))
        .toBeVisible();
      const facts = document.querySelector("details")!;
      await expect
        .poll(() => document.documentElement.scrollWidth - innerWidth)
        .toBeLessThanOrEqual(1);
      expect(document.querySelector("main")!.scrollWidth).toBeLessThanOrEqual(width);
      const bounds = facts.getBoundingClientRect();
      for (const content of facts.querySelectorAll("summary, li, p, a")) {
        const range = document.createRange();
        range.selectNodeContents(content);
        const rectangles = [...range.getClientRects()];
        expect(rectangles.length).toBeGreaterThan(0);
        for (const rectangle of rectangles) {
          expect(rectangle.left).toBeGreaterThanOrEqual(bounds.left - 1);
          expect(rectangle.right).toBeLessThanOrEqual(bounds.right + 1);
        }
      }
      expect(facts.textContent).toContain(note);
      expect(facts.textContent).toContain(`Applies to: ${versionScope}`);
      expect(facts.textContent).toContain(dependencyName);
      expect(facts.textContent).toContain("Unconfirmed relationship");
      expect(facts.querySelector("img")).toBeNull();
      const methodNote = facts.querySelector("li > p")!;
      expect(methodNote.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(getComputedStyle(methodNote).lineHeight),
      );
      await expect.element(page.getByRole("button", { name: "Set up" })).toBeEnabled();
      opener.scrollIntoView({ block: "start" });
      await captureParityState("implementation-facts-complete-wrapped-evidence");
      opener.focus();
      await userEvent.keyboard("{Enter}");
      expect(facts.open).toBe(false);
      expect(document.activeElement).toBe(opener);
    } finally {
      await page.viewport(previousViewport.width, previousViewport.height);
      if (previousTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previousTheme;
    }
  },
);
