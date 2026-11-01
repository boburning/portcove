import { desktopApi } from "../../api";
import { errorText } from "../../view-model";
import { pickSourceArchivePath, pickSourcePath, type SourcePickerPurpose } from "../../file-picker";
import type { SourceProfile, SourceRecord } from "../../types";
import type { Perform, ReportError } from "../operations/use-operation-state";
import { targetInvocationContext } from "../operations/invocation-state";

export async function replaceRegisteredSource(
  profile: SourceProfile | undefined,
  source: SourceRecord,
  purpose: SourcePickerPurpose,
  perform: Perform,
  setError: ReportError,
  libraryGeneration: number,
) {
  const context = targetInvocationContext(
    purpose === "bios" ? "Update BIOS location" : "Update game-file location",
    {
      kind: "source",
      id: profile?.id ?? source.profile_id,
      label:
        profile?.label ??
        (purpose === "bios" ? "Selected BIOS location" : "Selected game-file location"),
    },
    libraryGeneration,
    "library",
  );
  if (!profile) {
    setError("The selected file’s requirements are missing from the current catalog.", context);
    return;
  }
  try {
    const path = await pickSourcePath(profile, source.path, purpose);
    if (path)
      await perform(
        "update game-file location",
        async () => {
          const plan = await desktopApi.planSourceRelink(profile.id, path, libraryGeneration);
          return desktopApi.relinkSource(profile.id, path, plan.preview_sha256, libraryGeneration);
        },
        {
          context,
        },
      );
  } catch (value) {
    setError(errorText(value), context);
  }
}

export async function addRequiredSource(
  profile: SourceProfile,
  archive: boolean,
  purpose: SourcePickerPurpose,
  perform: Perform,
  setError: ReportError,
  libraryGeneration: number,
) {
  const context = targetInvocationContext(
    purpose === "bios" ? "Add BIOS file" : "Add game files",
    { kind: "source", id: profile.id, label: profile.label },
    libraryGeneration,
    "library",
  );
  try {
    const path = await (archive
      ? pickSourceArchivePath("", purpose)
      : pickSourcePath(profile, "", purpose));
    if (path)
      await perform("add game files", () => desktopApi.addSource(profile.id, path), {
        context,
      });
  } catch (value) {
    setError(errorText(value), context);
  }
}
