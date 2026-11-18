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
    const previous = Number(localStorage.getItem(`${key}.base`));
    if (!Number.isSafeInteger(previous) || previous < 1 || previous === base) return;
    const selections = readDraft(`${key}.${previous}`);
    if (draftSize(selections)) return { base: previous, selections };
  } catch {
    // A blocked preference store does not prevent browsing.
  }
}

export function useModDraft(scope: {
  library: string | undefined;
  port: string;
  setup: string | undefined;
  revision: number | undefined;
}): [ModDraft, Dispatch<SetStateAction<ModDraft>>, StaleDraft | undefined, () => void] {
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
        if (!current.stale) localStorage.setItem(`${scopeKey}.base`, String(scope.revision));
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // Keep the current in-memory draft if local writes are unavailable.
    }
  };
  const forgetOlder = () => {
    if (!scopeKey || !saved.stale) return;
    try {
      localStorage.removeItem(`${scopeKey}.${saved.stale.base}`);
      localStorage.setItem(`${scopeKey}.base`, String(scope.revision));
    } catch {
      // Remember the decision for this session if preferences are unavailable.
    }
    setSaved((current) => (current.key === key ? { ...current, stale: undefined } : current));
  };
  return [saved.draft, updateDraft, saved.stale, forgetOlder];
}
