import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useGamepadNavigation } from "../gamepad";

function Navigation() {
  useGamepadNavigation(() => {});
  return null;
}

it.each([false, true])(
  "moves down from a focused category heading with sticky index=%s without adding a tab stop",
  async (stickyIndex) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const workspace = document.createElement("main");
    workspace.dataset.focusRegion = "workspace";
    workspace.innerHTML = `
    <button style="position:fixed;left:20px;top:10px">Commands</button>
    ${stickyIndex ? '<nav aria-label="Settings categories" style="position:fixed;left:20px;top:60px"><button>Updates</button></nav>' : ""}
    <section data-settings-group="game-files" aria-labelledby="game-files-heading" style="position:fixed;left:20px;top:${stickyIndex ? 0 : 100}px">
      <h2 id="game-files-heading" tabindex="-1" style="margin:0;height:30px">Game files</h2>
      <button style="display:block;margin-top:${stickyIndex ? 120 : 10}px">Add folder</button>
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
        document.activeElement
          ?.closest("[data-settings-group]")
          ?.getAttribute("data-settings-group"),
      ).toBe("game-files");
    } finally {
      flushSync(() => root.unmount());
      workspace.remove();
      host.remove();
      delete document.documentElement.dataset.inputMode;
    }
  },
);
