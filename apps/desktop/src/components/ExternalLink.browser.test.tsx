import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { ExternalLink } from "./ExternalLink";

let root: RenderResult;
let container: HTMLDivElement;

// Match the application's ES2022 test baseline.
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

it("reports a failed browser launch with the exact failure text in the current language", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  // A failure that looks like markup or interpolation must render verbatim.
  vi.spyOn(desktopApi, "openExternalUrl").mockRejectedValue(new Error("no handler {{x}} <b>"));
  await act(async () => {
    await root.rerender(<ExternalLink href="https://example.invalid">Project page</ExternalLink>);
  });
  await act(async () => container.querySelector("a")?.click());
  const alert = () => container.querySelector('[role="alert"]');
  await expect
    .poll(() => alert()?.textContent)
    .toBe("Couldn’t open the browser: no handler {{x}} <b>");
  try {
    await act(async () => {
      await localization.changeLanguage("ar-XB");
    });
    await expect.poll(() => alert()?.textContent).toBe("تعذر فتح المتصفح: no handler {{x}} <b>");
    expect(alert()?.querySelector("bdi")?.textContent).toBe("no handler {{x}} <b>");
  } finally {
    await act(async () => {
      await localization.changeLanguage("en");
    });
  }
});

it.each(["pending", "succeeded", "failed"] as const)(
  "ignores an older failure when the latest open is %s",
  async (outcome) => {
    const first = deferred();
    const second = deferred();
    const openUrl = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const href = "https://example.invalid/project?name=exact%20value";
    await root.rerender(
      <ExternalLink href={href} openUrl={openUrl}>
        Project page
      </ExternalLink>,
    );
    await act(async () => {
      container.querySelector("a")!.click();
      container.querySelector("a")!.click();
    });
    const settleLatest = {
      pending: () => {},
      succeeded: () => second.resolve(),
      failed: () => second.reject(new Error("current failure")),
    };
    await act(async () => settleLatest[outcome]());
    await act(async () => first.reject(new Error("old failure")));
    expect(container.querySelector('[role="alert"]')?.textContent ?? null).toBe(
      outcome === "failed" ? "Couldn’t open the browser: current failure" : null,
    );
    expect(openUrl.mock.calls).toEqual([[href], [href]]);
    await act(async () => second.resolve());
  },
);

it("keeps a current failure when an older open succeeds later", async () => {
  const first = deferred();
  const second = deferred();
  const openUrl = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await root.rerender(
    <ExternalLink href="https://example.invalid" openUrl={openUrl}>
      Project page
    </ExternalLink>,
  );
  await act(async () => {
    container.querySelector("a")!.click();
    container.querySelector("a")!.click();
  });
  await act(async () => second.reject(new Error("current failure")));
  await act(async () => first.resolve());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn’t open the browser: current failure",
  );
});

it("clears a previous destination's error while retaining the focused anchor", async () => {
  const openUrl = vi.fn().mockRejectedValue(new Error("old destination failure"));
  await root.rerender(
    <ExternalLink href="https://example.invalid/first" openUrl={openUrl}>
      Project page
    </ExternalLink>,
  );
  const anchor = container.querySelector("a")!;
  anchor.focus();
  await act(async () => anchor.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "old destination failure",
  );
  await root.rerender(
    <ExternalLink href="https://example.invalid/second" openUrl={openUrl}>
      Project page
    </ExternalLink>,
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("a")).toBe(anchor);
  expect(document.activeElement).toBe(anchor);
});

it("invalidates a pending failure after changing away from and back to its URL", async () => {
  const first = deferred();
  const openUrl = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const renderLink = (href: string) =>
    root.rerender(
      <ExternalLink href={href} openUrl={openUrl}>
        Project page
      </ExternalLink>,
    );
  await renderLink("https://example.invalid/first");
  await act(async () => container.querySelector("a")!.click());
  await renderLink("https://example.invalid/second");
  await renderLink("https://example.invalid/first");
  await act(async () => first.reject(new Error("previous visit failure")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => container.querySelector("a")!.click());
  expect(openUrl.mock.calls).toEqual([
    ["https://example.invalid/first"],
    ["https://example.invalid/first"],
  ]);
});

it("clears feedback and invalidates pending responses when the opener changes", async () => {
  const pending = deferred();
  const firstOpener = vi
    .fn()
    .mockRejectedValueOnce(new Error("old opener failure"))
    .mockReturnValueOnce(pending.promise);
  const nextOpener = vi.fn().mockRejectedValue(new Error("new opener failure"));
  await root.rerender(
    <ExternalLink href="https://example.invalid" openUrl={firstOpener}>
      Project page
    </ExternalLink>,
  );
  await act(async () => container.querySelector("a")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("old opener failure");
  await act(async () => container.querySelector("a")!.click());
  await root.rerender(
    <ExternalLink href="https://example.invalid" openUrl={nextOpener}>
      Project page
    </ExternalLink>,
  );
  await act(async () => pending.reject(new Error("stale opener failure")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => container.querySelector("a")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("new opener failure");
});

it("does not publish an unmounted link's failure into a remounted link", async () => {
  const pending = deferred();
  const openUrl = vi.fn().mockReturnValue(pending.promise);
  const link = (
    <ExternalLink href="https://example.invalid" openUrl={openUrl}>
      Project page
    </ExternalLink>
  );
  await root.rerender(link);
  await act(async () => container.querySelector("a")!.click());
  await root.rerender(null);
  await root.rerender(link);
  await act(async () => pending.reject(new Error("unmounted failure")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
