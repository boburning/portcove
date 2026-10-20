//! Carry an admitted member identity into a fixed runtime filename without
//! guessing another member from that filename's extension.
use crate::{
    DigestScope, PortcoveError, Result, RuntimeSourceMaterialization, SourceDigestAlgorithm,
    SourceRecord,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Read, Write},
    path::Path,
};

pub(super) struct AdmittedZipCopy<'a> {
    source: &'a SourceRecord,
    member: &'a str,
}

impl<'a> AdmittedZipCopy<'a> {
    pub(super) fn select(
        source: &'a SourceRecord,
        materialization: RuntimeSourceMaterialization,
        required_hashes: &BTreeMap<String, String>,
    ) -> Result<Option<Self>> {
        if !matches!(
            materialization,
            RuntimeSourceMaterialization::Copy | RuntimeSourceMaterialization::RegaidenGbc
        ) || !source
            .path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            return Ok(None);
        }
        let Some(facts) = &source.observed_identity else {
            return Ok(None);
        };
        let Some(member) = facts.archive_member_name.as_deref() else {
            return Ok(None);
        };
        facts.validate_for_record(source)?;
        for (scope, expected, size) in [
            (DigestScope::ArchiveMember, &source.sha256, source.size),
            (
                DigestScope::OriginalContainer,
                &source.storage_sha256,
                source.storage_size,
            ),
        ] {
            let mut digests = facts.digests.iter().filter(|digest| {
                digest.scope == scope && digest.algorithm == SourceDigestAlgorithm::Sha256
            });
            let digest = digests.next().ok_or_else(|| {
                PortcoveError::verification(
                    "archived runtime source lacks an exact admitted digest",
                )
            })?;
            if digests.next().is_some()
                || digest.size != size
                || !digest.value.eq_ignore_ascii_case(expected)
            {
                return Err(PortcoveError::verification(
                    "archived runtime source has contradictory admitted digest facts",
                ));
            }
        }
        if source.size == 0 || source.size > 512 * 1024 * 1024 {
            return Err(PortcoveError::unsupported(
                "archived runtime originals must be between 1 byte and 512 MiB",
            ));
        }
        if required_hashes.len() > 1
            || required_hashes
                .values()
                .any(|digest| !digest.eq_ignore_ascii_case(&source.sha256))
        {
            return Err(PortcoveError::verification(
                "admitted archive member does not match the fixed runtime original",
            ));
        }
        Ok(Some(Self { source, member }))
    }

    pub(super) fn member_name(&self) -> &str {
        self.member
    }

    pub(super) fn verify_container(&self, digest: &str, size: u64) -> Result<()> {
        if size != self.source.storage_size
            || !digest.eq_ignore_ascii_case(&self.source.storage_sha256)
        {
            return Err(PortcoveError::verification(
                "source ZIP changed after its original-file check",
            ));
        }
        Ok(())
    }

    pub(super) fn verify_destination(
        &self,
        destination: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        crate::path::refuse_symlink_ancestors(destination)?;
        let (digest, size) = super::hash_file_with_checkpoint(destination, checkpoint)?;
        if size != self.source.size || !digest.eq_ignore_ascii_case(&self.source.sha256) {
            return Err(PortcoveError::verification(
                "cached runtime original does not match its admitted archive member",
            ));
        }
        Ok(())
    }

    pub(super) fn materialize(
        &self,
        destination: &Path,
        checkpoint: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        checkpoint()?;
        let checked = crate::source_zip::open(
            File::open(&self.source.path)?,
            self.source.storage_size,
            4096,
            &mut |_| checkpoint(),
        )?;
        self.verify_container(&checked.storage_sha256, checked.storage_size)?;
        let mut archive = checked.archive;
        let mut names = BTreeMap::new();
        let mut selected = None;
        for index in 0..archive.len() {
            checkpoint()?;
            let entry = archive.by_index(index).map_err(|error| {
                PortcoveError::source(format!("invalid source ZIP entry: {error}"))
            })?;
            let name = entry.name().map_err(|error| {
                PortcoveError::source(format!("invalid source ZIP name: {error}"))
            })?;
            let (_, key) = crate::archive::validate_relative_path(&name, entry.is_dir())?;
            let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
            if !matches!(kind, 0 | 0o100000 | 0o040000) || (kind == 0o040000 && !entry.is_dir()) {
                return Err(PortcoveError::verification(
                    "source ZIP contains a link or unsupported file type",
                ));
            }
            if names.insert(key, entry.is_dir()).is_some() {
                return Err(PortcoveError::verification(
                    "source ZIP contains colliding member names",
                ));
            }
            if name == self.member && !entry.is_dir() {
                if entry.size() != self.source.size {
                    return Err(PortcoveError::verification(
                        "admitted source ZIP member changed size",
                    ));
                }
                selected = Some(index);
            }
        }
        let files = names
            .iter()
            .filter_map(|(name, directory)| (!directory).then_some(name.as_str()))
            .collect::<BTreeSet<_>>();
        for name in names.keys() {
            let mut parent = Path::new(name).parent();
            while let Some(path) = parent {
                if files.contains(path.to_string_lossy().replace('\\', "/").as_str()) {
                    return Err(PortcoveError::verification(
                        "source ZIP contains a file/directory collision",
                    ));
                }
                parent = path.parent();
            }
        }
        let index = selected.ok_or_else(|| {
            PortcoveError::verification("the checked source ZIP member is missing")
        })?;
        let entry = archive
            .by_index(index)
            .map_err(|error| PortcoveError::source(format!("invalid source ZIP entry: {error}")))?;
        crate::path::refuse_symlink_ancestors(destination)?;
        let parent = destination
            .parent()
            .ok_or_else(|| PortcoveError::state("runtime original has no parent"))?;
        let temporary = tempfile::Builder::new()
            .prefix(".portcove-source-")
            .tempfile_in(parent)?;
        let (mut output, temporary) = temporary.into_parts();
        let mut reader = entry.take(self.source.size + 1);
        let mut size = 0_u64;
        let mut digest = Sha256::new();
        let mut buffer = [0; 128 * 1024];
        loop {
            checkpoint()?;
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > self.source.size {
                return Err(PortcoveError::verification(
                    "source ZIP member expanded beyond its checked size",
                ));
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
        }
        if size != self.source.size
            || !hex::encode(digest.finalize()).eq_ignore_ascii_case(&self.source.sha256)
        {
            return Err(PortcoveError::verification(
                "source ZIP member changed after its original-file check",
            ));
        }
        output.sync_all()?;
        drop(output);
        checkpoint()?;
        super::replace_atomic(&temporary, destination)
    }
}

#[cfg(test)]
#[path = "admitted_zip_source_tests.rs"]
mod tests;
