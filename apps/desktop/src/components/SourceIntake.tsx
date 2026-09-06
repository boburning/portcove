import { useCallback, useEffect, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import { desktopApi } from "../api";
import { useDialogFocus } from "../dialog";
import { pickSourcePath } from "../file-picker";
import type { SourceImportMode, SourceImportPlan, SourceIntakeInspection, SourceProfile } from "../types";
import { errorText, isCancellation } from "../view-model";
import { SourceIdentityPanel } from "./SourceIdentity";
import { SourceImportReview, sourceImportModeLabel, sourceImportNotice } from "./SourceDiscovery";
import { Icon, NavigationHints } from "./ui";

export interface SourceIntakeRequest {
  portId: string;
  portName: string;
  profile: SourceProfile;
  paths: string[];
}

export function SourceIntakeDialog({ request, close, onAdded, openEvidence }: {
  request: SourceIntakeRequest;
  close: () => void;
  onAdded?: () => Promise<void>;
  openEvidence?: (evidenceId: string) => void;
}) {
  const [result, setResult] = useState<SourceIntakeInspection>();
  const [plan, setPlan] = useState<SourceImportPlan>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedPaths, setSelectedPaths] = useState(request.paths);
  const intent = useRef(0);
  const dismiss = () => { if (!busy) close(); };
  const dialog = useDialogFocus(dismiss);

  const inspect = useCallback(async (paths: string[]) => {
    const current = ++intent.current;
    setSelectedPaths(paths);
    setBusy("Checking game files…");
    setError(undefined);
    setNotice(undefined);
    setPlan(undefined);
    try {
      const inspection = await desktopApi.inspectSourceIntake(request.profile.id, paths);
      if (intent.current === current) setResult(inspection);
    } catch (value) {
      if (intent.current === current) setError(errorText(value));
    } finally {
      if (intent.current === current) setBusy("");
    }
  }, [request.profile.id]);

  useEffect(() => {
    if (request.paths.length > 0) void inspect(request.paths);
    return () => { intent.current += 1; };
  }, [inspect, request.paths]);

  const choose = async () => {
    setError(undefined);
    try {
      const path = await pickSourcePath(request.profile, selectedPaths[0] ?? "");
      if (path) await inspect([path]);
      else setNotice("File selection cancelled. Nothing was changed.");
    } catch (value) {
      if (isCancellation(value)) setNotice("File selection cancelled. Nothing was changed.");
      else setError(errorText(value));
    }
  };
  const review = async (mode: SourceImportMode) => {
    if (!result?.report?.inspection?.record || selectedPaths.length !== 1) return;
    const current = ++intent.current;
    setBusy("Checking the source and destination…");
    setError(undefined);
    setNotice(undefined);
    try {
      const next = await desktopApi.planSourceImport(request.profile.id, selectedPaths[0], mode);
      if (intent.current === current) setPlan(next);
    } catch (value) {
      if (intent.current === current) setError(errorText(value));
    } finally {
      if (intent.current === current) setBusy("");
    }
  };
  const apply = async () => {
    if (!plan) return;
    const current = ++intent.current;
    setBusy(`${sourceImportModeLabel[plan.mode]}…`);
    setError(undefined);
    try {
      const imported = await desktopApi.importSource(plan.profile_id, plan.source.path, plan.mode, plan.plan_sha256);
      if (intent.current !== current) return;
      setPlan(undefined);
      if (!imported) setNotice("Move cancelled. The original and registration were left unchanged.");
      else {
        setNotice(sourceImportNotice(imported));
        await onAdded?.();
      }
    } catch (value) {
      if (intent.current === current) setError(errorText(value));
    } finally {
      if (intent.current === current) setBusy("");
    }
  };
  const candidate = result?.report?.inspection?.record;

  return <div className="scrim source-intake-scrim"><section ref={dialog} className="modal wide-modal source-intake" role="dialog" aria-modal="true" aria-labelledby="source-intake-title">
    <p className="eyebrow">GAME FILE CHECK</p>
    <h2 id="source-intake-title">Check files for {request.portName}</h2>
    <p className="modal-description">Portcove checks the selected files for this game only. Checking does not install, register, copy, move, replace, or delete anything.</p>
    <NavigationHints />
    <div className="source-intake-picker"><button data-focusable data-autofocus type="button" className="button-with-icon" disabled={Boolean(busy)} onClick={() => { void choose(); }}><Icon glyph={FileSearch} />Choose game files to check</button><small>{request.profile.label}</small></div>
    {busy && <p role="status">{busy}</p>}
    {result && <section className="source-intake-result" aria-label="Game file check result">
      {!result.report && <><p className="source-intake-summary" role="status">{result.summary}</p><p>{result.next_action}</p>{result.problem && <details><summary data-focusable>Check details</summary><p>{result.problem.message}</p></details>}</>}
      {result.report && <SourceIdentityPanel report={result.report} openEvidence={openEvidence} />}
      {candidate && !plan && <div className="source-intake-actions" aria-label="Add checked game files">
        <p>Checking is complete. Choose a separate action only if you want Portcove to add these files.</p>
        <div className="actions"><button data-focusable className="primary" disabled={Boolean(busy)} onClick={() => { void review("copy"); }}>Copy to Source Inbox</button><button data-focusable disabled={Boolean(busy)} onClick={() => { void review("use_current_location"); }}>Use current location</button><button data-focusable className="danger" disabled={Boolean(busy)} onClick={() => { void review("move"); }}>Review destructive move</button></div>
      </div>}
    </section>}
    <SourceImportReview plan={plan} busy={Boolean(busy)} onCancel={() => setPlan(undefined)} onApply={apply} />
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <div className="actions"><button data-focusable disabled={Boolean(busy)} onClick={dismiss}>Close</button></div>
  </section></div>;
}
