import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useGamepadNavigation } from "../gamepad";

function Navigation() {
  useGamepadNavigation(() => {});
  return null;
}

it("moves down from a programmatically focused heading into its category without adding a tab stop", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const workspace = document.createElement("main");
  workspace.dataset.focusRegion = "workspace";
  workspace.innerHTML = `
    <button style="position:fixed;left:20px;top:10px">Commands</button>
    <section data-settings-group="game-files" style="position:fixed;left:20px;top:100px">
      <h2 tabindex="-1" style="margin:0;height:30px">Game files</h2>
      <button style="display:block;margin-top:10px">Add folder</button>
    </section>`;
  document.body.append(workspace);
  try {
    flushSync(() => root.render(<Navigation />));
    const heading = workspace.querySelector("h2")!;
    const add = workspace.querySelector("section button")!;
    heading.focus();
    expect(document.activeElement).toBe(heading);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(add);
    expect(heading.tabIndex).toBe(-1);
    expect(
      document.activeElement?.closest("[data-settings-group]")?.getAttribute("data-settings-group"),
    ).toBe("game-files");
  } finally {
    flushSync(() => root.unmount());
    workspace.remove();
    host.remove();
    delete document.documentElement.dataset.inputMode;
  }
});
