import assert from "node:assert/strict";

export function readStagedLayout(version: string) {
  const detail = document.querySelector("[data-detail-workspace]");
  const play = detail?.querySelector<HTMLButtonElement>(
    ".detail-header-actions [data-confirmed-play]",
  );
  const panel = detail?.querySelector<HTMLElement>("[role=tabpanel]:not([hidden]):not([inert])");
  const activate = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (item) => item.textContent?.trim() === `Use update · ${version}`,
  );
  const rect = (element: Element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return { left, right, top, bottom };
  };
  const action = (element: HTMLButtonElement) => ({
    ...rect(element),
    enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
    visible:
      !element.closest("[hidden], [inert]") &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible",
  });
  return {
    play: play && action(play),
    activate: activate && action(activate),
    header: play?.closest(".detail-hero") && rect(play.closest(".detail-hero")!),
    panel: panel && rect(panel),
    versionsSelected:
      detail?.querySelector("[role=tab][aria-selected=true]")?.textContent?.trim() ===
      "Versions & updates",
    viewport: { width: innerWidth, height: innerHeight },
    state: detail?.querySelector("[data-detail-readiness]")?.textContent?.trim(),
    reason: detail?.querySelector("[data-detail-reason]")?.textContent?.trim(),
    attention: detail?.querySelector("[data-update-attention]")?.textContent?.trim(),
    documentOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
}

export function assertStagedActionPlacement(layout: ReturnType<typeof readStagedLayout>) {
  const message = JSON.stringify(layout);
  assert.ok(layout.play && layout.activate && layout.header && layout.panel, message);
  assert.equal(layout.versionsSelected, true, message);
  assert.equal(layout.state, "Ready to play", message);
  assert.ok(layout.attention, message);
  assert.equal(layout.documentOverflow, false, message);
  const { play, activate, header, panel, viewport } = layout;
  assert.ok(
    Number.isFinite(viewport.width) &&
      viewport.width > 0 &&
      Number.isFinite(viewport.height) &&
      viewport.height > 0,
    message,
  );
  for (const [action, owner] of [
    [play, header],
    [activate, panel],
  ] as const) {
    assert.equal(action.enabled, true, message);
    assert.equal(action.visible, true, message);
    assert.ok(
      [
        action.left,
        action.right,
        action.top,
        action.bottom,
        owner.left,
        owner.right,
        owner.top,
        owner.bottom,
      ].every(Number.isFinite),
      message,
    );
    assert.ok(action.right > action.left && action.bottom > action.top, message);
    assert.ok(
      action.left >= Math.max(0, owner.left) - 1 &&
        action.right <= Math.min(viewport.width, owner.right) + 1,
      message,
    );
    assert.ok(action.top >= owner.top - 1 && action.bottom <= owner.bottom + 1, message);
  }
  assert.ok(play.bottom <= panel.top + 1, message);
}
