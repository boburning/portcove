import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { StrictMode } from "react";
import { controlledAct as act } from "../../test/controlled-react-act";
import { captureParityState } from "../../test/parity-capture";
import App from "../App";
import { desktopApi } from "../api";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import * as standingSetup from "../features/game-file-discovery/use-standing-setup";
import { initializeLocalization, LocalizationProvider } from "../localization";
import type { PortIntent, PortIntentMode } from "../types";
import { SetupIntentChoice } from "./SetupIntentChoice";
import "../styles/index.css";

vi.mock("../features/game-file-discovery/use-standing-setup", { spy: true });

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(() => {
  initializeLocalization(["en"]);
});
afterEach(async () => {
  await cleanup();
  document.getElementById("root")?.remove();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function intent(portId: string, mode: PortIntentMode = "notify"): PortIntent {
  return { format_version: 1, port_id: portId, mode, updated_at: 1 };
}

const choices = () => page.getByRole("group", { name: "When this game's files are ready" });
const radios = () => [
  ...choices().element().querySelectorAll<HTMLInputElement>("input[type=radio]"),
];

it("settles a refused read and retries once while retaining the recovery control and focus", async () => {
  const first = deferred<PortIntent[]>();
  const retry = deferred<PortIntent[]>();
  const refresh = deferred<PortIntent[]>();
  const read = vi
    .spyOn(desktopApi, "portIntents")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise)
    .mockReturnValueOnce(refresh.promise);
  const save = vi.spyOn(desktopApi, "setPortIntent");
  await render(<SetupIntentChoice portId="harbor" generation={7} />);
  await expect.element(choices()).toHaveAttribute("aria-busy", "true");
  await expect.element(choices().getByRole("status")).toHaveTextContent("Reading choices…");
  expect(radios().every((radio) => radio.disabled && !radio.checked)).toBe(true);
  await act(async () => first.reject(new Error("Controlled choice read refusal.")));
  await expect.element(choices()).toHaveAttribute("aria-busy", "false");
  expect(radios().every((radio) => radio.disabled && !radio.checked)).toBe(true);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Controlled choice read refusal.");
  const button = page.getByRole("button", { name: "Read again", exact: true }).element();
  if (!(button instanceof HTMLButtonElement))
    throw new Error("Expected the choice recovery button");
  button.focus();
  await act(async () => {
    button.click();
    button.click();
  });
  expect(read.mock.calls).toEqual([[7], [7]]);
  await expect.element(choices()).toHaveAttribute("aria-busy", "true");
  await expect.element(page.elementLocator(button)).toHaveFocus();
  await expect.element(page.elementLocator(button)).toHaveTextContent("Reading choices…");
  expect(radios().every((radio) => radio.disabled)).toBe(true);
  await act(async () =>
    retry.resolve([
      intent("other", "ignored"),
      { ...intent("harbor"), explicitly_uninstalled_at: 1 },
    ]),
  );
  await expect.element(choices()).toHaveAttribute("aria-busy", "false");
  await expect
    .element(page.getByRole("radio", { name: "Tell me when it's ready", exact: true }))
    .toBeChecked();
  expect(radios().every((radio) => !radio.disabled)).toBe(true);
  await expect.element(page.elementLocator(button)).toHaveFocus();
  await expect.element(page.elementLocator(button)).toHaveTextContent("Read again");
  expect(page.getByRole("alert").query()).toBeNull();
  await page.elementLocator(button).click();
  await act(async () => refresh.reject(new Error("Controlled refresh refusal.")));
  expect(read.mock.calls).toEqual([[7], [7], [7]]);
  await expect.element(choices()).toHaveAttribute("aria-busy", "false");
  await expect
    .element(page.getByRole("radio", { name: "Tell me when it's ready", exact: true }))
    .toBeChecked();
  expect(radios().every((radio) => radio.disabled)).toBe(true);
  await expect.element(page.getByRole("button", { name: /^Use “/ })).toBeDisabled();
  await expect.element(page.elementLocator(button)).toBeEnabled();
  await expect.element(page.elementLocator(button)).toHaveFocus();
  expect(save).not.toHaveBeenCalled();
});

it("keeps the current StrictMode read when the replayed owner rejects late", async () => {
  const old = deferred<PortIntent[]>();
  const current = deferred<PortIntent[]>();
  const read = vi
    .spyOn(desktopApi, "portIntents")
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise);
  await render(
    <StrictMode>
      <SetupIntentChoice portId="harbor" generation={7} />
    </StrictMode>,
  );
  expect(read.mock.calls).toEqual([[7], [7]]);
  await expect.element(choices()).toHaveAttribute("aria-busy", "true");
  await act(async () => current.resolve([intent("harbor", "ignored")]));
  await expect.element(choices()).toHaveAttribute("aria-busy", "false");
  await act(async () => old.reject(new Error("Retired StrictMode read refusal.")));
  await expect
    .element(page.getByRole("radio", { name: "Ignore this game", exact: true }))
    .toBeChecked();
  expect(radios().every((radio) => !radio.disabled)).toBe(true);
  await expect.element(choices()).toHaveAttribute("aria-busy", "false");
  expect(page.getByRole("alert").query()).toBeNull();
});

it("retains the confirmed choice through a save refusal and permits the same choice again", async () => {
  vi.spyOn(desktopApi, "portIntents").mockResolvedValue([intent("harbor")]);
  const save = vi
    .spyOn(desktopApi, "setPortIntent")
    .mockRejectedValueOnce(new Error("Controlled choice save refusal."))
    .mockResolvedValueOnce(intent("harbor", "ignored"));
  await render(<SetupIntentChoice portId="harbor" generation={7} />);
  const ignored = page.getByRole("radio", { name: "Ignore this game", exact: true });
  await ignored.click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Controlled choice save refusal.");
  await expect.element(choices()).toHaveAttribute("aria-busy", "false");
  await expect
    .element(page.getByRole("radio", { name: "Tell me when it's ready", exact: true }))
    .toBeChecked();
  expect(radios().every((radio) => !radio.disabled)).toBe(true);
  await ignored.click();
  await expect.element(ignored).toBeChecked();
  expect(save.mock.calls).toEqual([
    ["harbor", "ignored", 7],
    ["harbor", "ignored", 7],
  ]);
  expect(page.getByRole("alert").query()).toBeNull();
});

it("says when a temporary failure runs again and keeps a lasting one waiting for a change", async () => {
  const retryAfter = Math.floor(Date.UTC(2031, 0, 2, 3, 4) / 1000);
  vi.spyOn(desktopApi, "portIntents").mockResolvedValue([
    {
      ...intent("harbor", "set_up_when_ready"),
      failure: "the connection was reset",
      temporary_retry: { cause: "network", attempts: 1, retry_after: retryAfter },
    },
    {
      ...intent("lighthouse", "set_up_when_ready"),
      failure: "the archive was rejected",
    },
  ]);
  await render(<SetupIntentChoice portId="harbor" generation={7} />);
  const waiting = page.getByText("will try again automatically", { exact: false });
  await expect.element(waiting).toBeVisible();
  expect(waiting.element().textContent).not.toContain("files, catalog or requirements change");
  // The labelled next attempt is the exact instant, with its time zone.
  const time = waiting.element().querySelector("time");
  expect(waiting.element().textContent).toContain("Next attempt:");
  expect(time?.getAttribute("datetime")).toBe(new Date(retryAfter * 1000).toISOString());
  expect(time?.textContent).toMatch(/2031/);
  expect(time?.textContent).toMatch(/[A-Z]{2,}|GMT|UTC|[+-]\d/);
  await cleanup();

  await render(<SetupIntentChoice portId="lighthouse" generation={7} />);
  const lasting = page.getByText("the archive was rejected", { exact: false });
  await expect.element(lasting).toBeVisible();
  const paragraph = lasting.element().closest("p");
  expect(paragraph?.textContent).toContain("files, catalog or requirements change");
  expect(paragraph?.querySelector("time")).toBeNull();
});

it.each(["port", "generation"] as const)(
  "drops the old retry after replacing the %s context",
  async (change) => {
    const old = deferred<PortIntent[]>();
    const portId = change === "port" ? "orchard" : "harbor";
    const generation = change === "generation" ? 8 : 7;
    const read = vi
      .spyOn(desktopApi, "portIntents")
      .mockRejectedValueOnce(new Error("Old read refusal."))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([intent(portId, "ignored")]);
    const screen = await render(<SetupIntentChoice portId="harbor" generation={7} />);
    await page.getByRole("button", { name: "Read again", exact: true }).click();
    const oldButton = page.getByRole("button", { name: "Reading choices…", exact: true }).element();
    await screen.rerender(<SetupIntentChoice portId={portId} generation={generation} />);
    await expect
      .element(page.getByRole("radio", { name: "Ignore this game", exact: true }))
      .toBeChecked();
    await act(async () => old.reject(new Error("Late old retry refusal.")));
    expect(read.mock.calls).toEqual([[7], [7], [generation]]);
    expect(oldButton.isConnected).toBe(false);
    await expect.element(choices()).toHaveAttribute("aria-busy", "false");
    expect(page.getByRole("alert").query()).toBeNull();
    await expect
      .element(page.getByRole("radio", { name: "Ignore this game", exact: true }))
      .toBeChecked();
    expect(radios().every((radio) => !radio.disabled)).toBe(true);
  },
);

it("retains the saved automatic choice's standing pass when its view unmounts", async () => {
  vi.spyOn(desktopApi, "portIntents").mockResolvedValue([]);
  const pending = deferred<PortIntent>();
  const save = vi.spyOn(desktopApi, "setPortIntent").mockReturnValue(pending.promise);
  const standing = vi.spyOn(standingSetup, "requestStandingSetup");
  const screen = await render(<SetupIntentChoice portId="harbor" generation={7} />);
  await page.getByRole("radio", { name: "Set it up when it's ready", exact: true }).click();
  expect(save).toHaveBeenCalledExactlyOnceWith("harbor", "set_up_when_ready", 7);
  await screen.unmount();
  await act(async () => pending.resolve(intent("harbor", "set_up_when_ready")));
  expect(standing).toHaveBeenCalledExactlyOnceWith();
});

it.each([
  ["dark", 960, 640],
  ["light", 430, 780],
] as const)(
  "recovers the actual %s App Game files choices at %i×%i",
  async (theme, width, height) => {
    await page.viewport(width, height);
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    transport = installInteractiveTransport("details", (message) => {
      throw new Error(message);
    });
    const retry = deferred<PortIntent[]>();
    const diagnostic = `Could not read setup choices at C:\\Synthetic\\${"x".repeat(200)}\\choices.json`;
    const recordedFailure = `Controlled earlier setup failure: C:\\Synthetic\\${"y".repeat(200)}\\{{count}}.json`;
    const recoveredMode = theme === "dark" ? "set_up_when_ready" : "notify";
    const first = deferred<PortIntent[]>();
    const read = vi
      .spyOn(desktopApi, "portIntents")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(retry.promise);
    document.documentElement.dataset.theme = theme;
    await render(
      <LocalizationProvider api={desktopApi}>
        <App />
      </LocalizationProvider>,
      { container: root },
    );
    await expect
      .poll(() => document.querySelector('button[data-detail-game-id="details-ready"]'))
      .not.toBeNull();
    await page
      .elementLocator(
        document.querySelector<HTMLButtonElement>('button[data-detail-game-id="details-ready"]')!,
      )
      .click();
    await page.getByRole("tab", { name: "Game files", exact: true }).click();
    const field = choices().element();
    document.documentElement.dataset.theme = theme;
    const expectAlignedChoices = () => {
      const geometry = radios().map((radio) => {
        const bounds = radio.getBoundingClientRect();
        const copy = radio.nextElementSibling?.getBoundingClientRect();
        if (!copy) throw new Error("Expected radio label copy");
        return { width: bounds.width, height: bounds.height, copyLeft: copy.left };
      });
      expect(geometry).toHaveLength(4);
      for (const item of geometry) {
        expect(item.width).toBeGreaterThanOrEqual(12);
        expect(item.width).toBeCloseTo(item.height, 0);
        expect(item.width).toBeCloseTo(geometry[0]!.width, 1);
        expect(item.copyLeft).toBeCloseTo(geometry[0]!.copyLeft, 1);
      }
    };
    const expectContainedRecovery = async (target: HTMLElement | SVGElement) => {
      const bounds = field.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await expect.element(page.elementLocator(target)).toBeVisible();
      const recoveryBounds = target.getBoundingClientRect();
      expect(recoveryBounds.top).toBeGreaterThanOrEqual(0);
      expect(recoveryBounds.bottom).toBeLessThanOrEqual(innerHeight);
    };
    await expect.element(choices()).toHaveAttribute("aria-busy", "true");
    await expect.element(choices().getByRole("status")).toHaveTextContent("Reading choices…");
    expect(radios().every((radio) => radio.disabled && !radio.checked)).toBe(true);
    field.scrollIntoView({ block: "center", inline: "nearest" });
    expectAlignedChoices();
    await captureParityState("setup-intent-initial-reading");
    await act(async () => first.reject(new Error(diagnostic)));
    await expect.element(choices().getByRole("status")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Read again", exact: true }))
      .toBeEnabled();
    const button = page.getByRole("button", { name: "Read again", exact: true });
    const recovery = button.element();
    field.scrollIntoView({ block: "center", inline: "nearest" });
    await expect.element(page.getByRole("alert")).toHaveTextContent(diagnostic);
    await expect.element(choices()).toHaveAttribute("aria-busy", "false");
    await expectContainedRecovery(recovery);
    await captureParityState("setup-intent-read-refused");
    await button.click();
    await expect.element(choices()).toHaveAttribute("aria-busy", "true");
    await expectContainedRecovery(recovery);
    await captureParityState("setup-intent-read-retrying");
    await act(async () =>
      retry.resolve([{ ...intent("details-ready", recoveredMode), failure: recordedFailure }]),
    );
    await expect.element(choices()).toHaveAttribute("aria-busy", "false");
    await expect
      .element(
        page.getByRole("radio", {
          name: theme === "dark" ? "Set it up when it's ready" : "Tell me when it's ready",
          exact: true,
        }),
      )
      .toBeChecked();
    await expect
      .element(page.elementLocator(field).getByText(recordedFailure, { exact: true }))
      .toBeVisible();
    expect(read.mock.calls).toEqual([[1], [1]]);
    await expect.element(page.elementLocator(button.element())).toHaveFocus();
    await expectContainedRecovery(recovery);
    expectAlignedChoices();
    await captureParityState("setup-intent-read-recovered");
  },
);
