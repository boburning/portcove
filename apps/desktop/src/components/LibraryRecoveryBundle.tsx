import { join } from "@tauri-apps/api/path";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
import { withoutVerbatimPrefix } from "../path-presentation";
import { countMessage } from "../localization";
import { reloadWorkspace } from "../reload-workspace";
import type {
  LibraryRecoveryBundle,
  LibraryRecoveryBundlePlan,
  LibraryRecoveryRestorePlan,
  OperationEvent,
} from "../types";
import { errorText, failurePresentation, formatBytes } from "../view-model";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input } from "./ui/input";

type Operation = "create" | "inspect" | "resumeCreation" | "resumeRestore";
type RecoveryFailureAction = "operation" | "verify" | "planCreate" | "planRestore";

type RecoveryStep = {
  operation: "resumeCreation" | "resumeRestore";
  path: string;
  transferId?: string;
};

type CreationReadback = Pick<
  LibraryRecoveryBundlePlan,
  "destination_root" | "source_library_id" | "plan_sha256"
> & { bundle_id?: string };

type RestoreReadback = Pick<LibraryRecoveryRestorePlan, "destination_root" | "plan_sha256"> & {
  transfer_id?: string;
};

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

const resumeNextSteps = {
  resumeCreation: `Files copied so far stay in the staging folder. If the drive is full, free up space first. Then choose ${titles.resumeCreation}.`,
  resumeRestore: `Files copied so far stay in the restore destination. If the drive is full, free up space first. Then choose ${titles.resumeRestore}.`,
} satisfies Record<RecoveryStep["operation"], string>;

const bundleAuthority =
  "Keep the original computer and its secure credential store available. Verification and restore both require them.";

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

type BundleScope = { generation: number; libraryRoot: string };
type BundleOpening = BundleScope & { operation: Operation };
type BundleOwner = {
  hidden: boolean;
  start: (opening: BundleOpening) => void;
  reveal: () => void;
};
const BundleContext = createContext<BundleOwner | null>(null);

export function LibraryRecoveryBundleProvider({ children }: { children: ReactNode }) {
  const [opening, setOpening] = useState<BundleOpening>();
  const [visible, setVisible] = useState(true);
  return (
    <BundleContext.Provider
      value={{
        hidden: opening !== undefined && !visible,
        start: (next) => setOpening((current) => current ?? next),
        reveal: () => setVisible(true),
      }}
    >
      {children}
      {opening && (
        <RecoveryBundleDialog
          {...opening}
          visible={visible}
          hide={() => setVisible(false)}
          close={() => {
            setVisible(true);
            setOpening(undefined);
          }}
        />
      )}
    </BundleContext.Provider>
  );
}

export function LibraryRecoveryBundleContinuation() {
  const owner = useContext(BundleContext);
  const button = useRef<HTMLButtonElement>(null);
  const hidden = owner?.hidden ?? false;
  useEffect(() => {
    if (hidden) button.current?.focus();
  }, [hidden]);
  if (!owner?.hidden) return null;
  return (
    <Button ref={button} data-focusable variant="outline" size="sm" onClick={owner.reveal}>
      View recovery bundle operation
    </Button>
  );
}

type BundleControlsProps = BundleScope & { disabled: boolean };

export function LibraryRecoveryBundleControls(props: BundleControlsProps) {
  const owner = useContext(BundleContext);
  if (owner) return <BundleControls {...props} owner={owner} />;
  return (
    <LibraryRecoveryBundleProvider>
      <LibraryRecoveryBundleControls {...props} />
      <LibraryRecoveryBundleContinuation />
    </LibraryRecoveryBundleProvider>
  );
}

function BundleControls({
  generation,
  libraryRoot,
  disabled,
  owner,
}: BundleControlsProps & { owner: BundleOwner }) {
  const open = (operation: Operation) => owner.start({ operation, generation, libraryRoot });
  return (
    <section className="mt-6 grid gap-3">
      <h3>Verified recovery bundles</h3>
      <p>Keep managed game files, saves, settings and backups together in a checked copy.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || owner.hidden}
          onClick={() => open("create")}
        >
          {titles.create}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || owner.hidden}
          onClick={() => open("inspect")}
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
            disabled={disabled || owner.hidden}
            onClick={() => open("resumeCreation")}
          >
            {titles.resumeCreation}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || owner.hidden}
            onClick={() => open("resumeRestore")}
          >
            {titles.resumeRestore}
          </Button>
        </div>
      </details>
    </section>
  );
}

function RecoveryBundleDialog({
  operation,
  generation,
  libraryRoot,
  visible,
  hide,
  close,
}: BundleOpening & {
  visible: boolean;
  hide: () => void;
  close: () => void;
}) {
  const descriptionId = useId();
  const destinationErrorId = useId();
  const firstField = useRef<HTMLInputElement>(null);
  const restoreDestinationField = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const attempted = useRef(false);
  const [destination, setDestination] = useState("");
  const [path, setPath] = useState("");
  const [creation, setCreation] = useState<LibraryRecoveryBundlePlan>();
  const [createReceipt, setCreateReceipt] = useState<CreationReadback>();
  const [verified, setVerified] = useState<LibraryRecoveryBundle>();
  const [restore, setRestore] = useState<LibraryRecoveryRestorePlan>();
  const [restoreReceipt, setRestoreReceipt] = useState<RestoreReadback>();
  const [restored, setRestored] = useState<string>();
  const [transferred, setTransferred] = useState(false);
  const [pending, setPending] = useState("");
  const copyInvocation = useRef<symbol>(undefined);
  const [copyEvent, setCopyEvent] = useState<OperationEvent>();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelFailure, setCancelFailure] = useState<unknown>();
  const cancelling = useRef(false);
  const [failure, setFailure] = useState<{
    error: unknown;
    action: RecoveryFailureAction;
  }>();
  const [recovery, setRecovery] = useState<RecoveryStep>();
  const error = failure?.error;
  const verificationFailed = failure?.action === "verify";
  const destinationOccupied =
    failure?.action === "planRestore" &&
    errorDetail(error, "import_destination_state") === "occupied";
  useEffect(() => {
    if (destinationOccupied && !pending) restoreDestinationField.current?.focus();
  }, [destinationOccupied, pending]);
  const verificationFeedback = verificationFailed ? failurePresentation(error) : undefined;
  const needsFolderGuidance =
    verificationFailed &&
    (!verificationFeedback || verificationFeedback.presentation_key === "verification_failed");
  const planningCreation = failure?.action === "planCreate";
  const interruptedCreationReview = planningCreation && recovery?.operation === "resumeCreation";
  const publishedCreationReview = planningCreation && Boolean(createReceipt?.bundle_id);
  const planningRestore = failure?.action === "planRestore";
  const interruptedRestoreReview = planningRestore && recovery?.operation === "resumeRestore";
  const publishedRestoreReview = planningRestore && Boolean(restoreReceipt?.transfer_id);

  const run = async (
    status: string,
    work: () => Promise<void>,
    action: RecoveryFailureAction = "operation",
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    cancelling.current = false;
    setCancelRequested(false);
    setCancelFailure(undefined);
    setCopyEvent(undefined);
    setPending(status);
    setFailure(undefined);
    try {
      await work();
    } catch (failure) {
      setFailure({ error: failure, action });
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
    setRestoreReceipt(undefined);
    setRecovery(undefined);
    setVerified(undefined);
    setRestore(undefined);
    setFailure(undefined);
  };
  const editDestination = (value: string) => {
    setDestination(value);
    setCreation(undefined);
    setCreateReceipt(undefined);
    setRestoreReceipt(undefined);
    setRecovery(undefined);
    setRestore(undefined);
    setFailure(undefined);
  };

  async function transfer<T>(
    action: (currentGeneration: number, onProgress: (event: OperationEvent) => void) => Promise<T>,
    kind: RecoveryStep["operation"],
  ): Promise<T> {
    const current = attempted.current ? await desktopApi.bootstrapStatus() : undefined;
    if (current && !current.ready)
      throw new Error(
        current.error ? errorText(current.error) : "Open your library and try again.",
      );
    if (current && current.library_root !== libraryRoot)
      throw new Error("Open the library used for this recovery operation and try again.");
    attempted.current = true;
    setTransferred(true);
    setCreation(undefined);
    setRestore(undefined);
    const invocation = Symbol();
    copyInvocation.current = invocation;
    try {
      const result = await action(current?.generation ?? generation, (event) => {
        if (copyInvocation.current !== invocation) return;
        setCopyEvent((previous) =>
          previous &&
          previous.operation_id === event.operation_id &&
          previous.sequence >= event.sequence
            ? previous
            : event,
        );
      });
      setRecovery(undefined);
      return result;
    } catch (failure) {
      const target = recoveryStep(failure, kind);
      if (target) setRecovery(target);
      throw failure;
    } finally {
      copyInvocation.current = undefined;
    }
  }

  function acceptRestoredDestination(
    result: { completed: boolean; destination_root: string },
    expected: string,
  ) {
    if (!result.completed || result.destination_root !== expected) {
      throw new Error("Portcove could not verify the reviewed restore destination.");
    }
    setRestored(result.destination_root);
  }

  function resume(target: RecoveryStep) {
    if (inFlight.current) return;
    setRecovery(target);
    void run("Resuming the reviewed operation…", async () => {
      if (target.operation === "resumeCreation") {
        setVerified(
          await transfer(
            (current, observe) =>
              desktopApi.resumeLibraryRecoveryBundle(target.path, current, observe),
            target.operation,
          ),
        );
      } else {
        const result = await transfer(
          (current, observe) =>
            desktopApi.resumeLibraryRecoveryRestore(
              target.path,
              current,
              observe,
              target.transferId,
            ),
          target.operation,
        );
        if (
          !result.completed ||
          (target.transferId &&
            (result.transfer_id !== target.transferId || result.destination_root !== target.path))
        )
          throw new Error("Portcove could not verify the restored library.");
        setRestored(result.destination_root);
      }
    });
  }

  function dismiss() {
    if (inFlight.current) {
      if (copyEvent) hide();
      return;
    }
    if (attempted.current) reloadWorkspace();
    else close();
  }

  const copying =
    copyEvent?.type === "progress" && copyEvent.phase === "Copying recovery data"
      ? copyEvent
      : undefined;
  const verifying = copyEvent?.type === "progress" && !copying;
  const cancelCopy = async () => {
    const invocation = copyInvocation.current;
    if (!copying || !invocation || cancelling.current) return;
    const isCurrent = () => copyInvocation.current === invocation;
    cancelling.current = true;
    setCancelRequested(true);
    setCancelFailure(undefined);
    try {
      const receipt = await desktopApi.cancelOperation(copying.operation_id);
      if (!receipt.requested && isCurrent()) setCancelRequested(false);
    } catch (failure) {
      if (isCurrent()) {
        setCancelFailure(failure);
        setCancelRequested(false);
      }
    } finally {
      if (isCurrent()) cancelling.current = false;
    }
  };

  const disabled = Boolean(pending) || transferred;
  const choosingBundle = operation === "inspect";
  const reviewingRestore = choosingBundle && verified && !transferred;
  const resumeOperation = operation === "resumeCreation" || operation === "resumeRestore";

  return (
    <Dialog
      open={visible}
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
        <DialogDescription id={descriptionId}>
          {descriptions[operation]} {!verified && bundleAuthority}
        </DialogDescription>
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
            fieldRef={operation === "create" ? firstField : restoreDestinationField}
            invalidDescriptionId={destinationOccupied ? destinationErrorId : undefined}
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
        {destinationOccupied && (
          <ActionReviewFailure
            error={error}
            summary="This folder already contains other files, so Portcove didn’t change anything. Choose a new or empty folder to restore the library."
            summaryId={destinationErrorId}
            showMutationSummary={false}
          />
        )}
        {creation && (
          <section aria-label="Creation review" className="grid gap-2">
            <h3 className="text-sm font-semibold">Review what Portcove will copy</h3>
            <PathValue label="Source library" value={creation.source_root} />
            <PathValue label="Bundle destination" value={creation.destination_root} />
            <p>Required space {formatBytes(creation.required_bytes)}</p>
            <p>Use a destination that supports folders private to your account.</p>
            <BundleCoverage coverage={creation.coverage} exclusions={creation.exclusions} />
          </section>
        )}
        {verified && (
          <section aria-label="Verified recovery bundle" className="grid gap-2">
            <h3 className="text-sm font-semibold" role="status">
              Bundle verified
            </h3>
            <PathValue label="Bundle folder" value={verified.path} />
            <p>{bundleAuthority}</p>
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
        {pending && (
          <div className="grid gap-2">
            <p role="status">
              {cancelRequested
                ? "Stopping the copy… Files copied so far stay in place so you can resume later."
                : copying
                  ? "Copying recovery data…"
                  : verifying
                    ? "Verifying recovery data. Keep Portcove open until verification finishes."
                    : pending}
            </p>
            {copying && copying.total && copying.total > 0 ? (
              <div className="grid gap-1">
                <progress
                  aria-label="Recovery data copied"
                  className="w-full"
                  value={copying.completed}
                  max={copying.total}
                />
                <span>
                  {formatBytes(copying.completed)} of {formatBytes(copying.total)}
                </span>
              </div>
            ) : null}
            {copying && (
              <Button
                data-focusable
                variant="outline"
                className="justify-self-start"
                disabled={cancelRequested}
                onClick={() => void cancelCopy()}
              >
                Cancel copy
              </Button>
            )}
            <ActionReviewFailure error={cancelFailure} />
          </div>
        )}
        {!destinationOccupied && (
          <ActionReviewFailure
            error={error}
            summary={
              needsFolderGuidance
                ? "Portcove couldn’t verify this bundle. Check the folder and verify again, or choose another bundle."
                : publishedCreationReview
                  ? "A previous copy was published to this folder. Check the bundle to verify its contents."
                  : interruptedCreationReview
                    ? "An interrupted copy is waiting for this bundle folder."
                    : publishedRestoreReview
                      ? "This bundle was restored to this folder. Check the recorded restore result."
                      : interruptedRestoreReview
                        ? "An interrupted restore is waiting in this folder."
                        : undefined
            }
            showMutationSummary={failure?.action === "operation"}
          />
        )}
        {createReceipt &&
          (createReceipt.bundle_id || error !== undefined) &&
          !recovery &&
          !verified && (
            <Button
              data-focusable
              variant="outline"
              className="justify-self-start"
              aria-disabled={Boolean(pending)}
              onClick={() =>
                void run("Checking the reviewed bundle folder…", async () => {
                  const bundle = await desktopApi.inspectLibraryRecoveryBundle(
                    createReceipt.destination_root,
                    createReceipt.plan_sha256,
                  );
                  if (
                    bundle.path !== createReceipt.destination_root ||
                    bundle.source_library_id !== createReceipt.source_library_id ||
                    (createReceipt.bundle_id && bundle.bundle_id !== createReceipt.bundle_id)
                  )
                    throw new Error("The verified bundle does not match the reviewed copy.");
                  setTransferred(true);
                  setVerified(bundle);
                })
              }
            >
              {createReceipt.bundle_id ? "Verify published bundle" : "Check reviewed bundle again"}
            </Button>
          )}
        {restoreReceipt && (restoreReceipt.transfer_id || error !== undefined) && !restored && (
          <Button
            data-focusable
            variant="outline"
            className="justify-self-start"
            aria-disabled={Boolean(pending)}
            onClick={() =>
              void run("Checking the reviewed restore destination…", async () => {
                const expected = restoreReceipt.destination_root;
                try {
                  const result = await desktopApi.readLibraryRecoveryRestore(
                    expected,
                    restoreReceipt.plan_sha256,
                  );
                  if (
                    restoreReceipt.transfer_id &&
                    result.transfer_id !== restoreReceipt.transfer_id
                  )
                    throw new Error("The restored library does not match the reviewed transfer.");
                  acceptRestoredDestination(result, expected);
                  setTransferred(true);
                  setRecovery(undefined);
                } catch (failure) {
                  const step = recoveryStep(failure, "resumeRestore");
                  if (!restoreReceipt.transfer_id && step?.path === expected) setRecovery(step);
                  throw failure;
                }
              })
            }
          >
            {restoreReceipt.transfer_id ? "Check restored library" : "Check reviewed restore again"}
          </Button>
        )}
        {errorDetail(error, "recovery_action") === "discard_game_update_acquisition" && (
          <section className="grid gap-2" aria-label="Retained update download">
            <p>
              Open Versions for the game below. If a download is still running, let it finish or
              cancel it. If Versions offers preparation, you can review that step. You can also
              review deleting the retained download. Then review bundle creation again.
            </p>
            <PathValue label="Port" value={errorDetail(error, "port_id") ?? ""} />
            <PathValue
              label="Update download ID"
              value={errorDetail(error, "acquisition_id") ?? ""}
            />
          </section>
        )}
        {errorDetail(error, "recovery_action") === "review_managed_installation_location" && (
          <section className="grid gap-2" aria-label="Managed installation outside the library">
            <p>
              This installation blocks the bundle. Open Manage for the game below, choose Review
              library default, then choose Review moving existing versions. After the versions move
              to the library default, review bundle creation again.
            </p>
            <PathValue label="Port" value={errorDetail(error, "port_id") ?? ""} />
            <PathValue label="Installation ID" value={errorDetail(error, "install_id") ?? ""} />
          </section>
        )}
        {errorDetail(error, "recovery_destination") && (
          <PathValue
            label="Recorded bundle folder"
            value={errorDetail(error, "recovery_destination") ?? ""}
          />
        )}
        {restoreReceipt?.transfer_id && !restored && (
          <PathValue label="Recorded restore destination" value={restoreReceipt.destination_root} />
        )}
        {recovery && (
          <>
            <p>{resumeNextSteps[recovery.operation]}</p>
            <PathValue
              label={
                recovery.operation === "resumeCreation" ? "Staging folder" : "Restore destination"
              }
              value={recovery.path}
            />
          </>
        )}
        <DialogFooter>
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(pending) && !copyEvent}
            onClick={dismiss}
          >
            {pending && copyEvent ? "Hide details" : "Close"}
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
          {!transferred && !recovery && !createReceipt?.bundle_id && operation === "create" && (
            <Button
              data-focusable
              variant="primary"
              disabled={disabled || !destination.trim()}
              onClick={() => {
                if (creation) {
                  setCreateReceipt(creation);
                  void run("Copying and verifying your library…", async () => {
                    const bundle = await transfer(
                      (current, observe) =>
                        desktopApi.createLibraryRecoveryBundle(
                          creation.destination_root,
                          creation.plan_sha256,
                          current,
                          observe,
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
                  void run(
                    "Checking library coverage…",
                    async () => {
                      try {
                        setCreation(
                          await desktopApi.planLibraryRecoveryBundle(destination, generation),
                        );
                      } catch (failure) {
                        setRecovery(recoveryStep(failure, "resumeCreation"));
                        setCreateReceipt(publishedCreationReadback(failure));
                        throw failure;
                      }
                    },
                    "planCreate",
                  );
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
                void run(
                  "Verifying the bundle…",
                  async () => setVerified(await desktopApi.inspectLibraryRecoveryBundle(path)),
                  "verify",
                );
              }}
            >
              Verify bundle
            </Button>
          )}
          {reviewingRestore && !recovery && !restoreReceipt?.transfer_id && (
            <Button
              data-focusable
              variant="primary"
              disabled={disabled || !destination.trim()}
              onClick={() => {
                if (restore) {
                  setRestoreReceipt(restore);
                  void run("Restoring and verifying the new library…", async () => {
                    const result = await transfer(
                      (current, observe) =>
                        desktopApi.restoreLibraryRecoveryBundle(
                          restore.bundle.path,
                          restore.destination_root,
                          restore.plan_sha256,
                          current,
                          observe,
                        ),
                      "resumeRestore",
                    );
                    acceptRestoredDestination(result, restore.destination_root);
                  });
                } else {
                  void run(
                    "Checking the restore destination…",
                    async () => {
                      try {
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
                      } catch (failure) {
                        const step = recoveryStep(failure, "resumeRestore");
                        const readback = publishedRestoreReadback(failure);
                        if (
                          (step || readback) &&
                          (errorDetail(failure, "recovery_bundle_id") !== verified.bundle_id ||
                            errorDetail(failure, "recovery_bundle_path") !== verified.path ||
                            errorDetail(failure, "recovery_bundle_receipt_sha256") !==
                              verified.receipt_sha256)
                        ) {
                          setVerified(undefined);
                          throw new Error("The bundle changed. Verify it again before restoring.");
                        }
                        setRecovery(step);
                        setRestoreReceipt(readback);
                        throw failure;
                      }
                    },
                    "planRestore",
                  );
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
  invalidDescriptionId,
  change,
  browse,
  chooseParent,
}: {
  label: string;
  value: string;
  disabled: boolean;
  fieldRef?: RefObject<HTMLInputElement | null> | undefined;
  invalidDescriptionId?: string | undefined;
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
          aria-invalid={invalidDescriptionId ? true : undefined}
          aria-describedby={invalidDescriptionId}
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

/** Shows a Core value as the player knows it; callers keep the raw value for identity. */
function PathValue({ label, value }: { label: string; value: string }) {
  return (
    <p className="m-0 grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <code dir="ltr" className="wrap-anywhere [unicode-bidi:isolate]">
        {withoutVerbatimPrefix(value)}
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

function publishedCreationReadback(error: unknown): CreationReadback | undefined {
  if (errorDetail(error, "recovery_action") !== "read_published_recovery_bundle") return;
  const destination = errorDetail(error, "recovery_destination");
  const source = errorDetail(error, "recovery_source_library_id");
  const digest = errorDetail(error, "recovery_plan_sha256");
  const bundleId = errorDetail(error, "recovery_bundle_id");
  if (destination && source && digest && bundleId)
    return {
      destination_root: destination,
      source_library_id: source,
      plan_sha256: digest,
      bundle_id: bundleId,
    };
}

function publishedRestoreReadback(error: unknown): RestoreReadback | undefined {
  if (errorDetail(error, "recovery_action") !== "read_published_recovery_restore") return;
  const destination = errorDetail(error, "import_destination");
  const digest = errorDetail(error, "recovery_restore_plan_sha256");
  const transferId = errorDetail(error, "transfer_id");
  if (destination && digest && transferId)
    return { destination_root: destination, plan_sha256: digest, transfer_id: transferId };
}

function recoveryStep(
  error: unknown,
  operation: RecoveryStep["operation"],
): RecoveryStep | undefined {
  if (operation === "resumeCreation") {
    const path = errorDetail(error, "recovery_staging");
    return path ? { operation, path } : undefined;
  }
  if (errorDetail(error, "recovery_action") !== "resume_library_recovery_restore") return;
  const path = errorDetail(error, "import_destination");
  const transferId = errorDetail(error, "transfer_id");
  return path && transferId ? { operation, path, transferId } : undefined;
}

function errorDetail(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) return;
  const details = error.details;
  if (!details || typeof details !== "object") return;
  if (!(key in details)) return;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value.length ? value : undefined;
}
