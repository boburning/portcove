import { useLayoutEffect, useRef, useState, type SetStateAction } from "react";

import type { OutputLocalModPackagePlan } from "../../transport-types.generated";

export type LocalModSelection = {
  path: string;
  review: Pick<
    OutputLocalModPackagePlan,
    | "native_id"
    | "profile_id"
    | "expected_revision"
    | "plan_sha256"
    | "sha256"
    | "needs_code_permission"
  >;
};

export type ModAddition = {
  provider: string;
  gameId?: string;
  project: string;
  file: string;
  name: string;
  fileName: string;
};
export type ModEdit = { native_id: string; enabled: boolean | null; beforeRemoval?: boolean };
export type ModDraftReceipt = { revision: number; digest: string };
export type ModDraft = {
  additions: ModAddition[];
  packages: ModEdit[];
  order: string[] | null;
  localFiles?: LocalModSelection[];
  receipt?: ModDraftReceipt;
};

export const emptyModDraft: ModDraft = { additions: [], packages: [], order: null };

/** A queued removal temporarily replaces an enable or disable of the same package. */
export function changeModEdit(
  draft: ModDraft,
  nativeIds: readonly string[],
  enabled: boolean | null | undefined,
): ModDraft {
  const packages = draft.packages.filter((edit) => !nativeIds.includes(edit.native_id));
  for (const native_id of nativeIds) {
    const previous = draft.packages.find((edit) => edit.native_id === native_id);
    if (enabled === null) {
      if (previous?.enabled === null) packages.push(previous);
      else if (previous) packages.push({ native_id, enabled, beforeRemoval: previous.enabled });
      else packages.push({ native_id, enabled });
    } else {
      const value = enabled ?? (previous?.enabled === null ? previous.beforeRemoval : undefined);
      if (value !== undefined) packages.push({ native_id, enabled: value });
    }
  }
  return { ...draft, packages };
}

export function draftSize(draft: ModDraft) {
  return (
    draft.additions.length +
    draft.packages.length +
    Number(draft.order !== null) +
    (draft.localFiles?.length ?? 0)
  );
}

function readDraft(key: string): ModDraft {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 200_000) return emptyModDraft;
    const draft = JSON.parse(raw) as ModDraft | null;
    const text = (value: unknown) =>
      typeof value === "string" && value.length > 0 && value.length <= 256;
    if (
      !draft ||
      !Array.isArray(draft.additions) ||
      draft.additions.length > 16 ||
      !draft.additions.every(
        (item) =>
          item &&
          (item.gameId === undefined || text(item.gameId)) &&
          [item.provider, item.project, item.file, item.name, item.fileName].every(text),
      ) ||
      !Array.isArray(draft.packages) ||
      draft.packages.length > 1024 ||
      !draft.packages.every(
        (item) =>
          item &&
          text(item.native_id) &&
          (item.enabled === null || typeof item.enabled === "boolean") &&
          (item.beforeRemoval === undefined ||
            (item.enabled === null && typeof item.beforeRemoval === "boolean")),
      ) ||
      (draft.order !== null && (!Array.isArray(draft.order) || !draft.order.every(text)))
    )
      return emptyModDraft;
    const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    if (
      draft.receipt !== undefined &&
      (!draft.receipt ||
        !Number.isSafeInteger(draft.receipt.revision) ||
        draft.receipt.revision <= 0 ||
        !digest(draft.receipt.digest))
    )
      delete draft.receipt;
    if (
      draft.localFiles !== undefined &&
      (!Array.isArray(draft.localFiles) ||
        draft.localFiles.length + draft.additions.length > 16 ||
        !draft.localFiles.every(
          (entry) =>
            entry &&
            typeof entry.path === "string" &&
            entry.path.length > 0 &&
            entry.path.length <= 4096 &&
            entry.review &&
            text(entry.review.native_id) &&
            text(entry.review.profile_id) &&
            Number.isSafeInteger(entry.review.expected_revision) &&
            digest(entry.review.plan_sha256) &&
            digest(entry.review.sha256) &&
            typeof entry.review.needs_code_permission === "boolean",
        ))
    )
      return emptyModDraft;
    return draft;
  } catch {
    return emptyModDraft;
  }
}

type StaleDraft = { base: number; selections: ModDraft };

function olderDraft(key: string, base: number) {
  try {
    const prefix = `${key}.`;
    const keys: number[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const entry = localStorage.key(index);
      if (!entry?.startsWith(prefix)) continue;
      const revision = Number(entry.slice(prefix.length));
      if (Number.isSafeInteger(revision) && revision > 0 && revision < base) keys.push(revision);
    }
    for (const previous of keys.sort((left, right) => right - left)) {
      const selections = readDraft(`${key}.${previous}`);
      if (draftSize(selections)) return { base: previous, selections };
    }
  } catch {
    // A blocked preference store does not prevent browsing.
  }
}

export function useModDraft(scope: {
  library: string | undefined;
  port: string;
  setup: string | undefined;
  revision: number | undefined;
  appliedRevision?: ModDraftReceipt | undefined;
}): [
  ModDraft,
  (update: SetStateAction<ModDraft>) => boolean,
  StaleDraft | undefined,
  (draft?: ModDraft) => void,
] {
  const scopeKey =
    scope.setup === undefined
      ? undefined
      : `portcove.mod-draft.${JSON.stringify([scope.library, scope.port, scope.setup])}`;
  const key = scopeKey ? `${scopeKey}.${scope.revision}` : undefined;
  const read = () => ({
    key,
    draft: key && scope.library ? readDraft(key) : emptyModDraft,
    stale:
      scopeKey && scope.library && scope.revision
        ? olderDraft(scopeKey, scope.revision)
        : undefined,
  });
  const [saved, setSaved] = useState(read);
  const latest = useRef(saved);
  useLayoutEffect(() => {
    latest.current = saved;
  }, [saved]);
  const { revision: appliedRevision, digest: appliedDigest } = scope.appliedRevision ?? {};
  const recovered =
    saved.stale?.selections.receipt?.revision === appliedRevision &&
    saved.stale?.selections.receipt?.digest === appliedDigest &&
    appliedRevision !== undefined;
  useLayoutEffect(() => {
    const current = latest.current;
    if (!recovered || !scopeKey || !scope.revision || current.key !== key || !current.stale) return;
    try {
      localStorage.removeItem(`${scopeKey}.${current.stale.base}`);
      const updated = { ...current, stale: olderDraft(scopeKey, scope.revision) };
      latest.current = updated;
      setSaved(updated);
    } catch {
      // Keep the disk copy if the store cannot remove it.
    }
  }, [key, recovered, saved.stale, scopeKey, scope.revision]);
  if (saved.key !== key) {
    setSaved(read());
    return [emptyModDraft, () => false, undefined, () => {}];
  }
  const updateDraft = (update: SetStateAction<ModDraft>) => {
    const current = latest.current;
    if (current.key !== key) return false;
    const draft = typeof update === "function" ? update(current.draft) : update;
    const updated = { ...current, draft };
    latest.current = updated;
    setSaved(updated);
    if (!key || !scopeKey || !scope.library) return false;
    try {
      if (draftSize(draft)) {
        localStorage.setItem(key, JSON.stringify(draft));
      } else {
        localStorage.removeItem(key);
      }
      return true;
    } catch {
      // Keep the current in-memory draft if local writes are unavailable.
      return false;
    }
  };
  const updateOlder = (draft?: ModDraft) => {
    const current = latest.current;
    if (!scopeKey || current.key !== key || !current.stale || !scope.revision) return;
    const previous = `${scopeKey}.${current.stale.base}`;
    try {
      if (draft && draftSize(draft)) localStorage.setItem(previous, JSON.stringify(draft));
      else localStorage.removeItem(previous);
      const updated = { ...current, stale: olderDraft(scopeKey, scope.revision) };
      latest.current = updated;
      setSaved(updated);
    } catch {
      // The old draft stays available if the store cannot save the change.
    }
  };
  return [saved.draft, updateDraft, recovered ? undefined : saved.stale, updateOlder];
}
