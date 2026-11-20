import { join } from "@tauri-apps/api/path";
import { useId, useRef, useState, type RefObject } from "react";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
import { countMessage } from "../localization";
import { reloadWorkspace } from "../reload-workspace";
import type {
  LibraryRecoveryBundle,
  LibraryRecoveryBundlePlan,
  LibraryRecoveryRestorePlan,
} from "../types";
import { errorText, formatBytes } from "../view-model";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input } from "./ui/input";

type Operation = "create" | "inspect" | "resumeCreation" | "resumeRestore";
type RecoveryStep = { operation: "resumeCreation" | "resumeRestore"; path: string };

const titles = {
  create: "Create recovery bundle",
  inspect: "Inspect or restore a bundle",
  resumeCreation: "Resume bundle creation",
  resumeRestore: "Resume bundle restore",
} satisfies Record<Operation, string>;

const descriptions = {
  create:
    "Choose where to save a verified copy. Your current library stays selected after creation.",
  inspect: "Verify a saved bundle before choosing a separate library to restore.",
  resumeCreation: "Choose the staging folder Portcove recorded when the copy stopped.",
  resumeRestore: "Choose the destination folder from the interrupted restore.",
} satisfies Record<Operation, string>;

const coverageNames = {
  application_versions: "Installed game versions",
  user_data: "Library saves and settings",
  source_inbox: "Imported game files",
  backups: "Game-save backups",
  toolchains: "Preparation tools",
  local_artwork: "Local artwork",
} satisfies Record<LibraryRecoveryBundle["coverage"][number]["kind"], string>;

const exclusionNames = {
  external_installations: "External installations",
  external_originals_and_bios: "Original game files and BIOS outside the library",
  external_saves: "Saves outside the library",
  unknown_save_locations: "Unknown save locations",
  host_credentials: "Sign-in credentials",
} satisfies Record<LibraryRecoveryBundle["exclusions"][number], string>;

export function LibraryRecoveryBundleControls({
  generation,
  disabled,
}: {
  generation: number;
  disabled: boolean;
}) {
  const [operation, setOperation] = useState<Operation>();
  return (
    <section className="mt-6 grid gap-3">
      <h3>Verified recovery bundles</h3>
      <p>Keep managed game files, saves, settings and backups together in a checked copy.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={disabled}
          onClick={() => setOperation("create")}
        >
          {titles.create}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setOperation("inspect")}
        >
          {titles.inspect}
        </Button>
      </div>
      <details>
        <summary className="disclosure-pad-2 cursor-pointer text-sm">
          Resume an interrupted bundle operation
        </summary>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => setOperation("resumeCreation")}
          >
            {titles.resumeCreation}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => setOperation("resumeRestore")}
          >
            {titles.resumeRestore}
          </Button>
        </div>
      </details>
      {operation && (
        <RecoveryBundleDialog
          operation={operation}
          generation={generation}
          close={() => setOperation(undefined)}
        />
      )}
    </section>
  );
}

function RecoveryBundleDialog({
  operation,
  generation,
  close,
}: {
  operation: Operation;
  generation: number;
  close: () => void;
}) {
  const descriptionId = useId();
  const firstField = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const attempted = useRef(false);
  const [destination, setDestination] = useState("");
  const [path, setPath] = useState("");
  const [creation, setCreation] = useState<LibraryRecoveryBundlePlan>();
  const [verified, setVerified] = useState<LibraryRecoveryBundle>();
  const [restore, setRestore] = useState<LibraryRecoveryRestorePlan>();
  const [restored, setRestored] = useState<string>();
  const [transferred, setTransferred] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>();
  const [recovery, setRecovery] = useState<RecoveryStep>();

  const run = async (status: string, work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(status);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(failure);
    } finally {
      inFlight.current = false;
      setPending("");
    }
  };

  const chooseFolder = (edit: (value: string) => void, suggestion?: string) => {
    void run("Choosing a folder…", async () => {
      const choice = await pickInstallFolder("");
      if (choice) edit(suggestion ? await join(choice, suggestion) : choice);
    });
  };

  const editPath = (value: string) => {
    setPath(value);
    setVerified(undefined);
    setRestore(undefined);
    setError(undefined);
  };
  const editDestination = (value: string) => {
    setDestination(value);
    setCreation(undefined);
    setRestore(undefined);
    setError(undefined);
  };

  async function transfer<T>(
    action: (currentGeneration: number) => Promise<T>,
    kind: RecoveryStep["operation"],
  ): Promise<T> {
    const current = attempted.current ? await desktopApi.bootstrapStatus() : undefined;
    if (current && !current.ready)
      throw new Error(
        current.error ? errorText(current.error) : "Open your library and try again.",
      );
    attempted.current = true;
    setTransferred(true);
    setCreation(undefined);
    setRestore(undefined);
    setRecovery(undefined);
    try {
      return await action(current?.generation ?? generation);
    } catch (failure) {
      const target = recoveryFolder(failure, kind);
      if (target) setRecovery({ operation: kind, path: target });
      throw failure;
    }
  }

  function resume(target: RecoveryStep) {
    void run("Resuming the reviewed operation…", async () => {
      if (target.operation === "resumeCreation") {
        setVerified(
          await transfer(
            (current) => desktopApi.resumeLibraryRecoveryBundle(target.path, current),
            target.operation,
          ),
        );
      } else {
        const result = await transfer(
          (current) => desktopApi.resumeLibraryRecoveryRestore(target.path, current),
          target.operation,
        );
        if (!result.completed) throw new Error("Portcove could not verify the restored library.");
        setRestored(result.destination_root);
      }
    });
  }

  function dismiss() {
    if (inFlight.current) return;
    if (attempted.current) reloadWorkspace();
    else close();
  }

  const disabled = Boolean(pending) || transferred;
  const choosingBundle = operation === "inspect";
  const reviewingRestore = choosingBundle && verified && !transferred;
  const resumeOperation = operation === "resumeCreation" || operation === "resumeRestore";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        initialFocus={firstField}
        reviewSize="wide"
        showCloseButton={false}
        aria-describedby={descriptionId}
      >
        <DialogTitle>{titles[operation]}</DialogTitle>
        <DialogDescription id={descriptionId}>{descriptions[operation]}</DialogDescription>
        <NavigationHints />
        {!transferred && (choosingBundle || resumeOperation) && (
          <FolderField
            label={
              choosingBundle
                ? "Recovery bundle folder"
                : operation === "resumeCreation"
                  ? "Staging folder"
                  : "Restore destination"
            }
            value={path}
            disabled={disabled}
            fieldRef={firstField}
            change={editPath}
            browse={() => chooseFolder(editPath)}
          />
        )}
        {!transferred && (operation === "create" || reviewingRestore) && (
          <FolderField
            label={operation === "create" ? "New bundle folder" : "Restore destination"}
            value={destination}
            disabled={disabled}
            fieldRef={operation === "create" ? firstField : undefined}
            change={editDestination}
            browse={() =>
              chooseFolder(
                editDestination,
                operation === "create" ? "Portcove Recovery Bundle" : "Portcove Recovered Library",
              )
            }
            chooseParent
          />
        )}
        {creation && (
          <section aria-label="Creation review" className="grid gap-2">
            <h3 className="text-sm font-semibold">Review what Portcove will copy</h3>
            <PathValue label="Source library" value={creation.source_root} />
            <PathValue label="Bundle destination" value={creation.destination_root} />
            <p>Required space {formatBytes(creation.required_bytes)}</p>
            <BundleCoverage coverage={creation.coverage} exclusions={creation.exclusions} />
          </section>
        )}
        {verified && (
          <section aria-label="Verified recovery bundle" className="grid gap-2">
            <h3 className="text-sm font-semibold" role="status">
              Bundle verified
            </h3>
            <PathValue label="Bundle folder" value={verified.path} />
            <BundleCoverage coverage={verified.coverage} exclusions={verified.exclusions} />
            <details>
              <summary data-focusable>Verification details</summary>
              <PathValue label="Bundle ID" value={verified.bundle_id} />
              <PathValue label="Receipt SHA-256" value={verified.receipt_sha256} />
            </details>
          </section>
        )}
        {restore && (
          <section aria-label="Restore review" className="grid gap-2">
            <h3 className="text-sm font-semibold">Review the restore destination</h3>
            <PathValue label="Restore destination" value={restore.destination_root} />
            <p>
              Required space {formatBytes(restore.required_bytes)}. Your current library stays
              selected.
            </p>
          </section>
        )}
        {restored && (
          <section className="grid gap-2">
            <h3 role="status" className="text-sm font-semibold">
              Library restored
            </h3>
            <PathValue label="Restored library" value={restored} />
            <p>
              To use it, close this review and choose the restored folder under Library and storage.
            </p>
          </section>
        )}
        {pending && <p role="status">{pending} Keep Portcove open until this finishes.</p>}
        <ActionReviewFailure error={error} />
        {recovery && (
          <PathValue
            label={
              recovery.operation === "resumeCreation" ? "Staging folder" : "Restore destination"
            }
            value={recovery.path}
          />
        )}
        <DialogFooter>
          <Button data-focusable variant="outline" disabled={Boolean(pending)} onClick={dismiss}>
            Close
          </Button>
          {recovery && (
            <Button
              data-focusable
              variant="primary"
              disabled={Boolean(pending)}
              onClick={() => resume(recovery)}
            >
              {titles[recovery.operation]}
            </Button>
          )}
          {!transferred && operation === "create" && (
            <Button
              data-focusable
              variant="primary"
              disabled={disabled || !destination.trim()}
              onClick={() => {
                if (creation) {
                  void run("Copying and verifying your library…", async () => {
                    const bundle = await transfer(
                      (current) =>
                        desktopApi.createLibraryRecoveryBundle(
                          creation.destination_root,
                          creation.plan_sha256,
                          current,
                        ),
                      "resumeCreation",
                    );
                    if (
                      bundle.path !== creation.destination_root ||
                      bundle.source_library_id !== creation.source_library_id
                    ) {
                      throw new Error("Portcove could not confirm the reviewed bundle.");
                    }
                    setVerified(bundle);
                  });
                } else {
                  void run("Checking library coverage…", async () => {
                    setCreation(
                      await desktopApi.planLibraryRecoveryBundle(destination, generation),
                    );
                  });
                }
              }}
            >
              {creation ? "Copy and verify" : "Review bundle creation"}
            </Button>
          )}
          {!transferred && choosingBundle && !verified && (
            <Button
              data-focusable
              variant="primary"
              disabled={disabled || !path.trim()}
              onClick={() => {
                void run("Verifying the bundle…", async () =>
                  setVerified(await desktopApi.inspectLibraryRecoveryBundle(path)),
                );
              }}
            >
              Verify bundle
            </Button>
          )}
          {reviewingRestore && (
            <Button
              data-focusable
              variant="primary"
              disabled={disabled || !destination.trim()}
              onClick={() => {
                if (restore) {
                  void run("Restoring and verifying the new library…", async () => {
                    const result = await transfer(
                      (current) =>
                        desktopApi.restoreLibraryRecoveryBundle(
                          restore.bundle.path,
                          restore.destination_root,
                          restore.plan_sha256,
                          current,
                        ),
                      "resumeRestore",
                    );
                    if (!result.completed || result.destination_root !== restore.destination_root) {
                      throw new Error(
                        "Portcove could not verify the reviewed restore destination.",
                      );
                    }
                    setRestored(result.destination_root);
                  });
                } else {
                  void run("Checking the restore destination…", async () => {
                    const review = await desktopApi.planLibraryRecoveryRestore(
                      verified.path,
                      destination,
                      generation,
                    );
                    if (review.bundle.receipt_sha256 !== verified.receipt_sha256) {
                      setVerified(undefined);
                      throw new Error("The bundle changed. Verify it again before restoring.");
                    }
                    setRestore(review);
                  });
                }
              }}
            >
              {restore ? "Restore library" : "Review restore"}
            </Button>
          )}
          {!transferred && resumeOperation && (
            <Button
              data-focusable
              variant="primary"
              disabled={disabled || !path.trim()}
              onClick={() => resume({ operation, path })}
            >
              {titles[operation]}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderField({
  label,
  value,
  disabled,
  fieldRef,
  change,
  browse,
  chooseParent,
}: {
  label: string;
  value: string;
  disabled: boolean;
  fieldRef?: RefObject<HTMLInputElement | null> | undefined;
  change: (value: string) => void;
  browse: () => void;
  chooseParent?: boolean;
}) {
  return (
    <Field label={label}>
      <div className="grid min-w-0 gap-2 min-[48rem]:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          ref={fieldRef}
          data-focusable
          disabled={disabled}
          value={value}
          onChange={(event) => change(event.target.value)}
        />
        <Button data-focusable variant="outline" disabled={disabled} onClick={browse}>
          {chooseParent ? "Choose parent folder" : "Choose folder"}
        </Button>
      </div>
    </Field>
  );
}

function PathValue({ label, value }: { label: string; value: string }) {
  return (
    <p className="m-0 grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <code dir="ltr" className="wrap-anywhere [unicode-bidi:isolate]">
        {value}
      </code>
    </p>
  );
}

function BundleCoverage({
  coverage,
  exclusions,
}: Pick<LibraryRecoveryBundle, "coverage" | "exclusions">) {
  return (
    <div className="grid gap-2">
      <dl className="m-0 grid gap-1 text-sm">
        {coverage.map((entry) => (
          <div key={entry.kind} className="flex flex-wrap justify-between gap-x-4">
            <dt>{coverageNames[entry.kind]}</dt>
            <dd className="m-0 tabular-nums">
              {countMessage(entry.files, "retainedFiles")} · {formatBytes(entry.bytes)}
            </dd>
          </div>
        ))}
      </dl>
      <h4 className="text-sm font-semibold">Excluded from this bundle</h4>
      <ul className="m-0 list-disc ps-5 text-sm">
        {exclusions.map((entry) => (
          <li key={entry}>{exclusionNames[entry]}</li>
        ))}
      </ul>
    </div>
  );
}

function recoveryFolder(error: unknown, operation: RecoveryStep["operation"]): string | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) return;
  const details = error.details;
  if (!details || typeof details !== "object") return;
  const key = operation === "resumeCreation" ? "recovery_staging" : "import_destination";
  if (!(key in details)) return;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value.length ? value : undefined;
}
