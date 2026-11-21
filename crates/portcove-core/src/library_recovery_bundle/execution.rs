use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    Creation, LibraryRecoveryBundlePlan, LibraryRecoveryCoverage, LibraryRecoveryExclusion,
    prepare, require_capacity,
};
use crate::{
    Library, LibraryImportPlan, LibraryImportResult, LibraryMetadata, LibraryTreePlan,
    PortcoveError, PortcoveService, Result,
    library_import::{PortabilityCatalogs, read_metadata, validate_metadata},
    library_transfer::plan_portable_content,
};

const FORMAT: u32 = 1;
const STAGING_PREFIX: &str = ".portcove-recovery-bundle-";
const JOURNAL_FILE: &str = "intent.json";
const PAYLOAD_DIR: &str = "payload";
const CONTENT_DIR: &str = "content";
const WORK_DIR: &str = "work";
const METADATA_FILE: &str = "metadata.json";
const MANIFEST_FILE: &str = "portcove-recovery-bundle.json";
const JOURNAL_DOMAIN: &str = "portcove:recovery-bundle-creation:v1";
const RECEIPT_DOMAIN: &str = "portcove:recovery-bundle-publication:v1";
pub(super) const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 32 * 1024 * 1024;
const MAX_JOURNAL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryRecoveryBundle {
    pub format_version: u32,
    pub bundle_id: String,
    pub source_library_id: String,
    pub path: PathBuf,
    pub created_at: i64,
    pub coverage: Vec<LibraryRecoveryCoverage>,
    pub exclusions: Vec<LibraryRecoveryExclusion>,
    pub receipt_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LibraryRecoveryRestorePlan {
    pub bundle: LibraryRecoveryBundle,
    pub destination_root: PathBuf,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub plan_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Authenticated<T> {
    body: T,
    proof_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreationIntent {
    format_version: u32,
    bundle_id: Uuid,
    plan: LibraryRecoveryBundlePlan,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format_version: u32,
    bundle_id: Uuid,
    source_library_id: String,
    reviewed_plan_sha256: String,
    created_at: i64,
    metadata_sha256: String,
    content: Vec<LibraryTreePlan>,
    coverage: Vec<LibraryRecoveryCoverage>,
    exclusions: Vec<LibraryRecoveryExclusion>,
}

/// Point-in-time transfer observation. Cancellable copying uses private staging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryRecoveryProgress {
    Copying { copied_bytes: u64, total_bytes: u64 },
    Verifying,
}

impl PortcoveService {
    /// Copy a reviewed point-in-time recovery bundle without moving the active library.
    /// No ordinary source handles may remain open while this takes the exclusive lease.
    pub fn create_library_recovery_bundle(
        source: &Path,
        destination: &Path,
        expected_plan: &str,
    ) -> Result<LibraryRecoveryBundle> {
        Self::create_library_recovery_bundle_with_progress(
            source,
            destination,
            expected_plan,
            |_| Ok(()),
        )
    }

    pub fn create_library_recovery_bundle_with_progress(
        source: &Path,
        destination: &Path,
        expected_plan: &str,
        mut observe: impl FnMut(LibraryRecoveryProgress) -> Result<()>,
    ) -> Result<LibraryRecoveryBundle> {
        start_creation(source, destination, expected_plan, &mut observe, &|| {
            #[cfg(feature = "qualification-fixtures")]
            crate::qualification_checkpoint::observe(
                source,
                crate::qualification_checkpoint::Checkpoint::RecoveryBundleCopied,
            )?;
            Ok(())
        })
    }

    pub fn resume_library_recovery_bundle(staging: &Path) -> Result<LibraryRecoveryBundle> {
        Self::resume_library_recovery_bundle_with_progress(staging, |_| Ok(()))
    }

    pub fn resume_library_recovery_bundle_with_progress(
        staging: &Path,
        mut observe: impl FnMut(LibraryRecoveryProgress) -> Result<()>,
    ) -> Result<LibraryRecoveryBundle> {
        let stage = checked_directory(staging)?;
        let intent = read_creation_intent(&stage)?;
        let result = (|| match fs::symlink_metadata(&intent.plan.destination_root) {
            Ok(_) => {
                observe(LibraryRecoveryProgress::Verifying)?;
                inspect_created(&intent)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let library = open_source(&intent.plan.source_root)?;
                if payload_left_staging(&stage)? {
                    return Err(PortcoveError::conflict(
                        "The staged copy has already left this folder. Locate and inspect the published bundle, or review a new copy.",
                    ));
                }
                let service = Self::new_read_only(library)?;
                let (review, metadata, content) = prepare(
                    &service,
                    &intent.plan.destination_root,
                    Creation::Continuing,
                )?;
                require_same_plan(&review, &intent.plan.plan_sha256)?;
                publish_creation(
                    &service,
                    &stage,
                    &intent,
                    metadata,
                    &content,
                    &mut observe,
                    &|| Ok(()),
                )
            }
            Err(error) => Err(error.into()),
        })();
        result.map_err(|error| creation_error(error, &stage))
    }

    /// Verify a completed bundle without opening its database or changing preferences.
    pub fn inspect_library_recovery_bundle(path: &Path) -> Result<LibraryRecoveryBundle> {
        inspect(path).map(|(summary, _)| summary)
    }

    /// Re-read a possibly committed create result for its exact reviewed destination and plan.
    pub fn inspect_library_recovery_bundle_for_plan(
        path: &Path,
        expected_plan: &str,
    ) -> Result<LibraryRecoveryBundle> {
        let (bundle, manifest) = inspect(path)?;
        if manifest.reviewed_plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "the verified bundle belongs to a different recovery review",
            ));
        }
        Ok(bundle)
    }

    /// Preview a checked import into a new or empty library. Opening it is separate.
    pub fn plan_library_recovery_restore(
        path: &Path,
        destination: &Path,
    ) -> Result<LibraryRecoveryRestorePlan> {
        prepare_restore(path, destination).map(|(review, _)| review)
    }

    pub fn restore_library_recovery_bundle(
        path: &Path,
        destination: &Path,
        expected_plan: &str,
    ) -> Result<LibraryImportResult> {
        Self::restore_library_recovery_bundle_with_progress(
            path,
            destination,
            expected_plan,
            |_| Ok(()),
        )
    }

    pub fn restore_library_recovery_bundle_with_progress(
        path: &Path,
        destination: &Path,
        expected_plan: &str,
        mut observe: impl FnMut(LibraryRecoveryProgress) -> Result<()>,
    ) -> Result<LibraryImportResult> {
        let (review, import) = prepare_restore(path, destination)?;
        if review.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "recovery bundle or restore destination changed; review recovery again",
            ));
        }
        // Import owns all mutation, recovery, and publication of the restored
        // root. Its content-bound journal can be resumed without a second owner.
        let path = import.destination_root.clone();
        crate::import_execution::start_reviewed_import_with_progress(
            import,
            Some(&review.bundle),
            &|phase| {
                #[cfg(feature = "qualification-fixtures")]
                if phase == crate::transfer_journal::TransferPhase::Copying {
                    return crate::qualification_checkpoint::observe(
                        &path,
                        crate::qualification_checkpoint::Checkpoint::RecoveryBundleRestoreCopying,
                    );
                }
                #[cfg(feature = "qualification-fixtures")]
                if phase == crate::transfer_journal::TransferPhase::Published {
                    return crate::qualification_checkpoint::observe(
                        &path,
                        crate::qualification_checkpoint::Checkpoint::LibraryImportPublished,
                    );
                }
                let _ = (&path, phase);
                Ok(())
            },
            &mut observe,
        )
    }
}

fn prepare_restore(
    path: &Path,
    destination: &Path,
) -> Result<(LibraryRecoveryRestorePlan, LibraryImportPlan)> {
    let (bundle, manifest) = inspect(path)?;
    let import = PortcoveService::plan_library_import(
        &bundle.path.join(METADATA_FILE),
        &bundle.path.join(CONTENT_DIR),
        destination,
    )?;
    if [&bundle.path, &import.metadata.original_root]
        .iter()
        .any(|root| {
            import.destination_root.starts_with(root) || root.starts_with(&import.destination_root)
        })
    {
        return Err(PortcoveError::usage(
            "recovery destination must be separate from the bundle and its source library",
        ));
    }
    if import.metadata_file.sha256 != manifest.metadata_sha256
        || serde_json::to_value(&import.content)? != serde_json::to_value(&manifest.content)?
    {
        return Err(PortcoveError::verification(
            "bundle content changed while reviewing recovery",
        ));
    }
    let plan_sha256 = crate::import_journal::recovery_restore_fingerprint(
        &bundle.path,
        &bundle.receipt_sha256,
        &import.plan_sha256,
    )?;
    let review = LibraryRecoveryRestorePlan {
        bundle,
        destination_root: import.destination_root.clone(),
        required_bytes: import.required_bytes,
        available_bytes: import.available_bytes,
        plan_sha256,
    };
    Ok((review, import))
}

fn start_creation(
    source: &Path,
    destination: &Path,
    expected_plan: &str,
    observe: &mut dyn FnMut(LibraryRecoveryProgress) -> Result<()>,
    after_copy: &dyn Fn() -> Result<()>,
) -> Result<LibraryRecoveryBundle> {
    let library = open_source(source)?;
    let service = PortcoveService::new_read_only(library)?;
    let (plan, metadata, content) = prepare(&service, destination, Creation::New)?;
    require_same_plan(&plan, expected_plan)?;
    require_capacity(&plan)?;
    let intent = CreationIntent {
        format_version: FORMAT,
        bundle_id: Uuid::new_v4(),
        plan,
        created_at: metadata.exported_at,
    };
    let stage = staging_path(&intent)?;
    create_private_directory(&stage)?;
    if let Err(error) = require_private_directory(&stage).and_then(|()| {
        write_authenticated(
            &stage.join(JOURNAL_FILE),
            &stage,
            JOURNAL_DOMAIN,
            &intent,
            MAX_JOURNAL_BYTES,
        )
    }) {
        // This is the only cleanup of a stage. It succeeds only while empty.
        let _ = fs::remove_dir(&stage);
        return Err(creation_error(error, &stage));
    }
    crate::durability::sync_publication(stage.parent().expect("staging has parent"))
        .map_err(|error| creation_error(error, &stage))?;
    publish_creation(
        &service, &stage, &intent, metadata, &content, observe, after_copy,
    )
    .map_err(|error| creation_error(error, &stage))
}

fn publish_creation(
    service: &PortcoveService,
    stage: &Path,
    intent: &CreationIntent,
    mut metadata: LibraryMetadata,
    content: &[LibraryTreePlan],
    observe: &mut dyn FnMut(LibraryRecoveryProgress) -> Result<()>,
    after_copy: &dyn Fn() -> Result<()>,
) -> Result<LibraryRecoveryBundle> {
    require_private_directory(stage)?;
    let payload = stage.join(PAYLOAD_DIR);
    match create_private_directory(&payload) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    require_private_directory(&payload)?;
    let content_root = payload.join(CONTENT_DIR);
    ensure_directory(&content_root)?;
    let catalogs = PortabilityCatalogs::from_root(&metadata, service.library().root())?;
    crate::transfer_copy::verify_installations(service.library(), &metadata, &catalogs)?;
    let work = stage.join(WORK_DIR);
    ensure_directory(&work)?;
    crate::transfer_copy::copy_library_payload(
        service.library().root(),
        &content_root,
        content,
        &work,
        observe,
    )?;
    after_copy()?;
    observe(LibraryRecoveryProgress::Verifying)?;
    metadata.exported_at = intent.created_at;
    let metadata_bytes = serde_json::to_vec_pretty(&metadata)?;
    write_or_verify(
        &payload.join(METADATA_FILE),
        &work,
        &metadata_bytes,
        MAX_METADATA_BYTES,
    )?;
    let manifest = Manifest {
        format_version: FORMAT,
        bundle_id: intent.bundle_id,
        source_library_id: intent.plan.source_library_id.clone(),
        reviewed_plan_sha256: intent.plan.plan_sha256.clone(),
        created_at: intent.created_at,
        metadata_sha256: sha256(&metadata_bytes),
        content: content.to_vec(),
        coverage: intent.plan.coverage.clone(),
        exclusions: intent.plan.exclusions.clone(),
    };
    let proof = write_authenticated(
        &payload.join(MANIFEST_FILE),
        &work,
        RECEIPT_DOMAIN,
        &manifest,
        MAX_MANIFEST_BYTES,
    )?;
    verify_payload(&payload, &manifest)?;
    // The source lease protects against Portcove writers. Recheck the complete
    // source before publication to detect changes outside that coordination.
    let (review, _, _) = prepare(service, &intent.plan.destination_root, Creation::Continuing)?;
    require_same_plan(&review, &intent.plan.plan_sha256)?;
    crate::transfer_copy::refuse_sensitive_content(
        &intent.plan.source_root,
        &content_root,
        content,
    )?;
    require_private_directory(stage)?;
    require_private_directory(&payload)?;
    crate::durability::rename_noreplace(&payload, &intent.plan.destination_root)?;
    crate::durability::sync_publication(stage)?;
    crate::durability::sync_publication(stage.parent().expect("staging has parent"))?;
    let published = inspect_created(intent)?;
    if published.receipt_sha256 != proof {
        return Err(PortcoveError::verification(
            "published recovery bundle differs from the staged receipt",
        ));
    }
    Ok(published)
}

fn inspect_created(intent: &CreationIntent) -> Result<LibraryRecoveryBundle> {
    let (summary, manifest) = inspect(&intent.plan.destination_root)?;
    if summary.bundle_id != intent.bundle_id.to_string()
        || summary.source_library_id != intent.plan.source_library_id
        || manifest.reviewed_plan_sha256 != intent.plan.plan_sha256
    {
        return Err(PortcoveError::verification(
            "recovery bundle destination is occupied by a different object",
        ));
    }
    Ok(summary)
}

fn inspect(path: &Path) -> Result<(LibraryRecoveryBundle, Manifest)> {
    let path = checked_directory(path)?;
    refuse_staging_path(&path)?;
    let signed: Authenticated<Manifest> =
        read_signed(&path.join(MANIFEST_FILE), MAX_MANIFEST_BYTES)?;
    require_format(signed.body.format_version)?;
    crate::portability_authority::verify_recovery_bundle(
        RECEIPT_DOMAIN,
        &signed.body,
        &signed.proof_sha256,
    )?;
    verify_payload(&path, &signed.body)?;
    Ok((
        LibraryRecoveryBundle {
            format_version: FORMAT,
            bundle_id: signed.body.bundle_id.to_string(),
            source_library_id: signed.body.source_library_id.clone(),
            path,
            created_at: signed.body.created_at,
            coverage: signed.body.coverage.clone(),
            exclusions: signed.body.exclusions.clone(),
            receipt_sha256: signed.proof_sha256,
        },
        signed.body,
    ))
}

fn verify_payload(path: &Path, manifest: &Manifest) -> Result<()> {
    require_exact_entries(path, &[CONTENT_DIR, METADATA_FILE, MANIFEST_FILE])?;
    let content_root = checked_directory(&path.join(CONTENT_DIR))?;
    let (file, metadata) = read_metadata(&path.join(METADATA_FILE))?;
    if file.sha256 != manifest.metadata_sha256 {
        return Err(PortcoveError::verification(
            "recovery bundle metadata differs from its receipt",
        ));
    }
    let catalogs = PortabilityCatalogs::from_root(&metadata, &content_root)?;
    validate_metadata(&metadata, &catalogs)?;
    let expected_names = metadata
        .content_roots
        .iter()
        .map(|root| root.relative_path.as_str())
        .collect::<Vec<_>>();
    require_exact_entries(&content_root, &expected_names)?;
    let observed = plan_portable_content(&metadata, &content_root)?;
    if serde_json::to_value(&observed)? != serde_json::to_value(&manifest.content)? {
        return Err(PortcoveError::verification(
            "recovery bundle files differ from the verified inventory",
        ));
    }
    Ok(())
}

fn require_exact_entries(root: &Path, expected: &[&str]) -> Result<()> {
    let mut count = 0;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !expected.iter().any(|name| entry.file_name() == *name) {
            return Err(PortcoveError::verification(
                "recovery bundle contains an entry outside its format",
            ));
        }
        count += 1;
    }
    if count != expected.len() {
        return Err(PortcoveError::verification(
            "recovery bundle is missing a required entry",
        ));
    }
    Ok(())
}

fn staging_path(intent: &CreationIntent) -> Result<PathBuf> {
    let parent = intent
        .plan
        .destination_root
        .parent()
        .ok_or_else(|| PortcoveError::state("recovery bundle destination has no parent"))?;
    Ok(parent.join(format!("{STAGING_PREFIX}{}", intent.bundle_id)))
}

fn read_creation_intent(stage: &Path) -> Result<CreationIntent> {
    require_private_directory(stage)?;
    let intent: CreationIntent =
        read_authenticated(&stage.join(JOURNAL_FILE), JOURNAL_DOMAIN, MAX_JOURNAL_BYTES)?;
    require_format(intent.format_version)?;
    if stage != staging_path(&intent)? {
        return Err(PortcoveError::verification(
            "recovery bundle journal was moved from its owned staging directory",
        ));
    }
    Ok(intent)
}

fn payload_left_staging(stage: &Path) -> Result<bool> {
    fn exists(path: &Path) -> Result<bool> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    // Publication moves payload out atomically and keeps work in staging.
    // Work is created only after payload, so this state cannot establish an
    // incomplete copy that is safe to replay.
    Ok(!exists(&stage.join(PAYLOAD_DIR))? && exists(&stage.join(WORK_DIR))?)
}

pub(super) fn require_no_interrupted_creation(
    source: &Path,
    source_library_id: &str,
    destination: &Path,
) -> Result<()> {
    const MAX_PARENT_ENTRIES: usize = 16_384;
    const MAX_STAGING_ENTRIES: usize = 256;
    let parent = destination
        .parent()
        .ok_or_else(|| PortcoveError::state("recovery bundle destination has no parent"))?;
    let inventory_limit = || {
        PortcoveError::conflict(
            "Portcove could not check this folder for interrupted copies. Choose a different bundle folder, or open Resume an interrupted bundle operation if you already know the staging folder.",
        )
    };
    let mut staging_count = 0;
    let mut found = None;
    #[cfg(windows)]
    let mut possible_alias = None;
    for (index, entry) in fs::read_dir(parent)?.enumerate() {
        if index >= MAX_PARENT_ENTRIES {
            return Err(inventory_limit());
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_prefix(STAGING_PREFIX))
        else {
            continue;
        };
        if Uuid::parse_str(id).is_err() || !entry.file_type()?.is_dir() {
            continue;
        }
        staging_count += 1;
        if staging_count > MAX_STAGING_ENTRIES {
            return Err(inventory_limit());
        }
        let stage = entry.path();
        let Ok(intent) = read_creation_intent(&stage) else {
            continue;
        };
        if intent.plan.source_root != source
            || intent.plan.source_library_id != source_library_id
            || payload_left_staging(&stage)?
        {
            continue;
        }
        if intent.plan.destination_root != destination {
            #[cfg(windows)]
            if let (Some(requested), Some(recorded)) = (
                destination.file_name(),
                intent.plan.destination_root.file_name(),
            ) && crate::path::windows_ordinal_names_equal(requested, recorded)
            {
                // The destination does not exist yet. Case may distinguish names on this
                // volume, so only the exact spelling can identify a resumable journal.
                possible_alias.get_or_insert(intent.plan.destination_root);
            }
            continue;
        }
        if found.replace(stage).is_some() {
            return Err(PortcoveError::conflict(
                "More than one interrupted copy uses this folder. Open Resume an interrupted bundle operation and choose the staging folder recorded for the copy you want.",
            ));
        }
    }
    if let Some(stage) = found {
        return Err(creation_error(
            PortcoveError::conflict("An interrupted copy is waiting for this bundle folder."),
            &stage,
        ));
    }
    #[cfg(windows)]
    if let Some(alias) = possible_alias {
        return Err(PortcoveError::conflict(
            "An interrupted copy uses a folder with a similar name. Review the folder with its recorded spelling, or choose a different folder.",
        )
        .detail("recovery_destination", alias.display().to_string()));
    }
    Ok(())
}

pub(super) fn refuse_staging_path(path: &Path) -> Result<()> {
    if path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .and_then(|part| part.strip_prefix(STAGING_PREFIX))
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
    }) {
        return Err(PortcoveError::conflict(
            "this path is inside a recovery bundle staging area",
        ));
    }
    Ok(())
}

fn checked_directory(path: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    crate::path::refuse_symlink_ancestors(&absolute)?;
    let metadata = fs::symlink_metadata(&absolute)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PortcoveError::verification(
            "recovery bundle requires an ordinary directory",
        ));
    }
    Ok(fs::canonicalize(absolute)?)
}

fn ensure_directory(path: &Path) -> Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    if checked_directory(path)? != path {
        return Err(PortcoveError::verification(
            "recovery bundle staging directory was replaced or redirected",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(windows)]
use crate::windows_user_access::create_private_directory;

fn require_private_directory(path: &Path) -> Result<()> {
    if checked_directory(path)? != path {
        return Err(PortcoveError::verification(
            "recovery bundle staging directory was replaced or redirected",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path)?;
        // SAFETY: geteuid has no pointer arguments and does not modify process state.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(PortcoveError::verification(
                "recovery bundle staging needs a directory private to your account",
            ));
        }
    }
    #[cfg(windows)]
    crate::windows_user_access::require_private_directory(path)?;
    Ok(())
}

fn open_source(path: &Path) -> Result<Library> {
    let root = checked_directory(path)?;
    let database = fs::symlink_metadata(crate::database::database_path(&root))?;
    if !database.is_file() || database.file_type().is_symlink() || database.len() == 0 {
        return Err(PortcoveError::verification(
            "recovery source must be an existing library",
        ));
    }
    Library::open_current_for_recovery_bundle(&root)
}

fn read_signed<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<Authenticated<T>> {
    let bytes = crate::path::read_bounded_regular(path, limit)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn read_authenticated<T: DeserializeOwned + Serialize>(
    path: &Path,
    domain: &'static str,
    limit: u64,
) -> Result<T> {
    let signed: Authenticated<T> = read_signed(path, limit)?;
    crate::portability_authority::verify_recovery_bundle(
        domain,
        &signed.body,
        &signed.proof_sha256,
    )?;
    Ok(signed.body)
}

fn write_authenticated<T: Serialize>(
    path: &Path,
    work: &Path,
    domain: &'static str,
    body: &T,
    limit: u64,
) -> Result<String> {
    let proof_sha256 = crate::portability_authority::sign_recovery_bundle(domain, body)?;
    let bytes = serde_json::to_vec(&Authenticated {
        body,
        proof_sha256: proof_sha256.clone(),
    })?;
    write_or_verify(path, work, &bytes, limit)?;
    Ok(proof_sha256)
}

fn write_or_verify(path: &Path, work: &Path, bytes: &[u8], limit: u64) -> Result<()> {
    if bytes.len() as u64 > limit {
        return Err(PortcoveError::unsupported(
            "recovery bundle document exceeds the supported size",
        ));
    }
    match fs::symlink_metadata(path) {
        Ok(_) => {
            if crate::path::read_bounded_regular(path, limit)? != bytes {
                return Err(PortcoveError::verification(
                    "existing recovery bundle document differs from reviewed bytes",
                ));
            }
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = path
        .parent()
        .ok_or_else(|| PortcoveError::state("recovery bundle document has no parent"))?;
    let mut output = tempfile::NamedTempFile::new_in(work)?;
    output.write_all(bytes)?;
    output.as_file().sync_all()?;
    output
        .persist_noclobber(path)
        .map_err(|error| PortcoveError::from(error.error))?;
    crate::durability::sync_publication(parent)
}

fn require_format(version: u32) -> Result<()> {
    if version != FORMAT {
        return Err(PortcoveError::unsupported(
            "unsupported library recovery bundle format",
        ));
    }
    Ok(())
}

fn require_same_plan(plan: &LibraryRecoveryBundlePlan, expected: &str) -> Result<()> {
    if plan.plan_sha256 != expected {
        return Err(PortcoveError::conflict(
            "source library or destination changed since bundle review; review again",
        ));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn creation_error(error: PortcoveError, staging: &Path) -> PortcoveError {
    error.detail("recovery_staging", staging.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_fixture(root: &Path, destination: &Path) -> (String, LibraryRecoveryBundlePlan) {
        let service = PortcoveService::new(Library::open(root).unwrap()).unwrap();
        let user = root.join("user");
        fs::create_dir_all(&user).unwrap();
        fs::write(user.join("progress.bin"), b"saved progress").unwrap();
        (
            service.library().identity().unwrap(),
            service.plan_library_recovery_bundle(destination).unwrap(),
        )
    }

    #[test]
    fn cancellation_waits_for_the_copy_worker_and_retains_exact_staging() {
        use std::sync::mpsc::channel;
        use std::time::Duration;

        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (source_id, plan) = plan_fixture(&source, &destination);
        let (paused, reached) = channel();
        let (cancel, requested) = channel();
        let timeout = Duration::from_secs(10);

        let error = std::thread::scope(|scope| {
            let destination = &destination;
            let source = &source;
            let expected_plan = plan.plan_sha256.as_str();
            let worker = scope.spawn(move || {
                PortcoveService::create_library_recovery_bundle_with_progress(
                    source,
                    destination,
                    expected_plan,
                    |progress| {
                        if matches!(
                            progress,
                            LibraryRecoveryProgress::Copying {
                                copied_bytes: 1..,
                                ..
                            }
                        ) {
                            paused.send(()).unwrap();
                            requested.recv_timeout(timeout).unwrap();
                            return Err(PortcoveError::new(
                                crate::ErrorCode::Cancelled,
                                "recovery bundle copying cancelled",
                            ));
                        }
                        Ok(())
                    },
                )
            });
            reached.recv_timeout(timeout).unwrap();
            // The plan resolves the destination parent to its canonical path, including
            // the extended-length prefix on Windows. Match the reported path exactly.
            let stage = fs::read_dir(plan.destination_root.parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| path.join(JOURNAL_FILE).is_file())
                .unwrap();
            assert!(!worker.is_finished());
            assert!(!destination.exists());
            assert!(stage.join(WORK_DIR).read_dir().unwrap().next().is_some());
            cancel.send(()).unwrap();
            let error = worker.join().unwrap().unwrap_err();
            assert_eq!(Path::new(&error.details["recovery_staging"]), stage);
            assert!(stage.join(JOURNAL_FILE).is_file());
            assert!(!stage.join(PAYLOAD_DIR).join(MANIFEST_FILE).exists());
            error
        });
        assert_eq!(error.code, crate::ErrorCode::Cancelled);
        assert!(!destination.exists());
        assert_eq!(
            fs::read(source.join("user/progress.bin")).unwrap(),
            b"saved progress"
        );
        let staged_path = &error.details["recovery_staging"];
        {
            let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
            let review_error = service
                .plan_library_recovery_bundle(&destination)
                .unwrap_err();
            assert_eq!(review_error.details["recovery_staging"], *staged_path);
            assert!(
                service
                    .plan_library_recovery_bundle(&workspace.path().join("another-bundle"))
                    .is_ok()
            );

            #[cfg(windows)]
            {
                let alternate = workspace.path().join("BUNDLE");
                let alias_error = service
                    .plan_library_recovery_bundle(&alternate)
                    .unwrap_err();
                assert_eq!(alias_error.code, crate::ErrorCode::Conflict);
                assert!(!alias_error.details.contains_key("recovery_staging"));
                assert_eq!(
                    Path::new(&alias_error.details["recovery_destination"]),
                    plan.destination_root,
                );
            }

            let journal = Path::new(staged_path).join(JOURNAL_FILE);
            let original = fs::read(&journal).unwrap();
            let mut modified: Authenticated<CreationIntent> =
                serde_json::from_slice(&original).unwrap();
            modified.proof_sha256.replace_range(.., &"0".repeat(64));
            fs::write(&journal, serde_json::to_vec(&modified).unwrap()).unwrap();
            assert!(service.plan_library_recovery_bundle(&destination).is_ok());
            fs::write(&journal, original).unwrap();

            let (_, other_plan) =
                plan_fixture(&workspace.path().join("another-library"), &destination);
            assert_ne!(other_plan.source_library_id, source_id);
        }
        let repeated = PortcoveService::create_library_recovery_bundle(
            &source,
            &destination,
            &plan.plan_sha256,
        )
        .unwrap_err();
        assert_eq!(repeated.details["recovery_staging"], *staged_path);
        assert!(!destination.exists());
        let resumed =
            PortcoveService::resume_library_recovery_bundle(Path::new(staged_path)).unwrap();
        assert_eq!(resumed.source_library_id, source_id);
        assert_eq!(resumed.path, plan.destination_root);
    }

    #[test]
    fn a_completed_bundle_can_move_without_blocking_new_review_or_replaying_its_copy() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (_, plan) = plan_fixture(&source, &destination);
        let bundle = PortcoveService::create_library_recovery_bundle(
            &source,
            &destination,
            &plan.plan_sha256,
        )
        .unwrap();
        let stage = fs::read_dir(bundle.path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.join(JOURNAL_FILE).is_file())
            .unwrap();
        let moved = workspace.path().join("stored-bundle");
        fs::rename(&bundle.path, &moved).unwrap();

        let error = PortcoveService::resume_library_recovery_bundle(&stage).unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::Conflict);
        assert!(!destination.exists());
        assert_eq!(
            PortcoveService::inspect_library_recovery_bundle(&moved)
                .unwrap()
                .receipt_sha256,
            bundle.receipt_sha256,
        );
        let service = PortcoveService::new(Library::open(&source).unwrap()).unwrap();
        assert!(service.plan_library_recovery_bundle(&destination).is_ok());
    }

    #[test]
    fn cancelled_restore_remains_gated_until_its_exact_journal_resumes() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let restored = workspace.path().join("restored");
        let (_, create_plan) = plan_fixture(&source, &destination);
        let bundle = PortcoveService::create_library_recovery_bundle(
            &source,
            &destination,
            &create_plan.plan_sha256,
        )
        .unwrap();
        assert!(PortcoveService::inspect_library_recovery_bundle_for_plan(
            &destination, "wrong review",
        ).is_err());
        assert_eq!(
            PortcoveService::inspect_library_recovery_bundle_for_plan(
                &destination,
                &create_plan.plan_sha256,
            )
            .unwrap()
            .receipt_sha256,
            bundle.receipt_sha256,
        );
        let restore_plan =
            PortcoveService::plan_library_recovery_restore(&destination, &restored).unwrap();
        let cancelled = PortcoveService::restore_library_recovery_bundle_with_progress(
            &destination,
            &restored,
            &restore_plan.plan_sha256,
            |progress| match progress {
                LibraryRecoveryProgress::Copying {
                    copied_bytes: 1.., ..
                } => Err(PortcoveError::new(
                    crate::ErrorCode::Cancelled,
                    "restore copy cancelled",
                )),
                _ => Ok(()),
            },
        )
        .unwrap_err();
        assert_eq!(cancelled.code, crate::ErrorCode::Cancelled);
        assert!(Library::open(&restored).is_err());
        let outcome = PortcoveService::resume_library_recovery_restore(
            &restored,
            Some(&cancelled.details["transfer_id"]),
        )
        .unwrap();
        assert!(outcome.completed);
        assert!(outcome.input_retained);
        assert_eq!(
            fs::read(restored.join("user/progress.bin")).unwrap(),
            b"saved progress"
        );
        assert!(source.join("user/progress.bin").is_file());
    }

    #[test]
    fn resumes_creation_and_restores_separately_without_redirecting_the_source() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (source_id, plan) = plan_fixture(&source, &destination);
        let interrupted = start_creation(
            &source,
            &destination,
            &plan.plan_sha256,
            &mut |_| Ok(()),
            &|| {
                Err(PortcoveError::state(
                    "fixture interruption after managed copy",
                ))
            },
        )
        .unwrap_err();
        let stage = Path::new(&interrupted.details["recovery_staging"]);
        assert!(!destination.exists());
        assert!(
            PortcoveService::inspect_library_recovery_bundle(&stage.join(PAYLOAD_DIR)).is_err()
        );
        let orphan = stage.join(WORK_DIR).join(".interrupted-private-copy");
        fs::write(&orphan, b"retained partial data").unwrap();
        let bundle = PortcoveService::resume_library_recovery_bundle(stage).unwrap();
        assert_eq!(bundle.source_library_id, source_id);
        assert!(orphan.is_file());
        assert_eq!(
            PortcoveService::resume_library_recovery_bundle(stage)
                .unwrap()
                .receipt_sha256,
            bundle.receipt_sha256
        );

        let restore = workspace.path().join("restored-library");
        assert!(
            PortcoveService::plan_library_recovery_restore(
                &destination,
                &destination.join("overlap")
            )
            .is_err()
        );
        assert!(
            PortcoveService::plan_library_recovery_restore(&destination, &source.join("overlap"))
                .is_err()
        );
        let review =
            PortcoveService::plan_library_recovery_restore(&destination, &restore).unwrap();
        assert!(!restore.exists());
        let restored = PortcoveService::restore_library_recovery_bundle(
            &destination,
            &restore,
            &review.plan_sha256,
        )
        .unwrap();
        assert!(restored.completed);
        assert_eq!(
            fs::read(restored.destination_root.join("user/progress.bin")).unwrap(),
            b"saved progress"
        );
        assert_eq!(
            Library::open(&source).unwrap().identity().unwrap(),
            source_id
        );
        assert!(
            crate::library_authority::authority(&source)
                .unwrap()
                .is_none()
        );

        fs::write(destination.join("content/user/progress.bin"), b"corrupted").unwrap();
        assert!(PortcoveService::inspect_library_recovery_bundle(&destination).is_err());
        assert!(PortcoveService::plan_library_recovery_restore(&destination, &restore).is_err());
    }

    #[test]
    fn source_change_or_late_credential_never_publishes_a_receipt() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (_, plan) = plan_fixture(&source, &destination);
        let credential = source.join("user/retroachievements.credentials");
        let cause = start_creation(
            &source,
            &destination,
            &plan.plan_sha256,
            &mut |_| Ok(()),
            &|| {
                fs::write(&credential, b"synthetic fixture")?;
                Ok(())
            },
        )
        .unwrap_err();
        let stage = Path::new(&cause.details["recovery_staging"]);
        assert!(!destination.exists());
        assert!(credential.is_file());
        assert!(PortcoveService::resume_library_recovery_bundle(stage).is_err());
        fs::remove_file(credential).unwrap();
        fs::write(source.join("user/progress.bin"), b"new progress").unwrap();
        assert!(PortcoveService::resume_library_recovery_bundle(stage).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn a_review_cannot_initialize_or_migrate_a_replaced_source() {
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (_, plan) = plan_fixture(&source, &destination);
        crate::database::recreate_schema_33_fixture(&source).unwrap();
        assert!(crate::database::requires_migration(&source).unwrap());
        assert!(
            PortcoveService::create_library_recovery_bundle(
                &source,
                &destination,
                &plan.plan_sha256
            )
            .is_err()
        );
        assert!(crate::database::requires_migration(&source).unwrap());
        assert!(!destination.exists());
    }

    #[cfg(unix)]
    #[test]
    fn verifies_private_staging_before_resuming() {
        use std::os::unix::fs::PermissionsExt;
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (_, plan) = plan_fixture(&source, &destination);
        let interrupted = start_creation(
            &source,
            &destination,
            &plan.plan_sha256,
            &mut |_| Ok(()),
            &|| Err(PortcoveError::state("fixture interruption")),
        )
        .unwrap_err();
        let stage = Path::new(&interrupted.details["recovery_staging"]);
        assert_eq!(fs::metadata(stage).unwrap().permissions().mode() & 0o077, 0);
        fs::set_permissions(stage, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(PortcoveService::resume_library_recovery_bundle(stage).is_err());
        assert!(!destination.exists());
        fs::set_permissions(stage, fs::Permissions::from_mode(0o700)).unwrap();
        PortcoveService::resume_library_recovery_bundle(stage).unwrap();
        assert_eq!(
            fs::metadata(destination).unwrap().permissions().mode() & 0o077,
            0
        );
    }

    #[test]
    fn bundle_resume_requires_its_receipt_until_publication_and_refuses_manual_imports() {
        use crate::transfer_journal::TransferPhase;
        let workspace = tempfile::tempdir().unwrap();
        let source = workspace.path().join("library");
        let destination = workspace.path().join("bundle");
        let (_, plan) = plan_fixture(&source, &destination);
        let bundle = PortcoveService::create_library_recovery_bundle(
            &source,
            &destination,
            &plan.plan_sha256,
        )
        .unwrap();
        let restore_root = workspace.path().join("restored");
        let manual_root = workspace.path().join("manual");
        let (_, manual_plan) = prepare_restore(&bundle.path, &manual_root).unwrap();
        let interrupt = |phase| {
            if phase == TransferPhase::Copying {
                return Err(PortcoveError::state("fixture interruption before copy"));
            }
            Ok(())
        };
        crate::import_execution::start_reviewed_import(manual_plan, None, &interrupt).unwrap_err();
        assert!(PortcoveService::resume_library_recovery_restore(&manual_root, None).is_err());

        let (restore_review, restore_plan) = prepare_restore(&bundle.path, &restore_root).unwrap();
        crate::import_execution::start_reviewed_import(restore_plan, Some(&bundle), &interrupt)
            .unwrap_err();
        assert!(PortcoveService::resume_library_import(&restore_root).is_err());
        let incomplete = PortcoveService::read_library_recovery_restore(
            &restore_review.destination_root,
            &restore_review.plan_sha256,
        )
        .unwrap_err();
        assert!(incomplete.message.contains("has not finished"));
        assert!(
            PortcoveService::resume_library_recovery_restore(&restore_root, Some("other-restore"))
                .is_err()
        );
        let manifest = bundle.path.join(MANIFEST_FILE);
        let original = fs::read(&manifest).unwrap();
        fs::write(&manifest, b"tampered receipt").unwrap();
        assert!(PortcoveService::resume_library_recovery_restore(&restore_root, None).is_err());
        assert!(Library::open(&restore_root).is_err());
        fs::write(&manifest, original).unwrap();
        let restored =
            PortcoveService::resume_library_recovery_restore(&restore_root, None).unwrap();
        assert!(restored.completed);

        let published_root = workspace.path().join("published-restore");
        let (publish_review, publish_plan) =
            prepare_restore(&bundle.path, &published_root).unwrap();
        crate::import_execution::start_reviewed_import(publish_plan, Some(&bundle), &|phase| {
            if phase == TransferPhase::Published {
                return Err(PortcoveError::state(
                    "fixture interruption after publication",
                ));
            }
            Ok(())
        })
        .unwrap_err();
        fs::rename(&bundle.path, workspace.path().join("offline-bundle")).unwrap();
        let read_review = |review: &LibraryRecoveryRestorePlan| {
            PortcoveService::read_library_recovery_restore(
                &review.destination_root,
                &review.plan_sha256,
            )
            .unwrap()
        };
        let published = read_review(&publish_review);
        assert!(published.completed);
        assert!(published_root.join(".portcove-import.json").exists());
        assert_eq!(
            read_review(&restore_review).transfer_id,
            restored.transfer_id
        );
        assert!(
            PortcoveService::read_library_recovery_restore(
                &publish_review.destination_root,
                &restore_review.plan_sha256,
            )
            .is_err()
        );
        let connection = Library::open(&published_root)
            .unwrap()
            .connection()
            .unwrap();
        connection
            .execute(
                "UPDATE activity_history SET status='failed' WHERE id=?1",
                [&published.transfer_id],
            )
            .unwrap();
        assert!(
            PortcoveService::read_library_recovery_restore(
                &publish_review.destination_root,
                &publish_review.plan_sha256,
            )
            .is_err()
        );
        connection
            .execute(
                "UPDATE activity_history SET status='succeeded' WHERE id=?1",
                [&published.transfer_id],
            )
            .unwrap();
        drop(connection);
        assert!(
            PortcoveService::resume_library_recovery_restore(&published_root, None)
                .unwrap()
                .completed
        );
        assert!(
            PortcoveService::resume_library_recovery_restore(&restore_root, None)
                .unwrap()
                .completed
        );
    }
}
