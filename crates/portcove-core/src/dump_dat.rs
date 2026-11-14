//! Player-supplied Logiqx DAT files, such as No-Intro and Redump, used only to
//! name the dump a player selected. Catalog-pinned source identities remain the
//! sole admission authority: nothing here changes an assessment, registration
//! or contract result. DAT files stay where the player keeps them; Portcove
//! saves a fingerprinted reference, never a copy, and makes no network request.

use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
};

use quick_xml::{XmlVersion, events::Event};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    DigestScope, HostPreferenceStore, PortcoveError, Result, SourceComponentKind, SourceInspection,
    SourceInspectionReport, SourceIntakeInspection, mod_provider::sanitize_text,
    source_inspection::SourceDigestAlgorithm,
};

/// Saved references share the 64 KiB host preference document with other
/// settings, so their count and stored text are tightly bounded.
pub(crate) const MAX_DAT_REFERENCES: usize = 8;
/// Bytes of a saved header name or version after sanitizing.
const MAX_STORED_TEXT_BYTES: usize = 128;
/// Bytes of a saved DAT file path.
const MAX_STORED_PATH_BYTES: usize = 512;
const MAX_DAT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REPORTED_MATCHES: usize = 16;
/// Descriptor files describe how tracks are laid out. Portcove compares the
/// bytes it already checked, so these never block a complete match.
const DESCRIPTOR_EXTENSIONS: [&str; 2] = ["cue", "gdi"];
const IDENTIFICATION_LIMITATION: &str = "DAT files only name the selected original game files. They don’t change which files this game accepts.";
const UNREADABLE_FILE: &str = "Portcove couldn’t read it as a regular file of at most 64 MiB";

#[derive(Debug, Clone, Copy)]
pub(crate) struct DatLimits {
    pub entries: usize,
    pub files: usize,
    pub depth: usize,
    pub text_bytes: usize,
}

const DAT_LIMITS: DatLimits = DatLimits {
    entries: 500_000,
    files: 2_000_000,
    depth: 8,
    text_bytes: 1024,
};

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
            || self.name.len() > MAX_STORED_TEXT_BYTES
            || self
                .version
                .as_ref()
                .is_some_and(|version| version.len() > MAX_STORED_TEXT_BYTES)
            || !self.path.is_absolute()
            || self
                .path
                .to_str()
                .is_none_or(|path| path.len() > MAX_STORED_PATH_BYTES)
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
    /// Sanitized name from the DAT header, for example `Sony - PlayStation`.
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
    /// Sanitized DAT entry name, for example `Final Fantasy VII (USA) (Disc 1)`.
    pub entry_name: String,
    /// True when every required file of the entry matched.
    pub complete: bool,
    pub matched_files: Vec<DumpMatchedFile>,
    /// Required files: those with a SHA-1 or SHA-256 that aren't cue or gdi
    /// descriptors. CRC32- or MD5-only files can't be compared and don't count.
    pub entry_file_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct DumpMatchedFile {
    pub file_name: String,
    pub algorithm: SourceDigestAlgorithm,
    /// The observed byte scope that matched, for example `canonical-n64-big-endian`.
    pub scope: DigestScope,
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

/// Every message is fixed text: no XML content reaches errors or output.
fn dat_error(message: &str) -> PortcoveError {
    PortcoveError::source(format!("this DAT file can’t be used: {message}"))
}

/// Strip control and bidirectional characters and cap the length at a
/// character boundary.
fn display_text(value: &str, max_bytes: usize) -> String {
    let mut text = sanitize_text(value);
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text = text.trim_end().to_owned();
    }
    text
}

/// Parse a Logiqx XML datafile. The reader never resolves a DTD, external
/// resource or custom entity; only the five predefined entities and character
/// references are accepted, so entity expansion cannot amplify the input.
pub(crate) fn parse_dat(bytes: &[u8]) -> Result<DatDocument> {
    parse_dat_with_limits(bytes, DAT_LIMITS)
}

pub(crate) fn parse_dat_with_limits(bytes: &[u8], limits: DatLimits) -> Result<DatDocument> {
    if bytes.len() as u64 > MAX_DAT_BYTES {
        return Err(dat_error("it is larger than 64 MiB"));
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| dat_error("it is not UTF-8 XML"))?;
    let mut reader = quick_xml::Reader::from_str(text);
    // Keep text whitespace: an entity splits text into separate events, and
    // trimming each one would join words. Captured values are trimmed once.
    reader.config_mut().trim_text(false);
    let mut parser = Parser {
        limits,
        stack: Vec::new(),
        entries: Vec::new(),
        current: None,
        file_count: 0,
        root_seen: false,
    };
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut capture: Option<String> = None;
    loop {
        // Parser errors can quote document text, so only a fixed message is kept.
        let event = reader
            .read_event()
            .map_err(|_| dat_error("the XML is malformed"))?;
        match event {
            Event::Start(element) => {
                if parser.stack.len() >= limits.depth {
                    return Err(dat_error("its XML is nested too deeply"));
                }
                let tag = element_name(element.local_name().as_ref())?;
                parser.open_element(&tag, &element)?;
                if parser.stack.len() == 2
                    && parser.stack[1] == "header"
                    && matches!(tag.as_str(), "name" | "version")
                {
                    capture = Some(String::new());
                }
                parser.stack.push(tag);
            }
            Event::Empty(element) => {
                let tag = element_name(element.local_name().as_ref())?;
                parser.open_element(&tag, &element)?;
                if parser.stack.len() == 1 && is_entry(&tag) {
                    parser.push_entry()?;
                }
            }
            Event::End(_) => {
                let tag = parser
                    .stack
                    .pop()
                    .ok_or_else(|| dat_error("its XML has an unmatched closing tag"))?;
                if let Some(value) = capture.take() {
                    let value = display_text(&value, MAX_STORED_TEXT_BYTES);
                    match tag.as_str() {
                        "name" if !value.is_empty() => name = Some(value),
                        "version" if !value.is_empty() => version = Some(value),
                        _ => {}
                    }
                }
                if parser.stack.len() == 1 && is_entry(&tag) {
                    parser.push_entry()?;
                }
            }
            Event::Text(text) => {
                if let Some(value) = capture.as_mut() {
                    append_bounded(value, &text.xml10_content(), limits)?;
                }
            }
            Event::CData(data) => {
                if let Some(value) = capture.as_mut() {
                    let data: &str = data.as_ref();
                    append_bounded(value, data, limits)?;
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
                    append_bounded(value, &resolved, limits)?;
                }
            }
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) | Event::DocType(_) => {}
            Event::Eof => break,
        }
    }
    if !parser.stack.is_empty() || !parser.root_seen {
        return Err(dat_error("it isn’t a complete Logiqx datafile"));
    }
    let name = name.ok_or_else(|| dat_error("its header has no name"))?;
    Ok(DatDocument {
        name,
        version,
        entries: parser.entries,
    })
}

struct Parser {
    limits: DatLimits,
    stack: Vec<String>,
    entries: Vec<DatEntry>,
    current: Option<DatEntry>,
    file_count: usize,
    root_seen: bool,
}

impl Parser {
    fn open_element(
        &mut self,
        tag: &str,
        element: &quick_xml::events::BytesStart<'_>,
    ) -> Result<()> {
        if self.stack.is_empty() {
            if tag != "datafile" || self.root_seen {
                return Err(dat_error("it isn’t a Logiqx datafile"));
            }
            self.root_seen = true;
            return Ok(());
        }
        if self.stack.len() == 1 && is_entry(tag) {
            self.current = Some(DatEntry {
                name: required_name(element, self.limits)?,
                files: Vec::new(),
            });
            return Ok(());
        }
        if self.stack.len() == 2 && tag == "rom" && is_entry(&self.stack[1]) {
            self.file_count += 1;
            if self.file_count > self.limits.files {
                return Err(dat_error("it lists too many files"));
            }
            let file = DatFile {
                name: required_name(element, self.limits)?,
                size: optional_attribute(element, "size", self.limits)?
                    .map(|size| {
                        size.parse::<u64>()
                            .map_err(|_| dat_error("a file has an invalid size"))
                    })
                    .transpose()?,
                sha1: digest_attribute(element, "sha1", 40, self.limits)?,
                sha256: digest_attribute(element, "sha256", 64, self.limits)?,
            };
            if let Some(entry) = self.current.as_mut() {
                entry.files.push(file);
            }
        }
        Ok(())
    }

    fn push_entry(&mut self) -> Result<()> {
        if let Some(entry) = self.current.take() {
            if self.entries.len() >= self.limits.entries {
                return Err(dat_error("it lists too many entries"));
            }
            self.entries.push(entry);
        }
        Ok(())
    }
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

fn optional_attribute(
    element: &quick_xml::events::BytesStart<'_>,
    key: &str,
    limits: DatLimits,
) -> Result<Option<String>> {
    let attribute = element
        .try_get_attribute(key)
        .map_err(|_| dat_error("an attribute is malformed"))?;
    let Some(attribute) = attribute else {
        return Ok(None);
    };
    let value = attribute
        .normalized_value(XmlVersion::Implicit1_0)
        .map_err(|_| dat_error("an attribute uses an XML entity Portcove doesn’t expand"))?;
    if value.len() > limits.text_bytes {
        return Err(dat_error("an attribute is too long"));
    }
    Ok(Some(value.trim().to_owned()).filter(|value| !value.is_empty()))
}

/// Entry and file names are shown to players, so they are sanitized here.
fn required_name(element: &quick_xml::events::BytesStart<'_>, limits: DatLimits) -> Result<String> {
    optional_attribute(element, "name", limits)?
        .map(|name| display_text(&name, limits.text_bytes))
        .filter(|name| !name.is_empty())
        .ok_or_else(|| dat_error("an entry or file has no name"))
}

fn digest_attribute(
    element: &quick_xml::events::BytesStart<'_>,
    key: &str,
    length: usize,
    limits: DatLimits,
) -> Result<Option<String>> {
    let Some(value) = optional_attribute(element, key, limits)? else {
        return Ok(None);
    };
    if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(dat_error(if length == 40 {
            "a file has an invalid sha1 value"
        } else {
            "a file has an invalid sha256 value"
        }));
    }
    Ok(Some(value.to_ascii_lowercase()))
}

fn append_bounded(value: &mut String, addition: &str, limits: DatLimits) -> Result<()> {
    if value.len() + addition.len() > limits.text_bytes {
        return Err(dat_error("its header text is too long"));
    }
    value.push_str(addition);
    Ok(())
}

fn reference_id(path: &Path) -> String {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    hex::encode(digest)[..16].to_owned()
}

/// Bounded regular-file read and fingerprint. Links and folders are refused.
fn read_fingerprinted(path: &Path) -> Result<(String, Vec<u8>)> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(dat_error("choose a DAT file, not a folder or link"));
    }
    if metadata.len() > MAX_DAT_BYTES {
        return Err(dat_error("it is larger than 64 MiB"));
    }
    let bytes = crate::path::read_bounded_regular(path, MAX_DAT_BYTES)
        .map_err(|_| dat_error(UNREADABLE_FILE))?;
    Ok((hex::encode(Sha256::digest(&bytes)), bytes))
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
    if path.as_os_str().len() > MAX_STORED_PATH_BYTES {
        return Err(PortcoveError::usage(format!(
            "DAT file paths can be at most {MAX_STORED_PATH_BYTES} bytes long"
        )));
    }
    let (sha256, bytes) = read_fingerprinted(&path)?;
    let document = parse_dat(&bytes)?;
    let saved = SavedDatReference {
        id: reference_id(&path),
        path,
        sha256,
        size: bytes.len() as u64,
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
        return Err(PortcoveError::not_found(
            "no DAT file is saved with this ID; run `portcove dat list`",
        ));
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
        .map(|saved| match check(saved) {
            Ok((state, _)) => status(saved, state, None),
            Err(error) => status(saved, DatReferenceState::Unreadable, Some(error.message)),
        })
        .collect())
}

/// Compare the current file with the saved fingerprint before anything else.
/// Ready returns the unchanged bytes so they can be parsed.
fn check(saved: &SavedDatReference) -> Result<(DatReferenceState, Option<Vec<u8>>)> {
    let metadata = match std::fs::symlink_metadata(&saved.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((DatReferenceState::Missing, None));
        }
        Err(_) => return Err(dat_error(UNREADABLE_FILE)),
        Ok(metadata) => metadata,
    };
    if metadata.is_file() && metadata.len() != saved.size {
        return Ok((DatReferenceState::Changed, None));
    }
    let (sha256, bytes) = read_fingerprinted(&saved.path)?;
    Ok(if sha256 == saved.sha256 {
        (DatReferenceState::Ready, Some(bytes))
    } else {
        (DatReferenceState::Changed, None)
    })
}

fn status(
    saved: &SavedDatReference,
    state: DatReferenceState,
    problem: Option<String>,
) -> DatReferenceStatus {
    let message = match state {
        DatReferenceState::Ready => "Ready to name selected original game files.".to_owned(),
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
/// no inspected bytes, or unreadable host preferences, the report is
/// unchanged: identification never fails or decorates an inspection on its own.
pub fn identify_source_report(
    preferences: &HostPreferenceStore,
    report: &mut SourceInspectionReport,
) {
    let Some(inspection) = report.inspection.as_ref() else {
        return;
    };
    let Ok(references) = preferences.dat_references() else {
        return;
    };
    if references.is_empty() {
        return;
    }
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
        let document = match check(saved) {
            Ok((DatReferenceState::Ready, Some(bytes))) => match parse_dat(&bytes) {
                Ok(document) => document,
                Err(error) => {
                    unavailable.push(status(
                        saved,
                        DatReferenceState::Unreadable,
                        Some(error.message),
                    ));
                    continue;
                }
            },
            Ok((state, _)) => {
                unavailable.push(status(saved, state, None));
                continue;
            }
            Err(error) => {
                unavailable.push(status(
                    saved,
                    DatReferenceState::Unreadable,
                    Some(error.message),
                ));
                continue;
            }
        };
        checked += 1;
        matches.extend(match_document(saved, &document, &observed));
    }
    if checked == 0 {
        return DumpIdentification {
            state_code: "references_unavailable".into(),
            summary: "Portcove couldn’t read your DAT files, so it didn’t name these files.".into(),
            limitation: IDENTIFICATION_LIMITATION.into(),
            checked_reference_count: 0,
            match_count: 0,
            matches: Vec::new(),
            unavailable_references: unavailable,
        };
    }
    matches.sort_by(|left, right| right.complete.cmp(&left.complete));
    let match_count = matches.len() as u32;
    matches.truncate(MAX_REPORTED_MATCHES);
    let (state_code, summary) = match matches.first() {
        Some(best) => {
            let also = match match_count - 1 {
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
                let data_track_only = best.matched_files.iter().all(|file| {
                    file.component_id.as_deref().is_some_and(|id| {
                        inspection.components.iter().any(|component| {
                            component.id == id && component.kind == SourceComponentKind::OpticalDisc
                        })
                    })
                });
                let scope = if data_track_only {
                    " Only the disc’s data track was checked."
                } else {
                    ""
                };
                (
                    "partially_identified",
                    format!(
                        "{} of {} files in “{}” from {} match the selected files.{scope}{also}",
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

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct ObservedKey {
    algorithm: u8,
    value: String,
}

#[derive(Debug, Clone)]
struct ObservedFact {
    algorithm: SourceDigestAlgorithm,
    scope: DigestScope,
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
                scope: digest.scope,
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

/// A required file has a comparable digest and is not a layout descriptor.
fn is_required(file: &DatFile) -> bool {
    !is_descriptor(&file.name) && (file.sha1.is_some() || file.sha256.is_some())
}

/// A match needs equal size as well as an equal SHA-1 or SHA-256. A DAT file
/// that omits a size can't be matched.
fn match_document(
    saved: &SavedDatReference,
    document: &DatDocument,
    observed: &HashMap<ObservedKey, Vec<ObservedFact>>,
) -> Vec<DumpMatch> {
    let lookup = |algorithm: u8, value: &Option<String>, size: u64| {
        value.as_ref().and_then(|value| {
            observed
                .get(&ObservedKey {
                    algorithm,
                    value: value.clone(),
                })
                .and_then(|facts| facts.iter().find(|fact| fact.size == size))
        })
    };
    let mut matches = Vec::new();
    for entry in &document.entries {
        let mut matched: BTreeMap<usize, DumpMatchedFile> = BTreeMap::new();
        let mut required = 0_u32;
        for (index, file) in entry.files.iter().enumerate() {
            if !is_required(file) {
                continue;
            }
            required += 1;
            let Some(size) = file.size else {
                continue;
            };
            let fact = lookup(1, &file.sha1, size).or_else(|| lookup(2, &file.sha256, size));
            if let Some(fact) = fact {
                matched.insert(
                    index,
                    DumpMatchedFile {
                        file_name: file.name.clone(),
                        algorithm: fact.algorithm,
                        scope: fact.scope,
                        component_id: fact.component_id.clone(),
                    },
                );
            }
        }
        if matched.is_empty() {
            continue;
        }
        matches.push(DumpMatch {
            reference_id: saved.id.clone(),
            reference_name: saved.name.clone(),
            entry_name: entry.name.clone(),
            complete: matched.len() as u32 == required,
            matched_files: matched.into_values().collect(),
            entry_file_count: required,
        });
    }
    matches
}

#[cfg(test)]
#[path = "dump_dat_tests.rs"]
mod tests;
