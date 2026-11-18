import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

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
  project: string;
  file: string;
  name: string;
  fileName: string;
};
export type ModEdit = { native_id: string; enabled: boolean | null };
export type ModDraft = {
  additions: ModAddition[];
  packages: ModEdit[];
  order: string[] | null;
  localFiles?: LocalModSelection[];
};

export const emptyModDraft: ModDraft = { additions: [], packages: [], order: null };

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
          item && [item.provider, item.project, item.file, item.name, item.fileName].every(text),
      ) ||
      !Array.isArray(draft.packages) ||
      draft.packages.length > 1024 ||
      !draft.packages.every(
        (item) =>
          item &&
          text(item.native_id) &&
          (item.enabled === null || typeof item.enabled === "boolean"),
      ) ||
      (draft.order !== null && (!Array.isArray(draft.order) || !draft.order.every(text)))
    )
      return emptyModDraft;
    const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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
}): [
  ModDraft,
  Dispatch<SetStateAction<ModDraft>>,
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
  if (saved.key !== key) {
    setSaved(read());
    return [emptyModDraft, () => {}, undefined, () => {}];
  }
  const updateDraft: Dispatch<SetStateAction<ModDraft>> = (update) => {
    const current = latest.current;
    if (current.key !== key) return;
    const draft = typeof update === "function" ? update(current.draft) : update;
    const updated = { ...current, draft };
    latest.current = updated;
    setSaved(updated);
    if (!key || !scopeKey || !scope.library) return;
    try {
      if (draftSize(draft)) {
        localStorage.setItem(key, JSON.stringify(draft));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // Keep the current in-memory draft if local writes are unavailable.
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
  return [saved.draft, updateDraft, saved.stale, updateOlder];
}
