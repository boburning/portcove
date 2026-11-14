//! Player-supplied Logiqx DAT files, such as No-Intro and Redump, used only to
//! name the dump a player selected. Catalog-pinned source identities remain the
//! sole admission authority: nothing here changes an assessment, registration
//! or contract result. DAT files stay where the player keeps them; Portcove
//! saves a fingerprinted reference, never a copy, and makes no network request.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
};

use quick_xml::{XmlVersion, events::Event};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    DigestScope, HostPreferenceStore, PortcoveError, Result, SourceInspection,
    SourceInspectionReport, SourceIntakeInspection, source_inspection::SourceDigestAlgorithm,
};

pub(crate) const MAX_DAT_REFERENCES: usize = 16;
const MAX_DAT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DAT_ENTRIES: usize = 500_000;
const MAX_DAT_FILES: usize = 2_000_000;
const MAX_XML_DEPTH: usize = 8;
const MAX_TEXT_BYTES: usize = 1024;
const MAX_REPORTED_MATCHES: usize = 16;
/// Descriptor files describe how tracks are laid out. Portcove compares the
/// bytes it already checked, so these never block a complete match.
const DESCRIPTOR_EXTENSIONS: [&str; 2] = ["cue", "gdi"];
const IDENTIFICATION_LIMITATION: &str =
    "DAT files only name the selected files. They don’t change which files this game accepts.";

/// Saved reference to a player-supplied DAT file. The SHA-256 fingerprint makes a
/// changed file visible instead of silently using different contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SavedDatReference {
    pub id: String,
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub entry_count: u64,
    pub file_count: u64,
}

impl SavedDatReference {
    pub(crate) fn validate(&self) -> Result<()> {
        let hex = |value: &str, length: usize| {
            value.len() == length
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        };
        if !hex(&self.id, 16)
            || !hex(&self.sha256, 64)
            || self.name.is_empty()
            || self.name.len() > MAX_TEXT_BYTES
            || self
                .version
                .as_ref()
                .is_some_and(|version| version.len() > MAX_TEXT_BYTES)
            || !self.path.is_absolute()
            || self.path.to_str().is_none()
        {
            return Err(PortcoveError::state("saved DAT file reference is invalid"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatReferenceState {
    /// The file at the saved location still has the saved fingerprint.
    Ready,
    Missing,
    /// The file changed after it was added; it is not used until added again.
    Changed,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DatReferenceStatus {
    pub id: String,
    pub path: PathBuf,
    /// Name from the DAT header, for example `Sony - PlayStation`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub entry_count: u64,
    pub file_count: u64,
    pub state: DatReferenceState,
    pub message: String,
}

/// Informational naming of selected bytes against the player's DAT files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DumpIdentification {
    /// Open code: `identified`, `partially_identified`, `not_listed`,
    /// `not_checked` or `references_unavailable`.
    pub state_code: String,
    pub summary: String,
    /// Fixed statement of the admission boundary shown with every result.
    pub limitation: String,
    pub checked_reference_count: u32,
    /// Total matching entries; `matches` holds at most the first sixteen.
    pub match_count: u32,
    #[serde(default)]
    pub matches: Vec<DumpMatch>,
    #[serde(default)]
    pub unavailable_references: Vec<DatReferenceStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DumpMatch {
    pub reference_id: String,
    pub reference_name: String,
    /// The DAT entry name, for example `Final Fantasy VII (USA) (Disc 1)`.
    pub entry_name: String,
    /// True when every listed file other than a cue or gdi descriptor matched.
    pub complete: bool,
    pub matched_files: Vec<DumpMatchedFile>,
    /// Files in the entry other than cue or gdi descriptors.
    pub entry_file_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DumpMatchedFile {
    pub file_name: String,
    pub algorithm: SourceDigestAlgorithm,
    /// The observed component (for example `disc-1`) when the match was not the
    /// whole selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DatDocument {
    pub name: String,
    pub version: Option<String>,
    pub entries: Vec<DatEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DatEntry {
    pub name: String,
    pub files: Vec<DatFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DatFile {
    pub name: String,
    pub size: Option<u64>,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
}

impl DatDocument {
    fn file_count(&self) -> u64 {
        self.entries
            .iter()
            .map(|entry| entry.files.len() as u64)
            .sum()
    }
}

fn dat_error(message: impl Into<String>) -> PortcoveError {
    PortcoveError::source(format!("this DAT file can’t be used: {}", message.into()))
}

/// Parse a Logiqx XML datafile. The reader never resolves a DTD, external
/// resource or custom entity; only the five predefined entities and character
/// references are accepted, so entity expansion cannot amplify the input.
pub(crate) fn parse_dat(bytes: &[u8]) -> Result<DatDocument> {
    if bytes.len() as u64 > MAX_DAT_BYTES {
        return Err(dat_error("it is larger than 64 MiB"));
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| dat_error("it is not UTF-8 XML"))?;
    let mut reader = quick_xml::Reader::from_str(text);
    // Keep text whitespace: an entity splits text into separate events, and
    // trimming each one would join words. Captured values are trimmed once.
    reader.config_mut().trim_text(false);
    let mut stack: Vec<String> = Vec::new();
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut entries: Vec<DatEntry> = Vec::new();
    let mut current: Option<DatEntry> = None;
    let mut file_count = 0_usize;
    let mut capture: Option<String> = None;
    let mut root_seen = false;
    loop {
        let event = reader
            .read_event()
            .map_err(|error| dat_error(format!("the XML is malformed ({error})")))?;
        match event {
            Event::Start(element) => {
                if stack.len() >= MAX_XML_DEPTH {
                    return Err(dat_error("its XML is nested too deeply"));
                }
                let tag = element_name(element.local_name().as_ref())?;
                open_element(
                    &tag,
                    &element,
                    &stack,
                    &mut root_seen,
                    &mut current,
                    &mut file_count,
                )?;
                if stack.len() == 2
                    && stack[1] == "header"
                    && matches!(tag.as_str(), "name" | "version")
                {
                    capture = Some(String::new());
                }
                stack.push(tag);
            }
            Event::Empty(element) => {
                let tag = element_name(element.local_name().as_ref())?;
                open_element(
                    &tag,
                    &element,
                    &stack,
                    &mut root_seen,
                    &mut current,
                    &mut file_count,
                )?;
                if stack.len() == 1 && is_entry(&tag) {
                    push_entry(&mut entries, current.take())?;
                }
            }
            Event::End(_) => {
                let tag = stack
                    .pop()
                    .ok_or_else(|| dat_error("its XML has an unmatched closing tag"))?;
                if let Some(value) = capture.take() {
                    let value = value.trim().to_owned();
                    match tag.as_str() {
                        "name" if !value.is_empty() => name = Some(value),
                        "version" if !value.is_empty() => version = Some(value),
                        _ => {}
                    }
                }
                if stack.len() == 1 && is_entry(&tag) {
                    push_entry(&mut entries, current.take())?;
                }
            }
            Event::Text(text) => {
                if let Some(value) = capture.as_mut() {
                    append_bounded(value, &text.xml10_content())?;
                }
            }
            Event::CData(data) => {
                if let Some(value) = capture.as_mut() {
                    let data: &str = data.as_ref();
                    append_bounded(value, data)?;
                }
            }
            Event::GeneralRef(reference) => {
                let resolved = if let Some(character) = reference
                    .resolve_char_ref()
                    .map_err(|_| dat_error("it has an invalid character reference"))?
                {
                    character.to_string()
                } else {
                    quick_xml::escape::resolve_predefined_entity(&reference)
                        .ok_or_else(|| dat_error("it uses an XML entity Portcove doesn’t expand"))?
                        .to_owned()
                };
                if let Some(value) = capture.as_mut() {
                    append_bounded(value, &resolved)?;
                }
            }
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) | Event::DocType(_) => {}
            Event::Eof => break,
        }
    }
    if !stack.is_empty() || !root_seen {
        return Err(dat_error("it isn’t a complete Logiqx datafile"));
    }
    let name = name.ok_or_else(|| dat_error("its header has no name"))?;
    Ok(DatDocument {
        name,
        version,
        entries,
    })
}

fn element_name(name: &str) -> Result<String> {
    if name.len() > 64 {
        return Err(dat_error("it has an unexpectedly long element name"));
    }
    Ok(name.to_owned())
}

fn is_entry(tag: &str) -> bool {
    matches!(tag, "game" | "machine")
}

fn open_element(
    tag: &str,
    element: &quick_xml::events::BytesStart<'_>,
    stack: &[String],
    root_seen: &mut bool,
    current: &mut Option<DatEntry>,
    file_count: &mut usize,
) -> Result<()> {
    if stack.is_empty() {
        if tag != "datafile" || *root_seen {
            return Err(dat_error("it isn’t a Logiqx datafile"));
        }
        *root_seen = true;
        return Ok(());
    }
    if stack.len() == 1 && is_entry(tag) {
        *current = Some(DatEntry {
            name: required_attribute(element, "name")?,
            files: Vec::new(),
        });
        return Ok(());
    }
    if stack.len() == 2 && tag == "rom" && is_entry(&stack[1]) {
        *file_count += 1;
        if *file_count > MAX_DAT_FILES {
            return Err(dat_error("it lists too many files"));
        }
        let file = DatFile {
            name: required_attribute(element, "name")?,
            size: optional_attribute(element, "size")?
                .map(|size| {
                    size.parse::<u64>()
                        .map_err(|_| dat_error("a file has an invalid size"))
                })
                .transpose()?,
            sha1: digest_attribute(element, "sha1", 40)?,
            sha256: digest_attribute(element, "sha256", 64)?,
        };
        if let Some(entry) = current.as_mut() {
            entry.files.push(file);
        }
    }
    Ok(())
}

fn push_entry(entries: &mut Vec<DatEntry>, entry: Option<DatEntry>) -> Result<()> {
    if let Some(entry) = entry {
        if entries.len() >= MAX_DAT_ENTRIES {
            return Err(dat_error("it lists too many entries"));
        }
        entries.push(entry);
    }
    Ok(())
}

fn optional_attribute(
    element: &quick_xml::events::BytesStart<'_>,
    key: &str,
) -> Result<Option<String>> {
    let attribute = element
        .try_get_attribute(key)
        .map_err(|error| dat_error(format!("an attribute is malformed ({error})")))?;
    let Some(attribute) = attribute else {
        return Ok(None);
    };
    let value = attribute
        .normalized_value(XmlVersion::Implicit1_0)
        .map_err(|_| dat_error("an attribute uses an XML entity Portcove doesn’t expand"))?;
    if value.len() > MAX_TEXT_BYTES {
        return Err(dat_error("an attribute is too long"));
    }
    Ok(Some(value.trim().to_owned()).filter(|value| !value.is_empty()))
}

fn required_attribute(element: &quick_xml::events::BytesStart<'_>, key: &str) -> Result<String> {
    optional_attribute(element, key)?.ok_or_else(|| dat_error(format!("an entry has no {key}")))
}

fn digest_attribute(
    element: &quick_xml::events::BytesStart<'_>,
    key: &str,
    length: usize,
) -> Result<Option<String>> {
    let Some(value) = optional_attribute(element, key)? else {
        return Ok(None);
    };
    if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(dat_error(format!("a file has an invalid {key} value")));
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn append_bounded(value: &mut String, addition: &str) -> Result<()> {
    if value.len() + addition.len() > MAX_TEXT_BYTES {
        return Err(dat_error("its header text is too long"));
    }
    value.push_str(addition);
    Ok(())
}

fn reference_id(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    hex::encode(digest)[..16].to_owned()
}

/// Read a DAT file once: bounded regular-file read, fingerprint, then parse.
fn read_dat(path: &Path) -> Result<(String, u64, DatDocument)> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(dat_error("choose a DAT file, not a folder or link"));
    }
    if metadata.len() > MAX_DAT_BYTES {
        return Err(dat_error("it is larger than 64 MiB"));
    }
    let bytes = crate::path::read_bounded_regular(path, MAX_DAT_BYTES)
        .map_err(|_| dat_error("Portcove couldn’t read it as a regular file of at most 64 MiB"))?;
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let document = parse_dat(&bytes)?;
    Ok((sha256, bytes.len() as u64, document))
}

/// Validate and save a reference to a DAT file. The file is parsed before
/// anything is persisted; a malformed or oversized file leaves preferences
/// unchanged. Adding the same location or the same contents again replaces
/// the earlier reference.
pub fn add_dat_reference(
    preferences: &HostPreferenceStore,
    path: &Path,
) -> Result<DatReferenceStatus> {
    crate::path::unicode(path, "DAT file")?;
    let path = std::path::absolute(path)?;
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(PortcoveError::usage(
            "DAT file paths must not contain parent traversal",
        ));
    }
    let (sha256, size, document) = read_dat(&path)?;
    let saved = SavedDatReference {
        id: reference_id(&path),
        path,
        sha256,
        size,
        name: document.name.clone(),
        version: document.version.clone(),
        entry_count: document.entries.len() as u64,
        file_count: document.file_count(),
    };
    saved.validate()?;
    preferences.save_dat_reference(saved.clone())?;
    Ok(status(&saved, DatReferenceState::Ready, None))
}

pub fn remove_dat_reference(preferences: &HostPreferenceStore, id: &str) -> Result<()> {
    if !preferences.remove_dat_reference(id)? {
        return Err(PortcoveError::not_found(format!(
            "no DAT file is saved with ID {id}"
        )));
    }
    Ok(())
}

/// Report each saved reference by checking its file's current fingerprint.
/// Nothing is parsed or changed.
pub fn dat_reference_statuses(
    preferences: &HostPreferenceStore,
) -> Result<Vec<DatReferenceStatus>> {
    Ok(preferences
        .dat_references()?
        .iter()
        .map(|saved| match fingerprint(saved) {
            Ok(state) => status(saved, state, None),
            Err(error) => status(saved, DatReferenceState::Unreadable, Some(error.message)),
        })
        .collect())
}

fn fingerprint(saved: &SavedDatReference) -> Result<DatReferenceState> {
    match std::fs::symlink_metadata(&saved.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DatReferenceState::Missing);
        }
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    let bytes = crate::path::read_bounded_regular(&saved.path, MAX_DAT_BYTES)
        .map_err(|_| dat_error("Portcove couldn’t read it as a regular file of at most 64 MiB"))?;
    Ok(if hex::encode(Sha256::digest(&bytes)) == saved.sha256 {
        DatReferenceState::Ready
    } else {
        DatReferenceState::Changed
    })
}

fn status(
    saved: &SavedDatReference,
    state: DatReferenceState,
    problem: Option<String>,
) -> DatReferenceStatus {
    let message = match state {
        DatReferenceState::Ready => "Ready to name selected game files.".to_owned(),
        DatReferenceState::Missing => {
            "Portcove can’t find this DAT file at its saved location. Add it again from its new location.".to_owned()
        }
        DatReferenceState::Changed => {
            "This DAT file changed after you added it. Add it again to use the new version.".to_owned()
        }
        DatReferenceState::Unreadable => problem
            .unwrap_or_else(|| "Portcove couldn’t read this DAT file.".to_owned()),
    };
    DatReferenceStatus {
        id: saved.id.clone(),
        path: saved.path.clone(),
        name: saved.name.clone(),
        version: saved.version.clone(),
        entry_count: saved.entry_count,
        file_count: saved.file_count,
        state,
        message,
    }
}

/// Attach informational identification to a report. With no saved DAT files,
/// or no inspected bytes, the report is unchanged. A preference read failure
/// is reported in the identification rather than failing the inspection.
pub fn identify_source_report(
    preferences: &HostPreferenceStore,
    report: &mut SourceInspectionReport,
) {
    let Some(inspection) = report.inspection.as_ref() else {
        return;
    };
    let references = match preferences.dat_references() {
        Ok(references) if references.is_empty() => return,
        Ok(references) => references,
        Err(_) => {
            report.dump_identification = Some(unavailable_identification(Vec::new()));
            return;
        }
    };
    report.dump_identification = Some(identify_with_references(inspection, &references));
}

pub fn identify_source_intake(
    preferences: &HostPreferenceStore,
    intake: &mut SourceIntakeInspection,
) {
    if let Some(report) = intake.report.as_mut() {
        identify_source_report(preferences, report);
    }
}

pub(crate) fn identify_with_references(
    inspection: &SourceInspection,
    references: &[SavedDatReference],
) -> DumpIdentification {
    let observed = observed_digests(inspection);
    if observed.is_empty() {
        return DumpIdentification {
            state_code: "not_checked".into(),
            summary: "Portcove didn’t compare these files with your DAT files.".into(),
            limitation: IDENTIFICATION_LIMITATION.into(),
            checked_reference_count: 0,
            match_count: 0,
            matches: Vec::new(),
            unavailable_references: Vec::new(),
        };
    }
    let mut unavailable = Vec::new();
    let mut matches = Vec::new();
    let mut checked = 0_u32;
    for saved in references {
        let document = match std::fs::symlink_metadata(&saved.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                unavailable.push(status(saved, DatReferenceState::Missing, None));
                continue;
            }
            _ => match read_dat(&saved.path) {
                Ok((sha256, _, _)) if sha256 != saved.sha256 => {
                    unavailable.push(status(saved, DatReferenceState::Changed, None));
                    continue;
                }
                Ok((_, _, document)) => document,
                Err(error) => {
                    unavailable.push(status(
                        saved,
                        DatReferenceState::Unreadable,
                        Some(error.message),
                    ));
                    continue;
                }
            },
        };
        checked += 1;
        matches.extend(match_document(saved, &document, &observed));
    }
    if checked == 0 {
        return unavailable_identification(unavailable);
    }
    matches.sort_by(|left, right| right.complete.cmp(&left.complete));
    let match_count = matches.len() as u32;
    matches.truncate(MAX_REPORTED_MATCHES);
    let (state_code, summary) = match matches.first() {
        Some(best) => {
            let others = match_count - 1;
            let also = match others {
                0 => String::new(),
                1 => " It also matches 1 other DAT entry.".into(),
                count => format!(" It also matches {count} other DAT entries."),
            };
            if best.complete {
                (
                    "identified",
                    format!(
                        "Matches “{}” in {}.{also}",
                        best.entry_name, best.reference_name
                    ),
                )
            } else {
                (
                    "partially_identified",
                    format!(
                        "{} of {} files in “{}” from {} match the selected files.{also}",
                        best.matched_files.len(),
                        best.entry_file_count,
                        best.entry_name,
                        best.reference_name
                    ),
                )
            }
        }
        None => (
            "not_listed",
            "The selected files aren’t listed in your DAT files.".to_owned(),
        ),
    };
    DumpIdentification {
        state_code: state_code.into(),
        summary,
        limitation: IDENTIFICATION_LIMITATION.into(),
        checked_reference_count: checked,
        match_count,
        matches,
        unavailable_references: unavailable,
    }
}

fn unavailable_identification(unavailable: Vec<DatReferenceStatus>) -> DumpIdentification {
    DumpIdentification {
        state_code: "references_unavailable".into(),
        summary: "Portcove couldn’t read your DAT files, so it didn’t name these files.".into(),
        limitation: IDENTIFICATION_LIMITATION.into(),
        checked_reference_count: 0,
        match_count: 0,
        matches: Vec::new(),
        unavailable_references: unavailable,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct ObservedKey {
    algorithm: u8,
    value: String,
}

#[derive(Debug, Clone)]
struct ObservedFact {
    algorithm: SourceDigestAlgorithm,
    size: u64,
    component_id: Option<String>,
}

/// Reuse digests that inspection already computed. The original container of
/// an archive member describes the archive, not the dump, so it is excluded.
fn observed_digests(inspection: &SourceInspection) -> HashMap<ObservedKey, Vec<ObservedFact>> {
    let mut observed: HashMap<ObservedKey, Vec<ObservedFact>> = HashMap::new();
    let mut add = |digest: &crate::ObservedSourceDigest, component_id: Option<&str>| {
        let algorithm = match digest.algorithm {
            SourceDigestAlgorithm::Sha1 => 1,
            SourceDigestAlgorithm::Sha256 => 2,
            SourceDigestAlgorithm::Crc32 => return,
        };
        if digest.scope == DigestScope::OriginalContainer {
            return;
        }
        let facts = observed
            .entry(ObservedKey {
                algorithm,
                value: digest.value.to_ascii_lowercase(),
            })
            .or_default();
        if !facts
            .iter()
            .any(|fact| fact.size == digest.size && fact.component_id.as_deref() == component_id)
        {
            facts.push(ObservedFact {
                algorithm: digest.algorithm,
                size: digest.size,
                component_id: component_id.map(str::to_owned),
            });
        }
    };
    for digest in &inspection.observed_digests {
        add(digest, None);
    }
    for component in &inspection.components {
        for digest in &component.digests {
            add(digest, Some(&component.id));
        }
    }
    observed
}

fn is_descriptor(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            DESCRIPTOR_EXTENSIONS
                .iter()
                .any(|descriptor| descriptor.eq_ignore_ascii_case(extension))
        })
}

fn match_document(
    saved: &SavedDatReference,
    document: &DatDocument,
    observed: &HashMap<ObservedKey, Vec<ObservedFact>>,
) -> Vec<DumpMatch> {
    let lookup = |algorithm: u8, value: &Option<String>, size: Option<u64>| {
        value.as_ref().and_then(|value| {
            observed
                .get(&ObservedKey {
                    algorithm,
                    value: value.clone(),
                })
                .and_then(|facts| {
                    facts
                        .iter()
                        .find(|fact| size.is_none_or(|size| size == fact.size))
                })
        })
    };
    let mut matches = Vec::new();
    for entry in &document.entries {
        let mut matched: BTreeMap<usize, DumpMatchedFile> = BTreeMap::new();
        for (index, file) in entry.files.iter().enumerate() {
            if is_descriptor(&file.name) {
                continue;
            }
            let fact =
                lookup(1, &file.sha1, file.size).or_else(|| lookup(2, &file.sha256, file.size));
            if let Some(fact) = fact {
                matched.insert(
                    index,
                    DumpMatchedFile {
                        file_name: file.name.clone(),
                        algorithm: fact.algorithm,
                        component_id: fact.component_id.clone(),
                    },
                );
            }
        }
        if matched.is_empty() {
            continue;
        }
        let required: BTreeSet<usize> = entry
            .files
            .iter()
            .enumerate()
            .filter(|(_, file)| !is_descriptor(&file.name))
            .map(|(index, _)| index)
            .collect();
        let complete =
            !required.is_empty() && required.iter().all(|index| matched.contains_key(index));
        matches.push(DumpMatch {
            reference_id: saved.id.clone(),
            reference_name: saved.name.clone(),
            entry_name: entry.name.clone(),
            complete,
            matched_files: matched.into_values().collect(),
            entry_file_count: required.len() as u32,
        });
    }
    matches
}

#[cfg(test)]
#[path = "dump_dat_tests.rs"]
mod tests;
