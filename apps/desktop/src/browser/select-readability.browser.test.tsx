import { fixtureValue } from "../test-fixtures";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import catalog from "../../../../crates/portcove-core/catalog/catalog.json";
import { SourceDiscoveryButton } from "../components/SourceDiscovery";
import { sourceProfile } from "../test-fixtures";
import "../styles/index.css";

vi.mock("../api", () => ({ desktopApi: {} }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.documentElement.style.fontSize = "";
  delete document.documentElement.dataset.theme;
});
const profiles = ["open-nectar-pikmin-disc", "g-diffuser-source-set"].map((id) => {
  const contract = catalog.source_catalog.identities.find((entry) => entry.id === id);
  if (!contract) throw new Error(`Missing catalog contract ${id}`);
  return { ...sourceProfile(), id, label: contract.label };
});

const layouts = [960, 1280, 1600].flatMap((width) =>
  [16, 32].flatMap((fontSize) =>
    ["dark", "light"].map((theme) => ({
      width,
      height: width === 960 ? 640 : 800,
      fontSize,
      theme,
    })),
  ),
);

it.each(layouts)(
  "keeps source qualifiers readable at $width / $fontSize px in $theme",
  async ({ width, height, fontSize, theme }) => {
    await page.viewport(width, height);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.fontSize = `${fontSize}px`;
    flushSync(() =>
      root.render(
        <DirectionProvider direction="ltr">
          <SourceDiscoveryButton profiles={profiles} disabled={false} />
        </DirectionProvider>,
      ),
    );
    const opener = page.getByRole("button", { name: "Find required files", exact: true });
    await userEvent.click(opener);
    const trigger = page.getByRole("combobox");
    await userEvent.click(trigger);
    for (const profile of profiles) {
      const option = page.getByRole("option", { name: profile.label, exact: true });
      await expect.element(option).toBeVisible();
      const element = option.element() as HTMLElement;
      element.scrollIntoView({ block: "nearest" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const text = element.firstElementChild as HTMLElement;
      const popup = document.querySelector<HTMLElement>('[data-slot="select-content"]')!;
      const bounds = text.getBoundingClientRect();
      console.log(
        "SELECT_METRICS",
        JSON.stringify({
          theme,
          width,
          fontSize,
          label: text.textContent,
          textWidth: bounds.width,
          itemWidth: element.clientWidth,
          popupWidth: popup.clientWidth,
        }),
      );
      expect(bounds.right).toBeLessThanOrEqual(popup.getBoundingClientRect().right);
      expect(bounds.left).toBeGreaterThanOrEqual(popup.getBoundingClientRect().left);
      expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
      expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);
    }
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(trigger).toHaveFocus();
    await expect
      .element(
        page.getByRole("option", {
          name: fixtureValue(profiles[0], "profiles[0]").label,
          exact: true,
        }),
      )
      .not.toBeInTheDocument();
    await userEvent.click(trigger);
    await userEvent.click(
      page.getByRole("option", {
        name: fixtureValue(profiles[0], "profiles[0]").label,
        exact: true,
      }),
    );
    await expect.element(trigger).toHaveFocus();
    await expect
      .element(trigger)
      .toHaveAccessibleName(`Required files ${fixtureValue(profiles[0], "profiles[0]").label}`);
    const selected = document.querySelector<HTMLElement>('[data-slot="select-value"]')!;
    const triggerElement = trigger.element() as HTMLElement;
    expect(selected.scrollWidth).toBeLessThanOrEqual(selected.clientWidth + 1);
    expect(selected.scrollHeight).toBeLessThanOrEqual(selected.clientHeight + 1);
    expect(selected.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      triggerElement.getBoundingClientRect().bottom,
    );
    expect(selected.getBoundingClientRect().right).toBeLessThanOrEqual(
      triggerElement.getBoundingClientRect().right,
    );
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(opener).toHaveFocus();
  },
);
