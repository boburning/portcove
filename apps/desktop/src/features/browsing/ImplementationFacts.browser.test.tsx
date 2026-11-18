import { render, cleanup } from "vitest-browser-react";
import { afterEach, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { ImplementationFacts } from "./ImplementationFacts";
import { portDefinition } from "../../test-fixtures";

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
