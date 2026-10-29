import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { DetailLayout } from "./DetailLayout";
import { portDefinition } from "../test-fixtures";
import type { DetailOpening, DetailSection } from "../features/game-details/detail-sections";
import { focusableControls } from "../focus";
import "../styles/index.css";
import { act } from "react";

afterEach(cleanup);

it("does not replay a cancelled reveal control when its tab is selected later", async () => {
  const invoke = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  try {
    await render(
      <DetailLayout
        port={portDefinition()}
        initialSection="overview"
        readiness="Ready"
        installation="Managed installation"
        close={vi.fn()}
        action={(reveal) => (
          <button onClick={() => reveal("files", "retained-owner", "button")}>Review setup</button>
        )}
      >
        {() => ({
          overview: null,
          files: (
            <div id="retained-owner" tabIndex={-1}>
              <button onClick={invoke}>Existing picker</button>
            </div>
          ),
          saves: null,
          versions: null,
        })}
      </DetailLayout>,
    );
    await act(async () =>
      (page.getByRole("button", { name: "Review setup" }).element() as HTMLElement).click(),
    );
    await act(async () =>
      (
        page.getByRole("tab", { name: "Versions & updates", exact: true }).element() as HTMLElement
      ).click(),
    );
    await act(async () =>
      (page.getByRole("tab", { name: "Game files", exact: true }).element() as HTMLElement).click(),
    );
    for (const callback of frames.values()) callback(performance.now());
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    cancel.mockRestore();
  }
});

function Fixture({
  initial = "overview",
  opening,
  portId = "sample",
  notice = "",
}: {
  initial?: DetailSection;
  opening?: DetailOpening;
  portId?: string;
  notice?: string;
}) {
  return (
    <DetailLayout
      port={{ ...portDefinition(), id: portId }}
      opening={opening}
      initialSection={initial}
      readiness="Ready to play"
      installation="Managed installation · 1.2"
      action={(reveal) => <button onClick={() => reveal("files")}>Set up game</button>}
      attention={() => <p>{notice}</p>}
      close={vi.fn()}
    >
      {(reveal) => ({
        overview: <button onClick={() => reveal("saves")}>Inspect backups</button>,
        files: (
          <label>
            Game folder
            <input defaultValue="original" />
          </label>
        ),
        saves: <button>Restore selected backup</button>,
        versions: <button>Review candidate</button>,
      })}
    </DetailLayout>
  );
}

it("uses manual keyboard activation and retains the source draft in a mounted inert panel", async () => {
  await render(<Fixture />);
  const overview = page.getByRole("tab", { name: "Overview", exact: true });
  const files = page.getByRole("tab", { name: "Game files", exact: true });
  overview.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(files).toHaveFocus();
  await expect.element(overview).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  const folder = page.getByRole("textbox", { name: "Game folder" });
  await folder.fill("C:/Player/Retained draft");
  const input = folder.element();
  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  expect(input.isConnected).toBe(true);
  expect(input.closest("[inert][hidden]")).not.toBeNull();
  expect(focusableControls()).not.toContain(input);
  input.focus();
  expect(document.activeElement).not.toBe(input);
  await files.click();
  expect(folder.element()).toBe(input);
  await expect.element(folder).toHaveValue("C:/Player/Retained draft");
  await userEvent.keyboard("{End}");
  await expect
    .element(page.getByRole("tab", { name: "Versions & updates", exact: true }))
    .toHaveFocus();
  await expect.element(files).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard(" ");
  await expect
    .element(page.getByRole("tab", { name: "Versions & updates", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Home}");
  await expect.element(overview).toHaveFocus();
});

it("retains manual selection across refreshes and reevaluates a new opening", async () => {
  const result = await render(<Fixture opening={{ token: 1 }} />);
  await expect.element(page.getByRole("heading", { name: "Sample", exact: true })).toHaveFocus();
  await page.getByRole("tab", { name: "Game files", exact: true }).click();
  await result.rerender(
    <Fixture opening={{ token: 1 }} initial="versions" notice="Update available" />,
  );
  await expect
    .element(page.getByRole("tab", { name: "Game files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("tab", { name: "Game files", exact: true })).toHaveFocus();
  await result.rerender(<Fixture opening={{ token: 2 }} initial="versions" />);
  await expect
    .element(page.getByRole("tab", { name: "Versions & updates", exact: true }))
    .toHaveAttribute("aria-selected", "true");
});

it.each([
  ["updates", "versions", "Versions & updates"],
  ["saves", "saves", "Saves & backups"],
] as const)(
  "reveals incoming %s before focusing its heading",
  async (destination, initial, heading) => {
    await render(<Fixture opening={{ token: 3, destination }} initial={initial} />);
    await expect.element(page.getByRole("heading", { name: heading, exact: true })).toHaveFocus();
    expect(document.activeElement?.closest("[inert], [hidden]")).toBeNull();
  },
);

it("reveals an internal backup destination before focusing it", async () => {
  await render(<Fixture />);
  await page.getByRole("button", { name: "Inspect backups" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Saves & backups", exact: true }))
    .toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Restore selected backup" })).toBeVisible();
});

it("keeps every label and control within 320 CSS pixels", async () => {
  await page.viewport(320, 720);
  await render(<Fixture initial="files" />);
  for (const tab of document.querySelectorAll<HTMLElement>("[role=tab]")) {
    const rect = tab.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(320);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

it("reveals real management controls through the header and preserves their mounted draft", async () => {
  await render(
    <DetailLayout
      port={portDefinition()}
      initialSection="overview"
      readiness="Ready"
      installation="Managed installation"
      close={vi.fn()}
      action={() => <button>Play</button>}
    >
      {() => ({
        overview: null,
        files: null,
        saves: null,
        versions: null,
        manage: (
          <div id="detail-artwork" tabIndex={-1}>
            <label>
              Retained choice
              <input defaultValue="draft" />
            </label>
          </div>
        ),
      })}
    </DetailLayout>,
  );
  await page.getByRole("button", { name: /^More actions for/ }).click();
  await page.getByRole("menuitem", { name: "Change artwork", exact: true }).click();
  const manage = page.getByRole("tab", { name: "Manage", exact: true });
  await expect.element(manage).toHaveAttribute("aria-selected", "true");
  const choice = page.getByRole("textbox", { name: "Retained choice" });
  await choice.fill("saved input");
  const input = choice.element();
  await page.getByRole("tab", { name: "Game files", exact: true }).click();
  expect(input.isConnected).toBe(true);
  expect(input.closest("[hidden][inert]")).not.toBeNull();
  await manage.click();
  await expect.element(choice).toHaveValue("saved input");
});

it("keeps unknown original systems explicit and shows every offered release channel", async () => {
  const port = { ...portDefinition(), channels: ["stable", "beta", "rolling"] as const };
  await render(
    <DetailLayout
      port={{ ...port, channels: [...port.channels] }}
      initialSection="overview"
      readiness="Ready"
      installation="Not installed"
      close={vi.fn()}
      action={() => null}
    >
      {() => ({ overview: null, files: null, saves: null, versions: null })}
    </DetailLayout>,
  );
  const identity = page.getByRole("group", { name: "Game and port identity", exact: true });
  for (const label of ["Not specified", "Stable", "Preview", "Rolling"])
    await expect.element(identity.getByText(label, { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("tab", { name: "Manage", exact: true }))
    .not.toBeInTheDocument();
  expect(document.querySelector(".detail-header-artwork")).toBeNull();
});

it("composes About beside authored requirements and support without reserving absent media", async () => {
  await page.viewport(1280, 900);
  await render(
    <DetailLayout
      port={portDefinition()}
      projectUrl="https://github.com/example/project"
      openSupport={vi.fn()}
      overviewRequirements={<p>Player-supplied original files</p>}
      initialSection="overview"
      readiness="Ready"
      installation="Managed installation"
      close={vi.fn()}
      action={() => <button>Play</button>}
    >
      {() => ({
        overview: (
          <section>
            <h3>About</h3>
            <p>Upstream project description</p>
          </section>
        ),
        files: null,
        saves: null,
        versions: null,
      })}
    </DetailLayout>,
  );
  const about = page.getByRole("heading", { name: "About", exact: true });
  const requirements = page.getByRole("heading", { name: "Requirements", exact: true });
  expect(about.element().closest(".detail-overview-main")).not.toBeNull();
  expect(requirements.element().closest(".detail-overview-support")).not.toBeNull();
  expect(requirements.element().getBoundingClientRect().left).toBeGreaterThan(
    about.element().getBoundingClientRect().right,
  );
  await expect.element(page.getByRole("link", { name: "Open upstream project" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create support report" })).toBeVisible();
  expect(document.querySelector(".media-gallery")).toBeNull();
  expect(document.querySelector(".detail-header-artwork")).toBeNull();
});
