import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type {
  PortDefinition,
  PortStatus,
  SourceRecord,
  SourceRegistrationReference,
} from "../../types";
import { gameIdentityLabel } from "../../port-identity";
import type { Perform } from "../operations/use-operation-state";
import { targetInvocationContext, type InvocationContext } from "../operations/invocation-state";

// Review data is ephemeral UI intent; core still authorizes every mutation.
function useReviewRequest<T>(identity: string, perform: Perform) {
  const generation = useRef(new LatestRequestGeneration());
  const [reviewed, setReviewed] = useState<{ identity: string; value: T }>();
  useLayoutEffect(() => {
    const requests = generation.current;
    requests.begin();
    return () => {
      requests.begin();
    };
  }, [identity]);
  const review = async (name: string, task: () => Promise<T>, context: InvocationContext) => {
    const request = generation.current.begin();
    setReviewed(undefined);
    const current = () => generation.current.isCurrent(request);
    const result = await perform(
      name,
      async () => {
        try {
          return await task();
        } catch (error) {
          if (current()) throw error;
          return undefined;
        }
      },
      { refresh: "none", invalidateDiagnostics: false, context },
    );
    if (result !== undefined && current()) setReviewed({ identity, value: result });
  };
  const guard = () => {
    const request = generation.current.begin();
    return () => generation.current.isCurrent(request);
  };
  const invalidate = (expected?: T) => {
    if (expected === undefined) {
      generation.current.begin();
      setReviewed(undefined);
      return;
    }
    setReviewed((current) => (current?.value === expected ? undefined : current));
  };
  return {
    value: reviewed?.identity === identity ? reviewed.value : undefined,
    review,
    guard,
    invalidate,
  };
}

export function useInstallPlanning(
  portId: string | undefined,
  channel: PortStatus["channel"] | undefined,
  perform: Perform,
  context: InvocationContext | undefined,
  registeredSource?: SourceRecord,
  sourcePath = "",
) {
  // Empty and the automatically filled saved path select the same registration.
  // A display-only prefill must not discard its checked setup continuation.
  const explicitSourcePath = sourcePath === registeredSource?.path ? "" : sourcePath;
  const request = useReviewRequest<{
    plan: Awaited<ReturnType<typeof desktopApi.plan>>;
    sourceReference?: SourceRegistrationReference;
  }>(
    JSON.stringify([
      portId,
      channel,
      context?.libraryGeneration,
      registeredSource,
      explicitSourcePath,
    ]),
    perform,
  );
  const reviewSource = async (sourceReference?: SourceRegistrationReference) => {
    if (portId && channel && context)
      await request.review(
        "review install",
        async () => {
          let reference = sourceReference;
          // An explicit replacement keeps the existing Core checked-override
          // route. Only an actual saved-file choice binds its registration.
          if (reference || (registeredSource && !explicitSourcePath.trim())) {
            const checked = await desktopApi.reviewSourceReuse(
              reference?.profile_id ?? registeredSource!.profile_id,
              context.libraryGeneration,
            );
            if (
              (reference && checked.reference.reference_sha256 !== reference.reference_sha256) ||
              (registeredSource &&
                JSON.stringify(checked.registration) !== JSON.stringify(registeredSource))
            )
              throw new Error(
                "The saved files or this game's requirements changed. Check the saved files again before reviewing setup.",
              );
            const application = checked.applications.find((app) => app.port_id === portId);
            if (application) {
              if (!application.can_review_setup) throw new Error(application.summary);
              reference = checked.reference;
            } else if (sourceReference) {
              throw new Error(
                "These saved files have no checked reuse contract for this integration. Review its required original files.",
              );
            }
            // A legacy route without a reuse contract keeps its ordinary checked
            // setup path. It is not promoted into reusable-source compatibility.
          }
          const plan = await desktopApi.plan(portId, channel);
          return { plan, ...(reference ? { sourceReference: reference } : {}) };
        },
        context,
      );
  };
  return {
    plan: request.value?.plan,
    sourceReference: request.value?.sourceReference,
    review: () => reviewSource(),
    reviewSource,
    invalidate: () => request.invalidate(),
  };
}

export function useAdoptionPlanning(
  path: string,
  portId: string | undefined,
  open: boolean,
  generation: number,
  perform: Perform,
  done: () => void,
  ports: readonly PortDefinition[],
) {
  const identity = JSON.stringify([path, portId, open, generation]);
  const request = useReviewRequest<Awaited<ReturnType<typeof desktopApi.previewAdoption>>>(
    identity,
    perform,
  );
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const [completedIdentity, setCompletedIdentity] = useState<string>();
  const notifiedCompletion = useRef<string | undefined>(undefined);
  const context = (action: string, selected?: string) => {
    const port = ports.find((candidate) => candidate.id === selected);
    return targetInvocationContext(
      action,
      port
        ? { kind: "port", id: port.id, label: gameIdentityLabel(port) }
        : { kind: "source", id: path, label: "Selected installation folder" },
      generation,
      "library",
    );
  };
  const review = async (selectedPortId?: string) => {
    if (selectedPortId && !request.value?.detected_port_ids.includes(selectedPortId)) return;
    setFailedIdentity(undefined);
    if (open && path.trim())
      await request.review(
        "preview adoption",
        () => desktopApi.previewAdoption(path, generation, selectedPortId ?? portId),
        context("Review existing installation", selectedPortId ?? portId),
      );
  };
  const inFlight = useRef(false);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    if (completedIdentity !== identity || applying || request.value !== undefined) return;
    if (notifiedCompletion.current === completedIdentity) return;
    notifiedCompletion.current = completedIdentity;
    done();
  }, [applying, completedIdentity, done, identity, request.value]);
  const adopt = async () => {
    const preview = request.value;
    if (!open || !preview?.selected_port_id || inFlight.current) return;
    inFlight.current = true;
    notifiedCompletion.current = undefined;
    setCompletedIdentity(undefined);
    setApplying(true);
    const current = request.guard();
    request.invalidate(preview);
    let adopted: Awaited<ReturnType<typeof desktopApi.adopt>> | undefined;
    try {
      adopted = await perform(
        "adopt",
        () =>
          desktopApi.adopt(
            path,
            preview.plan_sha256,
            generation,
            preview.selected_port_id ?? undefined,
          ),
        { context: context("Copy existing installation", preview.selected_port_id) },
      );
    } finally {
      inFlight.current = false;
      setApplying(false);
    }
    if (current()) {
      if (adopted !== undefined) setCompletedIdentity(identity);
      else setFailedIdentity(identity);
    }
  };
  return {
    preview: request.value,
    review,
    adopt,
    invalidate: request.invalidate,
    applying,
    copyFailed: failedIdentity === identity,
  };
}
