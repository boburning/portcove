import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { AdoptionModal } from "../components/AdoptionModal";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { useAdoptionPlanning } from "../features/installation/use-installation-planning";
import type { Perform } from "../features/operations/use-operation-state";
import { portDefinition } from "../test-fixtures";
import type { AdoptionPreview } from "../types";
import "../styles.css";

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

type TransportCall = { command: string; args: Record<string, unknown> };
const calls: TransportCall[] = [];
const expected: { call: TransportCall; response: () => unknown }[] = [];
const transportViolations: string[] = [];
function expectTransport(call: TransportCall, result: unknown) {
  expected.push({ call, response: () => result });
}
function expectTransportFailure(call: TransportCall, message: string) {
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
let openNestedReview: () => void;
let changeOpen: (open: boolean) => void;
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
  const [nestedOpen, setNestedOpen] = useState(false);
  changeGeneration = setGeneration;
  openNestedReview = () => setNestedOpen(true);
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
  const planning = useAdoptionPlanning(path, undefined, open, generation, perform, () =>
    setOpen(false),
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
          review={(selectedPortId) => void planning.review(selectedPortId)}
          adopt={() => void planning.adopt()}
          ports={[port]}
        />
      )}
      {open && nestedOpen && (
        <Dialog open onOpenChange={(next) => setNestedOpen(next)}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Safety review details</DialogTitle>
            <p>The original installation remains outside the managed library.</p>
          </DialogContent>
        </Dialog>
      )}
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
  assertTransportConsumed();
  flushSync(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
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

it("dismisses the top shared portal before the underlying copy review", async () => {
  await openReview();
  flushSync(() => openNestedReview());
  await expect.element(page.getByRole("dialog", { name: "Safety review details" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Safety review details" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("dialog", { name: "Add an existing installation to Portcove" }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
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
  old.resolve(preview);
  await old.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  oldCopy.resolve(null);
  await oldCopy.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  await openReview();
  await page.getByRole("button", { name: "Review copy plan" }).click();
  await expect.element(page.getByText(port.name)).toBeVisible();
  const action = page.getByRole("button", { name: /Continue to copy confirmation/ });
  await expect.element(action).toBeEnabled();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.getBoundingClientRect().width).toBeLessThanOrEqual(window.innerWidth);
  expect(dialog?.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
});
