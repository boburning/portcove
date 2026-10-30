import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { desktopApi } from "../../api";
import type { GameComparison, GameComparisonRequest } from "../../types";

type ComparisonContext = {
  edition: string;
  environment: string;
  platform: NonNullable<GameComparisonRequest["platform"]> | "";
  requirements: string[];
};
const initialContext: ComparisonContext = {
  edition: "",
  environment: "",
  platform: "",
  requirements: [],
};

/** Core computes the result. Late responses cannot cross a library, project or context change. */
export function useGameComparison({
  portId,
  generation,
  observationKey,
}: {
  portId: string | undefined;
  generation: number | undefined;
  observationKey: string;
}) {
  const binding = JSON.stringify([portId, generation]);
  const [selection, setSelection] = useState({ binding, context: initialContext });
  const context = selection.binding === binding ? selection.context : initialContext;
  const setContext = useCallback(
    (update: SetStateAction<ComparisonContext>) => {
      setSelection((previous) => {
        const current = previous.binding === binding ? previous.context : initialContext;
        return { binding, context: typeof update === "function" ? update(current) : update };
      });
    },
    [binding],
  );
  const [state, setState] = useState<{
    key: string;
    report?: GameComparison;
    loading: boolean;
    failed: boolean;
  }>({ key: "", loading: false, failed: false });
  const sequence = useRef(0);
  const key = JSON.stringify([portId, generation, observationKey, context]);
  const enabled = portId !== undefined && generation !== undefined;
  const request = JSON.stringify({
    port_id: portId,
    edition_id: context.edition || undefined,
    environment_id: context.environment || undefined,
    platform: context.platform || undefined,
    required_capabilities: context.requirements,
  });
  const load = useCallback(
    async (refresh: boolean) => {
      if (!enabled || generation === undefined) return;
      const invocation = ++sequence.current;

      try {
        const input = JSON.parse(request) as GameComparisonRequest;
        const report = await desktopApi.compareGamePorts({ ...input, refresh }, generation);
        if (sequence.current !== invocation) return;
        if (
          report.format_version !== 1 ||
          report.policy_version !== "balanced-v1" ||
          !Array.isArray(report.ports)
        ) {
          throw new Error("Unsupported optional comparison result");
        }
        setState({ key, report, loading: false, failed: false });
      } catch {
        if (sequence.current === invocation) setState({ key, loading: false, failed: true });
      }
    },
    [enabled, generation, key, request],
  );
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return load(false);
    });
    return () => {
      active = false;
      sequence.current += 1;
    };
  }, [load]);
  const current = state.key === key;
  return {
    scopeBinding: binding,
    context,
    setContext,
    report: current ? state.report : undefined,
    loading: enabled && (!current || state.loading),
    failed: current && state.failed,
    enabled,
    refresh: () => {
      if (enabled)
        setState((prior) => ({
          key,
          loading: true,
          failed: false,
          ...(prior.key === key && prior.report ? { report: prior.report } : {}),
        }));
      return load(true);
    },
  };
}
