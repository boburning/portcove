import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { StatusLayer } from "./Chrome";
import type { InvocationRecord } from "../features/operations/invocation-state";

afterEach(async () => {
  await cleanup();
});

const record = (name: string, action: string, operation?: "launch"): InvocationRecord => ({
  id: 7,
  name,
  phase: "settled",
  outcome: "succeeded",
  context: {
    action,
    ...(operation ? { operation } : {}),
    target: { kind: "port", id: "harbor", label: "Harbor Adventure" },
    libraryGeneration: 1,
    exclusionScope: "target",
  },
});

it("hands a ready game back to the player with Play after setup finishes", async () => {
  const play = vi.fn();
  const dismissInvocation = vi.fn();
  const readyToPlay = vi.fn(() => play);
  await render(
    <StatusLayer
      clearError={vi.fn()}
      invocations={new Map([[7, record("prepare game data", "Finish setup")]])}
      dismissInvocation={dismissInvocation}
      openActivity={vi.fn()}
      readyToPlay={readyToPlay}
    />,
  );
  await expect
    .element(page.getByText("Harbor Adventure is ready to play.", { exact: true }))
    .toBeVisible();
  expect(document.querySelector('[data-slot="notice-body"]')?.textContent).toBe(
    "Harbor Adventure is ready to play.",
  );
  const button = page.getByRole("button", { name: "Play: Harbor Adventure", exact: true });
  await expect.element(button).toHaveAttribute("data-variant", "primary");
  await button.click();
  expect(play).toHaveBeenCalledOnce();
  expect(dismissInvocation).toHaveBeenCalledWith(7);
});

it("keeps the factual completion when current readback does not report the game ready", async () => {
  await render(
    <StatusLayer
      clearError={vi.fn()}
      invocations={new Map([[7, record("prepare game data", "Finish setup")]])}
      dismissInvocation={vi.fn()}
      openActivity={vi.fn()}
      readyToPlay={() => undefined}
    />,
  );
  await expect
    .poll(() => document.querySelector('[data-slot="notice-body"]')?.textContent)
    .toBe("Finish setup · Harbor Adventure: finished.");
  expect(page.getByRole("button", { name: /^Play/u }).query()).toBeNull();
});

it("announces launch acceptance without waiting for the game to start", async () => {
  const launch = record("launch", "Launch game", "launch");
  const notice = (invocation: InvocationRecord) => (
    <StatusLayer
      clearError={vi.fn()}
      invocations={new Map([[7, invocation]])}
      dismissInvocation={vi.fn()}
      openActivity={vi.fn()}
    />
  );
  const { id, name, context } = launch;
  const screen = await render(notice({ id, name, context, phase: "pending" }));
  const message = document.querySelector('[data-announcement-invocation-id="7"]');
  expect(message?.textContent).toBe("Launch game · Harbor Adventure: Starting game.");

  await screen.rerender(notice({ ...launch, phase: "pending" }));
  expect(message?.textContent).toBe("Launch requested for Harbor Adventure.");

  await screen.rerender(notice(launch));
  const group = document.querySelector<HTMLElement>('[data-invocation-id="7"]');
  await expect.poll(() => group?.className).toBe("sr-only");
  expect(document.querySelector('[data-announcement-invocation-id="7"]')).toBe(message);
  expect(message?.textContent).toBe("Launch requested for Harbor Adventure.");
  expect(document.querySelector('[data-slot="notice-body"]')).toBeNull();
});
