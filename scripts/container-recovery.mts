import { isRecord } from "./runtime-values.mts";

function record(value: unknown) {
  return isRecord(value) ? value : null;
}
function timestamp(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)
    ? Date.parse(value)
    : NaN;
}
const session = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const startMessage =
  'starting /bin/sh -c export LISTEN_PID="$$"; exec /usr/local/bin/dockerd --config-file /run/config/docker/daemon.json';

// This policy consumes observations collected by the host adapter, never a caller-
// supplied recovery permit. A changed Desktop session is corroboration only:
// actual native-daemon stop/start AFTER terminal failure supplies quiescence.
export function restartedNativePreparation(input: {
  state: unknown;
  observation: unknown;
  dispatch: string;
  terminal: readonly unknown[];
  lifecycle: readonly unknown[];
}) {
  const state = record(input.state),
    current = record(input.observation);
  const old = record(state?.host),
    before = record(old?.desktop),
    after = record(current?.desktop);
  const oldEngine = record(old?.engine),
    newEngine = record(current?.engine);
  const disk = record(old?.disk),
    newDisk = record(current?.disk);
  const source = record(state?.source),
    failed = record(state?.failed_command);
  if (
    !state ||
    !current ||
    !source ||
    typeof source.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(source.commit) ||
    typeof source.tree !== "string" ||
    !/^[0-9a-f]{40}$/u.test(source.tree) ||
    !failed ||
    state.status !== "incomplete" ||
    (state.tool !== "build-v1" && state.tool !== "browser-v1") ||
    state.capacity_phase !== "image-build" ||
    state.container ||
    state.container_name ||
    state.export_complete !== false ||
    state.execution_status != null ||
    typeof state.error !== "string" ||
    !state.error ||
    typeof state.run !== "string" ||
    !session.test(state.run) ||
    state.build_name !==
      `${state.tool === "build-v1" ? "portcove-build" : state.tool === "browser-v1" ? "portcove-browser" : "invalid"}-${state.run}` ||
    failed.command !== "docker" ||
    !Number.isInteger(failed.status) ||
    failed.status === 0 ||
    !Array.isArray(failed.args) ||
    !failed.args.every((arg: unknown) => typeof arg === "string") ||
    failed.args[0] !== "--context" ||
    failed.args[1] !== "desktop-linux" ||
    failed.args[2] !== "build" ||
    !failed.args.includes(`BUILDKIT_BUILD_NAME=${state.build_name}`) ||
    !failed.args.includes(`SOURCE_COMMIT=${source.commit}`) ||
    !failed.args.includes(`SOURCE_TREE=${source.tree}`)
  )
    return null;
  const headers = input.dispatch
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("#0 building with "));
  if (
    headers.length !== 1 ||
    headers[0] !== '#0 building with "desktop-linux" instance using docker driver'
  )
    return null;
  if (
    before?.Status !== "running" ||
    after?.Status !== "running" ||
    typeof before.SessionID !== "string" ||
    !session.test(before.SessionID) ||
    typeof after.SessionID !== "string" ||
    !session.test(after.SessionID) ||
    before.SessionID === after.SessionID ||
    oldEngine?.os !== "linux" ||
    newEngine?.os !== "linux" ||
    typeof oldEngine.kernel !== "string" ||
    !/WSL2/iu.test(oldEngine.kernel) ||
    typeof newEngine.kernel !== "string" ||
    !/WSL2/iu.test(newEngine.kernel) ||
    typeof disk?.physical !== "string" ||
    disk.physical !== newDisk?.physical
  )
    return null;
  if (input.terminal.length !== 1) return null;
  const terminal = record(input.terminal[0]);
  if (terminal?.status !== "incomplete" || terminal.export_complete !== false) return null;
  const created = timestamp(state.created_at),
    admitted = timestamp(old?.observed_at);
  const ended = timestamp(terminal.at),
    observed = timestamp(current.observed_at);
  if (
    ![created, admitted, ended, observed].every(Number.isFinite) ||
    admitted > created ||
    created > ended ||
    ended > observed
  )
    return null;
  const events = input.lifecycle
    .map(record)
    .filter(
      (event) =>
        event?.component === "init" &&
        event.level === "info" &&
        typeof event.msg === "string" &&
        Number.isFinite(timestamp(event.time)) &&
        timestamp(event.time) > ended &&
        timestamp(event.time) <= observed,
    );
  const stops = events
    .filter((event) =>
      /^dockerd stopped gracefully after [0-9.]+(?:ns|µs|us|ms|s)$/u.test(String(event?.msg)),
    )
    .sort((a, b) => timestamp(a?.time) - timestamp(b?.time));
  const stopped = stops.at(-1);
  const started = events
    .filter(
      (event) => event?.msg === startMessage && timestamp(event.time) > timestamp(stopped?.time),
    )
    .sort((a, b) => timestamp(a?.time) - timestamp(b?.time))[0];
  if (!stopped || !started) return null;
  return {
    kind: "native-daemon-restarted",
    run: state.run,
    source,
    admitted_session: before.SessionID,
    current_session: after.SessionID,
    terminal,
    stopped,
    started,
    observed_at: current.observed_at,
  };
}
