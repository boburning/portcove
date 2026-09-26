// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { focusDiscTool } from "./focus-disc-tool";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("focuses the named host tool action and falls back to the disc tools heading", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const heading = document.createElement("h2");
  heading.id = "disc-tools-heading";
  heading.tabIndex = -1;
  const other = document.createElement("div");
  other.dataset.hostToolId = "other";
  const otherAction = document.createElement("button");
  other.append(otherAction);
  const matching = document.createElement("div");
  matching.dataset.hostToolId = "chdman";
  matching.tabIndex = -1;
  const disabled = document.createElement("button");
  disabled.disabled = true;
  const locate = document.createElement("button");
  matching.append(disabled, locate);
  document.body.append(heading, other, matching);

  focusDiscTool("chdman");
  expect(document.activeElement).toBe(locate);
  focusDiscTool("unknown");
  expect(document.activeElement).toBe(heading);
  focusDiscTool();
  expect(document.activeElement).toBe(heading);
  locate.disabled = true;
  focusDiscTool("chdman");
  expect(document.activeElement).toBe(matching);
});
