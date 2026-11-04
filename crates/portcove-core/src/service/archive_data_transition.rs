//! Reviewed one-time canonical-layout transition using the existing lifecycle
//! journal and DB-bound installation manifest authority.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::Write;

const MAX_INSTALLS: usize = 16;
const MANIFEST_LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TransitionReview {
    pub port_id: String,
    pub active: InstallRecord,
    pub installs: Vec<InstallRecord>,
    pub preimage_sha256: String,
    pub data_sha256: String,
    pub policy_sha256: String,
    pub required_bytes: u64,
    pub canonical_existed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fence {
    before: InstallRecord,
    after: InstallRecord,
    old_receipt_sha256: String,
    new_receipt_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    schema_version: u32,
    review: TransitionReview,
    authority: crate::installed_contract::InstalledContract,
    fences: Vec<Fence>,
    stage_sha256: Option<String>,
}

fn fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn fence_name(id: &str, kind: &str) -> String {
    format!("{}-{kind}", fingerprint(id.as_bytes()))
}

fn write_owned(root: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    let path = root.join(name);
    refuse_symlink_ancestors(&path)?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(bytes)?;
            file.sync_all()?;
            crate::durability::sync_publication(root)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if crate::external_runtime::read_stable_metadata(&path, 16 * 1024 * 1024)? != bytes {
                return Err(held(
                    "transition-owned metadata already has different bytes",
                ));
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(path)
}

fn store_intent(root: &Path, intent: &Intent) -> Result<PathBuf> {
    let bytes = serde_json::to_vec(intent)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(held("transition intent exceeds its finite metadata bound"));
    }
    write_owned(
        root,
        &format!("verified-data-transition-{}.json", fingerprint(&bytes)),
        &bytes,
    )
}

fn held(message: &str) -> PortcoveError {
    PortcoveError::conflict(message)
        .with_known_cause(crate::failure::KnownFailureCause::PortableDataContractChanged)
}

fn tree_bytes(
    tree: &std::collections::BTreeMap<PathBuf, crate::runtime_data_policy::ReviewedEntry>,
) -> Result<u64> {
    tree.values().try_fold(0_u64, |total, entry| {
        let bytes = match entry {
            crate::runtime_data_policy::ReviewedEntry::File { size, .. } => *size,
            _ => 0,
        };
        total
            .checked_add(bytes)
            .ok_or_else(|| held("transition data size overflow"))
    })
}

impl PortcoveService {
    fn transition_data_image(
        &self,
        target: &PortDefinition,
        installs: &[InstallRecord],
        canonical_root: &Path,
    ) -> Result<(String, u64)> {
        let mut review = crate::runtime_data_policy::DataReview::default();
        let canonical = review.canonical(canonical_root)?;
        let mut required = tree_bytes(&canonical)?;
        let mut frames = Vec::new();
        for install in installs {
            let root = self.persistence_root(target, &install.path)?;
            let mut paths = Vec::new();
            for path in &target.persistent_paths {
                let tree = review.canonical(&root.join(path))?;
                required = required
                    .checked_add(tree_bytes(&tree)?)
                    .ok_or_else(|| held("transition data capacity overflow"))?;
                paths.push((path, tree));
            }
            frames.push((&install.id, paths));
        }
        Ok((
            crate::signed_catalog::digest(&serde_json::to_vec(&(canonical, frames))?),
            required,
        ))
    }
    /// Data-only interpretation. Launch/source/executable consumers keep using
    /// installed_port and the exact creating contract.
    pub(super) fn effective_archive_data_port(
        &self,
        install: &InstallRecord,
    ) -> Result<PortDefinition> {
        self.library
            .require_no_archive_data_transition(&install.port_id)?;
        if let Some(port) = Installer::new(self.library.clone())?.archive_data_port(install)? {
            psx_mod_data::require_admitted_receipt(install)?;
            return Ok(port);
        }
        self.installed_port(install)
    }

    pub(crate) fn archive_data_transition_review(
        &self,
        port_id: &str,
        selected: &ResolvedRelease,
    ) -> Result<Option<TransitionReview>> {
        let target = self.catalog.port(port_id)?;
        if target.archive_data_transition_v1.is_none() {
            return Ok(None);
        }
        let status = self.library.status(port_id, selected.channel)?;
        let Some(active) = status.active else {
            return Ok(None);
        };
        // This is offered with a distinct ordinary eligible update. It does not
        // create a separate "update" action for an already-active archive.
        if active.artifact.sha256 == selected.asset.sha256 {
            return Ok(None);
        }
        let old = self.installed_port(&active)?;
        if old.archive_data_compatibility_v1.is_some()
            || Installer::new(self.library.clone())?
                .archive_data_port(&active)?
                .is_some()
        {
            return Ok(None);
        }
        self.library.require_no_archive_data_transition(port_id)?;
        let mut installs = self
            .library
            .all_installs()?
            .into_iter()
            .filter(|i| i.port_id == port_id)
            .collect::<Vec<_>>();
        installs.sort_by(|a, b| a.id.cmp(&b.id));
        if installs.is_empty() || installs.len() > MAX_INSTALLS {
            return Err(held("retained copies exceed this bounded data transition"));
        }
        let installer = Installer::new(self.library.clone())?;
        let user = self.library.user_dir(port_id);
        crate::archive_data::refuse_unpartitioned_snapshot(&user)?;
        let (data_sha256, mut required) = self.transition_data_image(target, &installs, &user)?;
        let mut frames = Vec::new();
        for install in &installs {
            self.managed_install_root(port_id, &install.path)?;
            self.require_portable_runtime_unchanged(install)?;
            let creating = installer
                .retained_catalog(install)?
                .ok_or_else(|| held("transition predecessor has no retained creating authority"))?;
            crate::archive_data_transition::require_predecessor(install, &creating, target)?;
            if !psx_mod_data::initialized(install)? {
                return Err(held(
                    "a retained predecessor has no completed initial data restore; preserve it before this transition",
                ));
            }
            let receipt = crate::external_runtime::read_stable_metadata(
                &install.path.join(PSX_DATA_RECEIPT),
                4096,
            )?;
            let manifest = crate::external_runtime::read_stable_metadata(
                &install.path.join(".portcove-manifest.json"),
                MANIFEST_LIMIT,
            )?;
            required = required
                .checked_add((manifest.len() as u64).saturating_mul(4))
                .ok_or_else(|| held("transition capacity overflow"))?;
            let root = self.persistence_root(creating.port(port_id)?, &install.path)?;
            let original = target
                .runtime_source_filename
                .as_ref()
                .ok_or_else(|| held("transition original is missing"))?;
            let actual = crate::external_runtime::hash_stable_regular(
                &root.join(original),
                16 * 1024 * 1024,
                &|| Ok(()),
            )?;
            if target.runtime_source_hashes.get(original) != Some(&actual.0) {
                return Err(held(
                    "transition original differs from its retained verified identity",
                ));
            }
            frames.push(serde_json::json!({"install":install,"creating":crate::archive_data_transition::creating_fingerprint(&creating,port_id)?,"receipt":hex::encode(Sha256::digest(&receipt)),"manifest":hex::encode(Sha256::digest(&manifest))}));
        }
        required = required
            .checked_mul(2)
            .and_then(|n| n.checked_add(16 * 1024 * 1024))
            .ok_or_else(|| held("transition capacity overflow"))?;
        let policy = crate::archive_data::policy_sha256(target)?;
        let preimage = crate::signed_catalog::digest(&serde_json::to_vec(&(
            port_id,
            &active,
            &installs,
            &policy,
            &target.archive_data_transition_v1,
            &data_sha256,
            user.exists(),
            frames,
        ))?);
        Ok(Some(TransitionReview {
            port_id: port_id.into(),
            active,
            installs,
            preimage_sha256: preimage,
            data_sha256,
            policy_sha256: policy,
            required_bytes: required,
            canonical_existed: user.exists(),
        }))
    }

    pub(crate) fn apply_archive_data_transition(
        &self,
        port_id: &str,
        selected: &ResolvedRelease,
        expected: &str,
        control: &OperationCoordinator,
    ) -> Result<()> {
        let review = self
            .archive_data_transition_review(port_id, selected)?
            .ok_or_else(|| {
                held("the reviewed data transition is no longer the pending operation")
            })?;
        if review.preimage_sha256 != expected {
            return Err(held(
                "player data or retained receipts changed; review this update again",
            ));
        }
        if fs2::available_space(self.library.root())? < review.required_bytes {
            return Err(held(
                "this library has insufficient temporary space to preserve the reviewed data transition",
            ));
        }
        control.checkpoint()?;
        let id = Uuid::new_v4().to_string();
        let root = self.library.recovery_dir().join(&id);
        refuse_symlink_ancestors(&root)?;
        fs::create_dir(&root)?;
        let installer = Installer::new(self.library.clone())?;
        let mut fences = Vec::new();
        for before in &review.installs {
            control.checkpoint()?;
            let old = crate::external_runtime::read_stable_metadata(
                &before.path.join(".portcove-manifest.json"),
                MANIFEST_LIMIT,
            )?;
            let new = installer.prepare_archive_data_admission(before, &self.catalog, &id)?;
            let after = Installer::validate_archive_data_manifest_pair(before, &old, &new)?;
            let old_receipt = crate::external_runtime::read_stable_metadata(
                &before.path.join(PSX_DATA_RECEIPT),
                4096,
            )?;
            let new_receipt = psx_mod_data::admitted_receipt(&after)?;
            for (kind, bytes) in [
                ("manifest-before.json", &old),
                ("manifest-after.json", &new),
                ("receipt-before.json", &old_receipt),
                ("receipt-after.json", &new_receipt),
            ] {
                write_owned(&root, &fence_name(&before.id, kind), bytes)?;
            }
            fences.push(Fence {
                before: before.clone(),
                after,
                old_receipt_sha256: fingerprint(&old_receipt),
                new_receipt_sha256: fingerprint(&new_receipt),
            });
        }
        let intent = Intent {
            schema_version: 1,
            review,
            authority: crate::installed_contract::InstalledContract::capture(
                &self.catalog,
                port_id,
            )?,
            fences,
            stage_sha256: None,
        };
        let current_review = self
            .archive_data_transition_review(port_id, selected)?
            .ok_or_else(|| held("reviewed predecessor disappeared while preserving metadata"))?;
        if current_review.preimage_sha256 != intent.review.preimage_sha256 {
            return Err(held(
                "reviewed player data or receipts changed while preserving transition metadata",
            ));
        }
        let mut journal =
            LifecycleOperation::new(&id, LifecycleOperationKind::ArchiveDataTransition, port_id);
        journal.paths.staging = Some(root.join("staged-data"));
        journal.paths.final_path = Some(self.library.user_dir(port_id));
        journal.paths.quarantine = Some(root.join("previous-data"));
        journal.install = Some(intent.review.active.clone());
        journal.activate = intent.review.canonical_existed;
        journal.original_paths = vec![store_intent(&root, &intent)?];
        let store = OperationStore::new(self.library.clone());
        store.put(&mut journal)?;
        // This synchronous critical section drains its owned transition before
        // later update cancellation/publication. It never spawns a detached worker.
        let result = self.recover_archive_data_transition(&store, &mut journal);
        if let Err(error) = &result {
            journal.last_error = Some(error.message.clone());
            store.put(&mut journal)?;
        }
        result.map_err(|error| {
            error
                .with_mutation_state(crate::MutationState::RecoveryRequired)
                .detail("recovery_operation_id", &id)
        })
    }

    fn read_transition_intent(&self, operation: &LifecycleOperation) -> Result<(PathBuf, Intent)> {
        if operation.kind != LifecycleOperationKind::ArchiveDataTransition
            || Uuid::parse_str(&operation.id)
                .map(|id| id.to_string())
                .ok()
                .as_deref()
                != Some(operation.id.as_str())
        {
            return Err(held("data transition journal identity is invalid"));
        }
        let root = self.library.recovery_dir().join(&operation.id);
        if operation.paths.staging.as_deref() != Some(root.join("staged-data").as_path())
            || operation.paths.final_path.as_deref()
                != Some(self.library.user_dir(&operation.port_id).as_path())
            || operation.paths.quarantine.as_deref() != Some(root.join("previous-data").as_path())
            || operation.original_paths.len() != 1
            || operation.original_paths[0].parent() != Some(root.as_path())
        {
            return Err(held(
                "data transition journal escaped its owned coordinates",
            ));
        }
        refuse_symlink_ancestors(&root)?;
        let bytes = crate::external_runtime::read_stable_metadata(
            &operation.original_paths[0],
            8 * 1024 * 1024,
        )?;
        if operation.original_paths[0]
            .file_name()
            .and_then(|name| name.to_str())
            != Some(format!("verified-data-transition-{}.json", fingerprint(&bytes)).as_str())
        {
            return Err(held("data transition intent failed its content identity"));
        }
        let intent: Intent = serde_json::from_slice(&bytes)?;
        if intent.schema_version != 1
            || intent.review.port_id != operation.port_id
            || operation.activate != intent.review.canonical_existed
            || intent.fences.len() != intent.review.installs.len()
            || intent.fences.is_empty()
            || intent.fences.len() > MAX_INSTALLS
            || operation
                .install
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                != Some(serde_json::to_value(&intent.review.active)?)
        {
            return Err(held(
                "data transition intent differs from its creating scope",
            ));
        }
        if (operation.phase == LifecyclePhase::Preparing) != intent.stage_sha256.is_none()
            || intent
                .stage_sha256
                .as_ref()
                .is_some_and(|sha| !crate::archive_data_transition::digest(sha))
        {
            return Err(held(
                "data transition phase differs from its staged content identity",
            ));
        }
        let authority = intent.authority.catalog(&operation.port_id)?;
        if crate::archive_data::policy_sha256(authority.port(&operation.port_id)?)?
            != intent.review.policy_sha256
        {
            return Err(held("data transition policy identity changed"));
        }
        for (index, fence) in intent.fences.iter().enumerate() {
            if fence.before.port_id != operation.port_id
                || (index > 0 && intent.fences[index - 1].before.id >= fence.before.id)
                || serde_json::to_value(&fence.before)?
                    != serde_json::to_value(&intent.review.installs[index])?
            {
                return Err(held("data transition retained identity order changed"));
            }
            self.managed_install_root(&operation.port_id, &fence.before.path)?;
            let old = crate::external_runtime::read_stable_metadata(
                &root.join(fence_name(&fence.before.id, "manifest-before.json")),
                MANIFEST_LIMIT,
            )?;
            let new = crate::external_runtime::read_stable_metadata(
                &root.join(fence_name(&fence.before.id, "manifest-after.json")),
                MANIFEST_LIMIT,
            )?;
            if serde_json::to_value(Installer::validate_archive_data_manifest_pair(
                &fence.before,
                &old,
                &new,
            )?)? != serde_json::to_value(&fence.after)?
            {
                return Err(held(
                    "data transition admitted manifest differs from its retained intent",
                ));
            }
            let value: serde_json::Value = serde_json::from_slice(&new)?;
            if value["archive_data_admission"]["operation_id"] != operation.id
                || value["archive_data_admission"]["authority"]
                    != serde_json::to_value(&intent.authority)?
            {
                return Err(held(
                    "data admission has a foreign operation or mapping authority",
                ));
            }
            for (kind, expected) in [
                ("receipt-before.json", &fence.old_receipt_sha256),
                ("receipt-after.json", &fence.new_receipt_sha256),
            ] {
                if fingerprint(&crate::external_runtime::read_stable_metadata(
                    &root.join(fence_name(&fence.before.id, kind)),
                    4096,
                )?) != *expected
                {
                    return Err(held("data transition receipt preimage changed"));
                }
            }
        }
        Ok((root, intent))
    }

    fn current_transition_record(&self, before: &InstallRecord) -> Result<InstallRecord> {
        Library::install_by_id(&self.library.connection()?, Some(&before.id))?
            .filter(|record| record.port_id == before.port_id)
            .ok_or_else(|| held("a retained transition installation disappeared"))
    }

    fn require_transition_scope(&self, intent: &Intent) -> Result<()> {
        let mut actual = self
            .library
            .all_installs()?
            .into_iter()
            .filter(|install| install.port_id == intent.review.port_id)
            .collect::<Vec<_>>();
        actual.sort_by(|a, b| a.id.cmp(&b.id));
        if actual.len() != intent.fences.len() {
            return Err(held(
                "the complete retained installation set changed during data transition",
            ));
        }
        for (record, fence) in actual.iter().zip(&intent.fences) {
            let value = serde_json::to_value(record)?;
            if record.id != fence.before.id
                || (value != serde_json::to_value(&fence.before)?
                    && value != serde_json::to_value(&fence.after)?)
            {
                return Err(held(
                    "a retained installation changed outside the reviewed data transition",
                ));
            }
        }
        let active: Option<String> = self.library.connection()?.query_row(
            "SELECT active_install_id FROM port_settings WHERE port_id=?1",
            [&intent.review.port_id],
            |row| row.get(0),
        )?;
        if active.as_deref() != Some(intent.review.active.id.as_str()) {
            return Err(held(
                "active runtime changed during the reviewed data transition",
            ));
        }
        Ok(())
    }

    fn require_transition_originals(&self, intent: &Intent) -> Result<()> {
        self.require_transition_scope(intent)?;
        for fence in &intent.fences {
            if serde_json::to_value(self.current_transition_record(&fence.before)?)?
                != serde_json::to_value(&fence.before)?
            {
                return Err(held("a transition predecessor changed before fencing"));
            }
            let manifest = crate::external_runtime::read_stable_metadata(
                &fence.before.path.join(".portcove-manifest.json"),
                MANIFEST_LIMIT,
            )?;
            let receipt = crate::external_runtime::read_stable_metadata(
                &fence.before.path.join(PSX_DATA_RECEIPT),
                4096,
            )?;
            if fingerprint(&manifest) != fence.before.manifest_sha256
                || fingerprint(&receipt) != fence.old_receipt_sha256
            {
                return Err(held(
                    "transition predecessor metadata changed before private staging",
                ));
            }
            self.require_portable_runtime_unchanged(&fence.before)?;
        }
        Ok(())
    }

    fn publish_transition_fence(&self, root: &Path, fence: &Fence) -> Result<()> {
        let current = self.current_transition_record(&fence.before)?;
        let old_db = serde_json::to_value(&current)? == serde_json::to_value(&fence.before)?;
        let new_db = serde_json::to_value(&current)? == serde_json::to_value(&fence.after)?;
        if !old_db && !new_db {
            return Err(held(
                "transition database identity is neither its exact old nor admitted record",
            ));
        }
        let manifest = crate::external_runtime::read_stable_metadata(
            &current.path.join(".portcove-manifest.json"),
            MANIFEST_LIMIT,
        )?;
        let hash = fingerprint(&manifest);
        let old_file = hash == fence.before.manifest_sha256;
        let new_file = hash == fence.after.manifest_sha256;
        if (!old_file && !new_file) || (new_db && !new_file) {
            return Err(held(
                "transition manifest/database publication combination is unknown",
            ));
        }
        let receipt = crate::external_runtime::read_stable_metadata(
            &current.path.join(PSX_DATA_RECEIPT),
            4096,
        )?;
        let receipt_hash = fingerprint(&receipt);
        if receipt_hash != fence.old_receipt_sha256
            && !(new_db && new_file && receipt_hash == fence.new_receipt_sha256)
        {
            return Err(held("transition receipt has an unknown publication state"));
        }
        let observed = if old_file {
            &fence.before
        } else {
            &fence.after
        };
        let qualification = self.installed_mutability_qualification(observed)?;
        Installer::new(self.library.clone())?.verify_critical(observed, &qualification)?;
        if old_file {
            let bytes = crate::external_runtime::read_stable_metadata(
                &root.join(fence_name(&fence.before.id, "manifest-after.json")),
                MANIFEST_LIMIT,
            )?;
            if fingerprint(&bytes) != fence.after.manifest_sha256 {
                return Err(held("transition-owned admitted manifest changed"));
            }
            Installer::publish_archive_data_manifest(&fence.before, &bytes)?;
            self.faults
                .check(LifecycleFaultPoint::ArchiveDataManifestPublished)?;
        }
        if old_db {
            let changed=self.library.connection()?.execute("UPDATE installs SET manifest_sha256=?1 WHERE id=?2 AND port_id=?3 AND manifest_sha256=?4 AND path=?5",rusqlite::params![fence.after.manifest_sha256,fence.before.id,fence.before.port_id,fence.before.manifest_sha256,crate::path::unicode(&fence.before.path,"transition installation")?])?;
            if changed != 1 {
                return Err(held(
                    "transition database predecessor changed during publication",
                ));
            }
            self.faults
                .check(LifecycleFaultPoint::ArchiveDataManifestRecorded)?;
        }
        if receipt_hash == fence.old_receipt_sha256 {
            let bytes = crate::external_runtime::read_stable_metadata(
                &root.join(fence_name(&fence.before.id, "receipt-after.json")),
                4096,
            )?;
            if bytes != psx_mod_data::admitted_receipt(&fence.after)? {
                return Err(held(
                    "transition-owned admitted receipt differs from its manifest",
                ));
            }
            crate::durability::write_bytes_atomically_with_prefix(
                &current.path.join(PSX_DATA_RECEIPT),
                &bytes,
                true,
                Some(PSX_DATA_WRITE_PREFIX),
            )?;
            self.faults
                .check(LifecycleFaultPoint::ArchiveDataReceiptFenced)?;
        }
        Ok(())
    }

    fn require_transition_fences(&self, intent: &Intent) -> Result<()> {
        self.require_transition_scope(intent)?;
        for fence in &intent.fences {
            if serde_json::to_value(self.current_transition_record(&fence.before)?)?
                != serde_json::to_value(&fence.after)?
            {
                return Err(held("admitted transition database identity changed"));
            }
            if fingerprint(&crate::external_runtime::read_stable_metadata(
                &fence.after.path.join(".portcove-manifest.json"),
                MANIFEST_LIMIT,
            )?) != fence.after.manifest_sha256
            {
                return Err(held("admitted transition manifest changed"));
            }
            psx_mod_data::require_admitted_receipt(&fence.after)?;
        }
        Ok(())
    }

    pub(super) fn recover_archive_data_transition(
        &self,
        store: &OperationStore,
        operation: &mut LifecycleOperation,
    ) -> Result<()> {
        let (root, mut intent) = self.read_transition_intent(operation)?;
        let authority = intent.authority.catalog(&operation.port_id)?;
        let port = authority.port(&operation.port_id)?;
        let user = self.library.user_dir(&operation.port_id);
        let stage = root.join("staged-data");
        let previous = root.join("previous-data");
        if operation.phase == LifecyclePhase::Preparing {
            self.require_transition_originals(&intent)?;
            if self
                .transition_data_image(port, &intent.review.installs, &user)?
                .0
                != intent.review.data_sha256
            {
                return Err(held(
                    "reviewed transition data changed before private staging",
                ));
            }
            if stage.exists() {
                fs::remove_dir_all(&stage)?;
            }
            fs::create_dir(&stage)?;
            if user.exists() {
                copy_tree(&user, &stage)?;
            }
            // Remove only private copies of declared coordinates; map the
            // original canonical data first, then current active data. Unrelated
            // canonical content stays opaque and every original remains intact.
            for path in &port.persistent_paths {
                let copy = stage.join(path);
                if copy.exists() {
                    remove_managed_entry(&copy)?;
                }
            }
            crate::archive_data::initialize(port, &stage)?;
            for (index, source) in [
                &user,
                &self.persistence_root(port, &intent.review.active.path)?,
            ]
            .into_iter()
            .enumerate()
            {
                for entry in crate::archive_data::entries(
                    port,
                    Some(&intent.review.active.artifact.sha256),
                    source,
                    &stage,
                )? {
                    let path = source.join(&entry.relative);
                    if path.exists() {
                        if index == 0 {
                            copy_entry(&path, &entry.canonical)?;
                        } else {
                            sync_entry(&path, &entry.canonical)?;
                        }
                    } else if index != 0 && entry.canonical.exists() {
                        remove_managed_entry(&entry.canonical)?;
                    }
                }
            }
            if self
                .transition_data_image(port, &intent.review.installs, &user)?
                .0
                != intent.review.data_sha256
            {
                return Err(held("reviewed transition data changed while staging"));
            }
            intent.stage_sha256 = Some(canonical_digest(&stage)?);
            operation.original_paths = vec![store_intent(&root, &intent)?];
            operation.phase = LifecyclePhase::Prepared;
            store.put(operation)?;
            self.faults
                .check(LifecycleFaultPoint::ArchiveDataTransitionPrepared)?;
        }
        if operation.phase == LifecyclePhase::Prepared {
            self.require_transition_scope(&intent)?;
            let absent = root.join("absent-original-canonical");
            crate::persistence::require_absent_path(&root, "absent-original-canonical")?;
            let old = if previous.exists() {
                &previous
            } else if !operation.activate && !stage.exists() {
                &absent
            } else {
                &user
            };
            if self
                .transition_data_image(port, &intent.review.installs, old)?
                .0
                != intent.review.data_sha256
            {
                return Err(held(
                    "reviewed player data changed before transition publication",
                ));
            }
            let snapshot = if stage.exists() { &stage } else { &user };
            if Some(canonical_digest(snapshot)?) != intent.stage_sha256 {
                return Err(held("staged transition data changed before publication"));
            }
            for fence in &intent.fences {
                self.publish_transition_fence(&root, fence)?;
            }
            if self
                .transition_data_image(port, &intent.review.installs, old)?
                .0
                != intent.review.data_sha256
            {
                return Err(held(
                    "reviewed player data changed while fencing retained copies",
                ));
            }
            self.require_transition_fences(&intent)?;
            match (stage.exists(), user.exists(), previous.exists()) {
                (true, true, false) => {
                    crate::durability::rename_noreplace(&user, &previous)?;
                    self.faults
                        .check(LifecycleFaultPoint::ArchiveDataCanonicalQuarantined)?;
                    crate::durability::rename_noreplace(&stage, &user)?;
                }
                (true, false, true) => crate::durability::rename_noreplace(&stage, &user)?,
                (false, true, true) => {}
                (true, false, false) if !operation.activate => {
                    crate::durability::rename_noreplace(&stage, &user)?
                }
                (false, true, false) if !operation.activate => {}
                _ => {
                    return Err(held(
                        "transition publication paths are ambiguous; preserve its complete recovery evidence",
                    ));
                }
            }
            operation.phase = LifecyclePhase::PayloadPublished;
            store.put(operation)?;
            self.faults
                .check(LifecycleFaultPoint::ArchiveDataCanonicalPublished)?;
        }
        if matches!(
            operation.phase,
            LifecyclePhase::PayloadPublished
                | LifecyclePhase::MetadataCommitted
                | LifecyclePhase::CleanupPending
        ) {
            if Some(canonical_digest(&user)?) != intent.stage_sha256 {
                return Err(held(
                    "published transition data changed before terminal admission",
                ));
            }
            crate::archive_data::require_snapshot(port, &user)?;
            self.require_transition_fences(&intent)?;
            if operation.phase == LifecyclePhase::PayloadPublished {
                operation.phase = LifecyclePhase::MetadataCommitted;
                store.put(operation)?;
                self.faults
                    .check(LifecycleFaultPoint::ArchiveDataTransitionCommitted)?;
            }
            // Until cleanup has begun, preserve and revalidate the exact old
            // canonical data. A partially completed cleanup may already have
            // removed it, but never deletes a changed surviving preimage.
            if previous.exists() {
                if self
                    .transition_data_image(port, &intent.review.installs, &previous)?
                    .0
                    != intent.review.data_sha256
                {
                    return Err(held(
                        "original canonical data changed before transition cleanup; preserve both data trees",
                    ));
                }
            } else if operation.activate && operation.phase != LifecyclePhase::CleanupPending {
                return Err(held(
                    "original canonical data disappeared before transition cleanup",
                ));
            }
            operation.phase = LifecyclePhase::CleanupPending;
            store.put(operation)?;
            if previous.exists() {
                fs::remove_dir_all(&previous)?;
            }
            store.remove(&operation.id)?;
            // Terminal mapping is durable in the admitted manifests/receipts.
            // Retire authority before deleting metadata-only recovery evidence,
            // so interruption cannot leave a journal whose proof was deleted.
            if let Err(error) = fs::remove_dir_all(&root) {
                tracing::warn!(directory=%root.display(),%error,"completed data transition retained private recovery evidence");
            }
            return Ok(());
        }
        Err(held("unsupported data transition phase"))
    }
}

fn canonical_digest(root: &Path) -> Result<String> {
    Ok(crate::signed_catalog::digest(&serde_json::to_vec(
        &crate::runtime_data_policy::DataReview::default().canonical(root)?,
    )?))
}
