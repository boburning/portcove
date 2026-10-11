import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type {
  GameFileQueryRefreshRequest,
  GameFileQuerySnapshot,
  PortDefinition,
  ReleaseChannel,
} from "../types";
import { errorText, platformLabel, releaseChannelPresentation } from "../view-model";
import { Button } from "./ui/button";
import { ChoiceSelect } from "./ChoiceSelect";
import { OperationCancellation } from "./OperationCancellation";

type Route = GameFileQueryRefreshRequest["routes"][number];
const routes: readonly { value: Route["route"]; label: string }[] = [
  { value: "managed_install", label: "Managed setup" },
  { value: "external_registration", label: "Existing installation setup" },
  { value: "managed_launch", label: "Managed launch" },
  { value: "external_launch", label: "Existing installation launch" },
];
const states: Record<GameFileQuerySnapshot["routes"][number]["state"], string> = {
  files_available: "Compatible complete files available",
  files_missing: "Files missing",
  needs_checking: "Needs checking",
  no_files_required: "No game files required",
  unavailable_context: "Unavailable context",
};
const reasons: Record<GameFileQuerySnapshot["routes"][number]["reason"], string> = {
  complete_compatible_observation: "Core observed a complete compatible set for this route.",
  no_connected_registration: "No game-file registration is connected for this route.",
  explicit_empty_requirements: "This route explicitly declares no game-file requirement.",
  observation_unavailable: "An accepted observation is unavailable.",
  observation_stale: "The observation needs a fresh check.",
  source_needs_checking: "The connected files need checking.",
  storage_absence_unconfirmed:
    "Storage could not confirm absence; files are not confirmed missing.",
  identity_not_admitted: "The file identity has not been admitted for this route.",
  contract_not_reviewed: "The game-file contract has not been reviewed for this route.",
  variant_not_supported: "The observed file variant does not match this route.",
  release_not_bound: "The observation is not bound to the selected release.",
  route_not_offered: "The selected route is not offered.",
  profile_context_changed: "The selected game-file context has changed.",
};

/** Validate presentation context only. Core remains the execution authority. */
export function acceptedGameFileQuery(
  snapshot: GameFileQuerySnapshot,
  request: Route,
  library: { id: string; root: string },
  now: number,
): boolean {
  const projection = snapshot.routes?.[0];
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0;
  return (
    snapshot.schema_version === 1 &&
    snapshot.library?.id === library.id &&
    snapshot.library?.root === library.root &&
    snapshot.routes?.length === 1 &&
    Number.isSafeInteger(snapshot.observed_at) &&
    Number.isSafeInteger(snapshot.expires_at) &&
    snapshot.observed_at > 0 &&
    snapshot.observed_at <= now &&
    now <= snapshot.expires_at &&
    snapshot.expires_at - snapshot.observed_at <= 300 &&
    digest(snapshot.catalog_binding_sha256) &&
    digest(snapshot.registration_sha256) &&
    digest(snapshot.selection_sha256) &&
    !!projection &&
    projection.port_id === request.port_id &&
    projection.platform === request.platform &&
    projection.channel === request.channel &&
    projection.route === request.route &&
    Object.hasOwn(states, projection.state) &&
    Object.hasOwn(reasons, projection.reason) &&
    (projection.state !== "files_available" ||
      (projection.reason === "complete_compatible_observation" &&
        identifier(projection.contract_id) &&
        identifier(projection.identity?.game_id) &&
        identifier(projection.identity?.variant_id) &&
        identifier(projection.identity?.representation_id) &&
        digest(projection.source_instance_sha256) &&
        digest(projection.route_definition_sha256))) &&
    (projection.state !== "files_missing" || projection.reason === "no_connected_registration") &&
    (projection.state !== "no_files_required" ||
      (projection.reason === "explicit_empty_requirements" &&
        digest(projection.route_definition_sha256)))
  );
}

export function GameFileQueryControl({
  port,
  channel,
  generation,
  context,
  busy,
}: {
  port: PortDefinition;
  channel: ReleaseChannel;
  generation: number;
  /** Accepted catalog, registration and installation observations; change invalidates the result. */
  context: string;
  busy?: boolean;
}) {
  const [route, setRoute] = useState<Route["route"]>("managed_install");
  const [platform, setPlatform] = useState<Route["platform"]>(port.platforms[0]);
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<{ epoch: number; id: string }>();
  const [result, setResult] = useState<{ epoch: number; snapshot: GameFileQuerySnapshot }>();
  const [error, setError] = useState<{ epoch: number; message: string }>();
  const [expired, setExpired] = useState(false);
  const key = JSON.stringify([port.id, channel, generation, context, route, platform]);
  const owner = useRef({ key, epoch: 0, closed: false });
  const processing = useRef(false);
  if (owner.current.key !== key) {
    owner.current.key = key;
    owner.current.epoch += 1;
  }
  const epoch = owner.current.epoch;
  useEffect(() => {
    owner.current.closed = false;
    return () => {
      owner.current.closed = true;
    };
  }, []);
  const current = result?.epoch === epoch && !expired ? result.snapshot : undefined;
  useEffect(() => {
    if (!current) return;
    const milliseconds = Math.max(0, Math.min(300_000, current.expires_at * 1000 - Date.now()));
    const timer = setTimeout(() => setExpired(true), milliseconds);
    return () => clearTimeout(timer);
  }, [current]);
  const check = async () => {
    if (processing.current || busy || !platform || !port.platforms.includes(platform)) return;
    processing.current = true;
    const selected: Route = { port_id: port.id, platform, channel, route };
    const requestEpoch = epoch;
    const active = () => !owner.current.closed && owner.current.epoch === requestEpoch;
    setPending(true);
    setOperation(undefined);
    setResult(undefined);
    setError(undefined);
    setExpired(false);
    try {
      const library = await desktopApi.libraryIdentity(generation);
      if (!active()) return;
      const snapshot = await desktopApi.refreshGameFileQuery(
        {
          routes: [selected],
          maximum_age_seconds: 300,
          limits: {
            max_file_bytes: 2 * 1024 ** 3,
            max_hash_bytes: 32 * 1024 ** 3,
            max_elapsed_ms: 30_000,
          },
        },
        generation,
        (event) => {
          if (
            active() &&
            (event.schema_version === 2 || event.schema_version === 3) &&
            event.type === "started" &&
            event.operation === "verify_source"
          )
            setOperation({ epoch: requestEpoch, id: event.operation_id });
        },
      );
      if (!active()) return;
      if (!acceptedGameFileQuery(snapshot, selected, library, Math.floor(Date.now() / 1000)))
        throw new Error("The game-file observation no longer matches this selection. Check again.");
      setResult({ epoch: requestEpoch, snapshot });
    } catch (value) {
      if (active()) setError({ epoch: requestEpoch, message: errorText(value) });
    } finally {
      processing.current = false;
      if (!owner.current.closed) {
        setPending(false);
        setOperation(undefined);
      }
    }
  };
  const projection = current?.routes[0];
  return (
    <section className="my-4 grid gap-3" aria-label="Selected route game files">
      <h2>Game files for this route</h2>
      <ChoiceSelect
        label="Route"
        value={route}
        options={routes}
        disabled={pending || busy}
        onChange={setRoute}
      />
      <ChoiceSelect
        label="Target platform"
        value={platform}
        options={port.platforms.map((value) => ({ value, label: platformLabel(value) }))}
        disabled={pending || busy}
        onChange={setPlatform}
      />
      <p>
        Channel: {releaseChannelPresentation(channel).label}. This check observes connected files;
        setup and launch still require their own reviews and prerequisites.
      </p>
      <Button
        data-focusable
        variant="outline"
        disabled={pending || busy || !port.platforms.includes(platform)}
        onClick={() => {
          void check();
        }}
      >
        {pending ? "Checking game files…" : "Check selected route game files"}
      </Button>
      {pending && operation?.epoch === epoch && (
        <OperationCancellation
          key={operation.id}
          operationId={operation.id}
          label="Cancel game-file check"
        />
      )}
      <p role="status">
        {projection
          ? states[projection.state]
          : pending
            ? "Checking selected route…"
            : expired && result?.epoch === epoch
              ? "Observation expired. Check again."
              : "No current observation for this selection."}
      </p>
      {projection && <p>{reasons[projection.reason]}</p>}
      {error?.epoch === epoch && <p role="alert">{error.message}</p>}
    </section>
  );
}
