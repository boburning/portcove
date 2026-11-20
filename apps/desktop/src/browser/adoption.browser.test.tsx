import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { controlledAct } from "../../test/controlled-react-act";
import { browserFixture } from "../../test/browser-fixture";
import { captureParityState } from "../../test/parity-capture";
import { AdoptionModal } from "../components/AdoptionModal";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { useAdoptionPlanning } from "../features/installation/use-installation-planning";
import { useOperationState, type Perform } from "../features/operations/use-operation-state";
import { installRecord } from "../components/rendered-test-fixtures";
import { portDefinition } from "../test-fixtures";
import type { AdoptionPreview, InstallRecord } from "../types";
import "../styles/index.css";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const port = { ...portDefinition(), id: "browser-port", name: "Browser Fixture Port" };
const shortPortName = port.name;
const preview: AdoptionPreview = {
  source: "D:/Existing",
  detected_port_ids: [port.id],
  selected_port_id: port.id,
  application_files_will_be_copied: true,
  original_will_be_modified: false,
  copy_plan: {
    directories: ["data"],
    files: [{ relative_path: "game.exe", size: 2048, sha256: "a".repeat(64) }],
    skipped_entries: [],
    total_bytes: 2048,
  },
  destination: {
    output_location: {
      port_id: port.id,
      library_root: "D:/Library",
      default_output_directory: "D:/Library/versions/browser-port",
      configured_output_directory: null,
      effective_output_directory: "D:/Library/versions/browser-port",
      selection_source: "library_default",
      user_data_root: "D:/Library/user/browser-port",
    },
    active_install: null,
    imported_user_data_paths: ["settings.dat"],
    current_user_data_files: 1,
    current_user_data_sha256: "c".repeat(64),
  },
  plan_sha256: "b".repeat(64),
};

type PreviewCall = {
  command: "preview_adoption";
  args: { path: string; generation: number; portId: string | null };
};
type AdoptCall = {
  command: "adopt_port";
  args: { path: string; generation: number; portId: string | null; planSha256: string };
};
type TransportCall = PreviewCall | AdoptCall;
type TransportResponse = AdoptionPreview | InstallRecord | null;
const calls: { command: string; args: Record<string, unknown> }[] = [];
const expected: {
  call: TransportCall;
  response: () => TransportResponse | Promise<TransportResponse>;
}[] = [];
const transportViolations: string[] = [];
function expectTransport(
  call: PreviewCall,
  result: AdoptionPreview | Promise<AdoptionPreview>,
): void;
function expectTransport(
  call: AdoptCall,
  result: InstallRecord | null | Promise<InstallRecord | null>,
): void;
function expectTransport(
  call: TransportCall,
  result: TransportResponse | Promise<TransportResponse>,
) {
  expected.push({ call, response: () => result });
}
function expectTransportFailure(call: AdoptCall, message: string) {
  expected.push({ call, response: () => Promise.reject(new Error(message)) });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let changeGeneration: (generation: number) => void;
let changeOpen: (open: boolean) => void;
let reviewCompletion: Promise<void> | undefined;
let adoptionCompletion: Promise<void> | undefined;
function assertTransportConsumed() {
  expect(expected, "unconsumed Tauri transport expectations").toHaveLength(0);
  expect(transportViolations, "unexpected or malformed Tauri transport calls").toEqual([]);
}

function ExistingInstallReview() {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(1);
  changeGeneration = setGeneration;
  changeOpen = setOpen;
  const perform: Perform = async (name, task) => {
    setBusy(name);
    try {
      return await task();
    } catch (value) {
      setError(String(value));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  const planning = useAdoptionPlanning(
    path,
    undefined,
    open,
    generation,
    perform,
    () => setOpen(false),
    [port],
  );
  const changePath = (next: string) => {
    planning.invalidate();
    setPath(next);
  };
  return (
    <DirectionProvider direction="ltr">
      <button type="button" onClick={() => setOpen(true)}>
        Copy existing installation
      </button>
      {error && <p role="alert">{error}</p>}
      {open && (
        <AdoptionModal
          path={path}
          setPath={changePath}
          preview={planning.preview}
          copyFailed={planning.copyFailed}
          applying={planning.applying}
          busy={busy}
          close={() => setOpen(false)}
          review={(selectedPortId) => {
            reviewCompletion = planning.review(selectedPortId);
          }}
          adopt={() => {
            adoptionCompletion = planning.adopt();
          }}
          ports={[port]}
        />
      )}
    </DirectionProvider>
  );
}

let readbackOperations: ReturnType<typeof useOperationState>;
function ExistingInstallReadback({ refresh }: { refresh: () => Promise<unknown> }) {
  const [open, setOpen] = useState(true);
  const operations = useOperationState({ refresh, libraryGeneration: 1 });
  readbackOperations = operations;
  const planning = useAdoptionPlanning(
    "D:/Existing",
    undefined,
    open,
    1,
    operations.perform,
    () => setOpen(false),
    [port],
  );
  return (
    <DirectionProvider direction="ltr">
      {open && (
        <AdoptionModal
          path="D:/Existing"
          setPath={() => {}}
          ports={[port]}
          preview={planning.preview}
          applying={planning.applying}
          refreshing={planning.refreshing}
          copyFailed={planning.copyFailed}
          busy={operations.busy}
          close={() => setOpen(false)}
          review={(selected) => {
            reviewCompletion = planning.review(selected);
          }}
          adopt={() => {
            adoptionCompletion = planning.adopt();
          }}
          pickFolder={() => {}}
        />
      )}
    </DirectionProvider>
  );
}

function NestedPortalReview() {
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  return (
    <DirectionProvider direction="ltr">
      <Dialog open={outerOpen} onOpenChange={setOuterOpen}>
        <DialogTrigger render={<Button />}>Open copy review shell</DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Copy review shell</DialogTitle>
          <button type="button" onClick={() => setInnerOpen(true)}>
            Open nested safety details
          </button>
          {innerOpen && (
            <Dialog open onOpenChange={setInnerOpen}>
              <DialogContent aria-describedby={undefined}>
                <DialogTitle>Nested safety details</DialogTitle>
              </DialogContent>
            </Dialog>
          )}
        </DialogContent>
      </Dialog>
    </DirectionProvider>
  );
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  port.name = shortPortName;
  calls.length = 0;
  expected.length = 0;
  transportViolations.length = 0;
  reviewCompletion = undefined;
  adoptionCompletion = undefined;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        const actual = { command, args };
        calls.push(actual);
        const next = expected.shift();
        if (!next) {
          transportViolations.push(`Unexpected Tauri command: ${command}`);
          throw new Error(`Unexpected Tauri command: ${command}`);
        }
        if (JSON.stringify(actual) !== JSON.stringify(next.call)) {
          transportViolations.push(`Malformed Tauri command: ${command}`);
          throw new Error(`Malformed Tauri command: ${command}`);
        }
        return next.response();
      },
    },
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  flushSync(() => root.render(<ExistingInstallReview />));
});

async function openReview() {
  await page.getByRole("button", { name: "Copy existing installation" }).click();
  await page.getByLabelText("Existing installation folder").fill("D:/Existing");
}
afterEach(() => {
  try {
    flushSync(() => root.unmount());
    assertTransportConsumed();
  } finally {
    host.remove();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
});

it("reviews a real portaled copy composition using only an exact typed transport response", async () => {
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await expect
    .element(page.getByRole("region", { name: "Existing installation copy plan" }))
    .toBeVisible();
  await expect.element(page.getByText("Browser Fixture Port")).toBeVisible();
  await expect.element(page.getByText(/Saved-file replacement/)).toBeVisible();
  expect(calls).toEqual([
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
  ]);
});

it("dismisses the top portaled review with Escape and leaves the original trigger available", async () => {
  await openReview();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Copy existing installation" }))
    .toHaveFocus();
  expect(calls).toHaveLength(0);
});

// Base UI derives nesting from Dialog context, not sibling portal DOM order.
it.each(["dark", "light"])("dismisses actual nested portals in order in %s", async (theme) => {
  document.documentElement.dataset.theme = theme;
  flushSync(() => root.render(<NestedPortalReview />));
  const outerTrigger = page.getByRole("button", { name: "Open copy review shell", exact: true });
  await outerTrigger.click();
  await page.getByRole("button", { name: "Open nested safety details" }).click();
  await expect.element(page.getByRole("dialog", { name: "Nested safety details" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Nested safety details" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("dialog", { name: "Copy review shell" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open nested safety details" }))
    .toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(outerTrigger).toHaveFocus();
  expect(calls).toHaveLength(0);
});

it("keeps the copy review disabled during mutation and sends the exact request once", async () => {
  const pending = deferred<null>();
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  expectTransport(
    {
      command: "adopt_port",
      args: {
        path: "D:/Existing",
        generation: 1,
        portId: port.id,
        planSha256: preview.plan_sha256,
      },
    },
    pending.promise,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  const confirm = page.getByRole("button", { name: /Continue to copy confirmation/ });
  await expect.element(confirm).toBeEnabled();
  await confirm.click();
  await expect.element(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Close copy installation dialog" }))
    .toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(calls.map((call) => call.command)).toEqual(["preview_adoption", "adopt_port"]);
  pending.resolve(null);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  { result: "confirmed", readback: "succeeded", theme: "dark", width: 960, height: 640 },
  { result: "cancelled", readback: "succeeded", theme: "light", width: 960, height: 640 },
  { result: "confirmed", readback: "failed", theme: "light", width: 430, height: 780 },
] as const)(
  "labels $result adoption as refreshing until $readback workspace readback settles",
  async ({ result, readback, theme, width, height }) => {
    const owner = browserFixture({ attributes: ["data-theme"], viewport: true });
    const command = deferred<InstallRecord | null>();
    const snapshot = deferred<void>();
    const refresh = vi.fn(async () => {
      await snapshot.promise;
      if (readback === "failed") throw new Error("workspace readback unavailable");
    });
    const commandResult = result === "cancelled" ? null : installRecord({ port_id: port.id });
    expectTransport(
      { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
      preview,
    );
    expectTransport(
      {
        command: "adopt_port",
        args: {
          path: "D:/Existing",
          generation: 1,
          portId: port.id,
          planSha256: preview.plan_sha256,
        },
      },
      command.promise,
    );
    try {
      await page.viewport(width, height);
      document.documentElement.dataset.theme = theme;
      flushSync(() => root.render(<ExistingInstallReadback refresh={refresh} />));
      await page.getByRole("button", { name: "Review copy plan" }).click();
      await page.getByRole("button", { name: /Continue to copy confirmation/ }).click();
      await expect
        .element(page.getByRole("button", { name: "Copying…", exact: true }))
        .toBeDisabled();
      const status = document.querySelector('[role="dialog"] [role="status"]');
      expect(status?.textContent?.trim()).toBe("Copying…");
      expect(refresh).not.toHaveBeenCalled();

      command.resolve(commandResult);
      await expect.poll(() => refresh.mock.calls.length).toBe(1);
      const pending = page.getByRole("button", { name: "Refreshing library…", exact: true });
      await expect.element(pending).toBeDisabled();
      expect(getComputedStyle(pending.element()).opacity).toBe("1");
      expect(
        pending.element().querySelector("svg")?.classList.contains("motion-safe:animate-spin"),
      ).toBe(true);
      expect(document.querySelectorAll('[role="dialog"] [role="status"]')).toHaveLength(1);
      expect(document.querySelector('[role="dialog"] [role="status"]')).toBe(status);
      expect(status?.textContent?.trim()).toBe("Refreshing library…");
      await expect
        .element(page.getByRole("button", { name: "Copying…", exact: true }))
        .not.toBeInTheDocument();
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        "input, button",
      ))
        expect(control.disabled).toBe(true);
      await userEvent.keyboard("{Escape}{Enter}");
      await expect.element(page.getByRole("dialog")).toBeVisible();
      expect(calls.map((call) => call.command)).toEqual(["preview_adoption", "adopt_port"]);
      expect(dialog.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(dialog.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      await captureParityState(`adoption-${result}-readback-${readback}`);

      snapshot.resolve();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(refresh).toHaveBeenCalledOnce();
      const record = [...readbackOperations.invocations.values()].find(
        (item) => item.name === "adopt",
      );
      expect(record?.phase).toBe("settled");
      expect(record?.outcome).toBe(result === "cancelled" ? "cancelled" : "succeeded");
      expect(record?.failure).toBeUndefined();
      expect(record?.refreshFailure instanceof Error).toBe(readback === "failed");
      expect(calls).toHaveLength(2);
    } finally {
      await controlledAct(async () => {
        command.resolve(commandResult);
        snapshot.resolve();
        await adoptionCompletion;
      });
      await owner.dispose();
    }
  },
);

it("requires a detected port choice and reviews that choice before enabling copy", async () => {
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    {
      ...preview,
      detected_port_ids: [port.id, "other-port"],
      selected_port_id: null,
      destination: null,
    },
  );
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: port.id } },
    preview,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await expect
    .element(page.getByRole("button", { name: /Continue to copy confirmation/ }))
    .toBeDisabled();
  await page.getByRole("button", { name: /Review Browser Fixture Port/ }).click();
  await expect
    .element(page.getByRole("button", { name: /Continue to copy confirmation/ }))
    .toBeEnabled();
  await expect.element(page.getByText("Browser Fixture Port")).toBeVisible();
  expect(calls.map((call) => call.args.portId)).toEqual([null, port.id]);
});

it("rejects unexpected transport commands without opening an unreviewed plan", async () => {
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Unexpected Tauri command",
  );
  await expect
    .element(page.getByRole("region", { name: "Existing installation copy plan" }))
    .not.toBeInTheDocument();
  expect(calls).toEqual([
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
  ]);
  expect(transportViolations).toEqual(["Unexpected Tauri command: preview_adoption"]);
  transportViolations.length = 0;
});

it("discards a response from an earlier library generation", async () => {
  const old = deferred<AdoptionPreview>();
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    old.promise,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  flushSync(() => changeGeneration(2));
  expect(reviewCompletion).toBeInstanceOf(Promise);
  await controlledAct(async () => {
    old.resolve(preview);
    await reviewCompletion;
  });
  await expect
    .element(page.getByRole("region", { name: "Existing installation copy plan" }))
    .not.toBeInTheDocument();
  expect(calls).toHaveLength(1);
});

it("does not close a reopened review when an earlier copy finishes", async () => {
  const oldCopy = deferred<null>();
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  expectTransport(
    {
      command: "adopt_port",
      args: {
        path: "D:/Existing",
        generation: 1,
        portId: port.id,
        planSha256: preview.plan_sha256,
      },
    },
    oldCopy.promise,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await page.getByRole("button", { name: /Continue to copy confirmation/ }).click();
  flushSync(() => {
    changeOpen(false);
    changeGeneration(2);
  });
  flushSync(() => changeOpen(true));
  expect(adoptionCompletion).toBeInstanceOf(Promise);
  await controlledAct(async () => {
    oldCopy.resolve(null);
    await adoptionCompletion;
  });
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Review copy plan" })).toBeEnabled();
  expect(calls).toHaveLength(2);
});

it("does not populate a reopened review with an earlier response in the same library generation", async () => {
  const old = deferred<AdoptionPreview>();
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    old.promise,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  flushSync(() => changeOpen(false));
  flushSync(() => changeOpen(true));
  expect(reviewCompletion).toBeInstanceOf(Promise);
  await controlledAct(async () => {
    old.resolve(preview);
    await reviewCompletion;
  });
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Existing installation copy plan" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Review copy plan" })).toBeEnabled();
  expect(calls).toHaveLength(1);
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await expect
    .element(page.getByRole("region", { name: "Existing installation copy plan" }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Continue to copy confirmation/ }))
    .toBeEnabled();
  expect(calls).toHaveLength(2);
});

it("does not close a reopened review when an earlier copy finishes in the same library generation", async () => {
  const oldCopy = deferred<null>();
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  expectTransport(
    {
      command: "adopt_port",
      args: {
        path: "D:/Existing",
        generation: 1,
        portId: port.id,
        planSha256: preview.plan_sha256,
      },
    },
    oldCopy.promise,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await page.getByRole("button", { name: /Continue to copy confirmation/ }).click();
  flushSync(() => changeOpen(false));
  flushSync(() => changeOpen(true));
  expect(adoptionCompletion).toBeInstanceOf(Promise);
  await controlledAct(async () => {
    oldCopy.resolve(null);
    await adoptionCompletion;
  });
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Review copy plan" })).toBeEnabled();
  expect(calls).toHaveLength(2);
});

it("retains a visible failure and requires a new review after an unconfirmed copy", async () => {
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  expectTransportFailure(
    {
      command: "adopt_port",
      args: {
        path: "D:/Existing",
        generation: 1,
        portId: port.id,
        planSha256: preview.plan_sha256,
      },
    },
    "copy result unavailable",
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await page.getByRole("button", { name: /Continue to copy confirmation/ }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
    "The copy could not be confirmed",
  );
  await expect.element(page.getByRole("button", { name: "Review copy plan" })).toBeEnabled();
  await expect
    .element(page.getByRole("region", { name: "Existing installation copy plan" }))
    .not.toBeInTheDocument();
  expect(calls.map((call) => call.command)).toEqual(["preview_adoption", "adopt_port"]);
});

it("keeps a long port identity and reviewed action reachable at the compact viewport", async () => {
  await page.viewport(960, 640);
  port.name =
    "An unusually long reviewed installation name that wraps across several lines in the compact copy review";
  expectTransport(
    { command: "preview_adoption", args: { path: "D:/Existing", generation: 1, portId: null } },
    preview,
  );
  expectTransport(
    {
      command: "adopt_port",
      args: {
        path: "D:/Existing",
        generation: 1,
        portId: port.id,
        planSha256: preview.plan_sha256,
      },
    },
    null,
  );
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await expect.element(page.getByText(port.name)).toBeVisible();
  const action = page.getByRole("button", { name: /Continue to copy confirmation/ });
  await expect.element(action).toBeEnabled();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.getBoundingClientRect().width).toBeLessThanOrEqual(window.innerWidth);
  expect(dialog?.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
  await action.click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
