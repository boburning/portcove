//! Player-reviewed, pre-filled GitHub bug reports.
//!
//! Core builds and redacts the text; nothing is sent. The host opens the link
//! only after the player has seen the full text, and the link can carry only
//! the fixed field set below, so a webview cannot open an arbitrary issue form.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Platform, redact_diagnostic_text};

/// Conservative budget for the whole link; GitHub rejects very long URLs.
pub const BUG_REPORT_URL_LIMIT: usize = 7_500;
const NEW_ISSUE_URL: &str = "https://github.com/boburning/portcove/issues/new";
const TEMPLATE: &str = "bug-report.yml";

/// Template field ids the report may pre-fill. Everything else stays blank.
const FILLABLE_FIELDS: [&str; 4] = ["version", "platform", "observed", "evidence"];

/// Host-supplied strings that identify the player or their machine.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReportRedactions {
    pub home_dir: Option<String>,
    pub user_name: Option<String>,
    pub library_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BugReportInputs {
    pub portcove_version: String,
    pub platform: Platform,
    pub port_id: Option<String>,
    pub installed_version: Option<String>,
    pub last_session_outcome: Option<String>,
    pub last_exit_code: Option<i32>,
    /// One line per fact, already summarised by the caller (no paths required).
    pub doctor_summary: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BugReportField {
    pub id: String,
    pub label: String,
    pub value: String,
}

/// The exact text that will appear in the issue form, after redaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BugReportDraft {
    pub fields: Vec<BugReportField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BugReportLink {
    /// Pre-filled form link, or `None` when the text does not fit in a link.
    pub url: Option<String>,
    /// Plain text to copy when there is no link.
    pub clipboard_text: String,
}

/// Dropdown label from the issue template for a platform.
fn platform_label(platform: Platform) -> &'static str {
    match platform {
        Platform::WindowsX86_64 => "Windows",
        Platform::LinuxX86_64 => "Linux",
        Platform::MacosX86_64 => "macOS Intel",
        Platform::MacosAarch64 => "macOS Apple Silicon",
    }
}

/// Removes secrets, then replaces the library root, home directory and user
/// name with neutral placeholders. Path matching ignores ASCII case and treats
/// `/` and `\` alike, because Windows paths appear in both forms.
pub fn redact_report_text(input: &str, redactions: &ReportRedactions) -> String {
    let mut text = redact_diagnostic_text(input);
    // Most specific first, so a library inside the home directory reads <library>.
    for (path, placeholder) in [
        (&redactions.library_root, "<library>"),
        (&redactions.home_dir, "<home>"),
    ] {
        if let Some(path) = path.as_deref().filter(|path| path.trim().len() >= 3) {
            text = replace_path(&text, path, placeholder);
        }
    }
    if let Some(name) = redactions
        .user_name
        .as_deref()
        .map(str::trim)
        .filter(|name| name.chars().count() >= 3)
    {
        text = replace_ignoring_case(&text, name, "<user>");
    }
    text
}

fn replace_path(text: &str, path: &str, placeholder: &str) -> String {
    let canonical = |value: &str| value.replace('\\', "/");
    let wanted = canonical(path.trim_end_matches(['/', '\\']));
    if wanted.is_empty() {
        return text.to_owned();
    }
    let haystack = canonical(text);
    // `canonical` keeps byte lengths equal, so offsets map back onto `text`.
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    let lower_haystack = haystack.to_ascii_lowercase();
    let lower_wanted = wanted.to_ascii_lowercase();
    while let Some(found) = lower_haystack[cursor..].find(&lower_wanted) {
        let start = cursor + found;
        let end = start + lower_wanted.len();
        output.push_str(&text[cursor..start]);
        output.push_str(placeholder);
        cursor = end;
    }
    output.push_str(&text[cursor..]);
    output
}

fn replace_ignoring_case(text: &str, needle: &str, placeholder: &str) -> String {
    let lower_text = text.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    // Non-ASCII names change length when lowercased; skip rather than misalign.
    if lower_text.len() != text.len() || lower_needle.len() != needle.len() {
        return text.replace(needle, placeholder);
    }
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(found) = lower_text[cursor..].find(&lower_needle) {
        let start = cursor + found;
        output.push_str(&text[cursor..start]);
        output.push_str(placeholder);
        cursor = start + lower_needle.len();
    }
    output.push_str(&text[cursor..]);
    output
}

/// Builds the editable draft. Every value is redacted before the player sees it.
pub fn draft_bug_report(inputs: &BugReportInputs, redactions: &ReportRedactions) -> BugReportDraft {
    let mut observed = String::new();
    if let Some(outcome) = &inputs.last_session_outcome {
        observed.push_str(&format!("The last launch ended with outcome: {outcome}"));
        if let Some(code) = inputs.last_exit_code {
            observed.push_str(&format!(" (exit code {code})"));
        }
        observed.push_str(".\n");
    }
    let mut evidence = vec![format!("Portcove: {}", inputs.portcove_version)];
    evidence.push(format!("Platform: {}", platform_label(inputs.platform)));
    if let Some(port) = &inputs.port_id {
        evidence.push(match &inputs.installed_version {
            Some(version) => format!("Game: {port}, installed version {version}"),
            None => format!("Game: {port}, no installed version"),
        });
    }
    evidence.extend(inputs.doctor_summary.iter().cloned());
    let field = |id: &str, label: &str, value: String| BugReportField {
        id: id.to_owned(),
        label: label.to_owned(),
        value: redact_report_text(&value, redactions),
    };
    BugReportDraft {
        fields: vec![
            field(
                "version",
                "Portcove version or commit",
                inputs.portcove_version.clone(),
            ),
            field(
                "platform",
                "Platform",
                platform_label(inputs.platform).to_owned(),
            ),
            field("observed", "Observed behavior", observed),
            field(
                "evidence",
                "Logs, screenshots, and diagnostic evidence",
                evidence.join("\n"),
            ),
        ],
    }
}

/// Builds the pre-filled link from the player's final text. Unknown field ids
/// are ignored, and the text is redacted again, so an edit cannot add a path.
pub fn bug_report_link(fields: &[BugReportField], redactions: &ReportRedactions) -> BugReportLink {
    let mut query = vec![format!("template={TEMPLATE}")];
    let mut clipboard = String::new();
    for wanted in FILLABLE_FIELDS {
        let Some(field) = fields.iter().find(|field| field.id == wanted) else {
            continue;
        };
        let value = redact_report_text(&field.value, redactions);
        if value.trim().is_empty() {
            continue;
        }
        query.push(format!("{wanted}={}", percent_encode(&value)));
        clipboard.push_str(&format!("## {}\n{}\n\n", field.label, value));
    }
    let url = format!("{NEW_ISSUE_URL}?{}", query.join("&"));
    BugReportLink {
        url: (url.len() <= BUG_REPORT_URL_LIMIT).then_some(url),
        clipboard_text: clipboard.trim_end().to_owned(),
    }
}

/// RFC 3986 percent-encoding of everything except unreserved characters.
fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len() * 2);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                output.push(byte as char);
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactions() -> ReportRedactions {
        ReportRedactions {
            home_dir: Some(r"C:\Users\Alice Smith".to_owned()),
            user_name: Some("Alice Smith".to_owned()),
            library_root: Some("D:/Games/Portcove Library".to_owned()),
        }
    }

    fn inputs() -> BugReportInputs {
        BugReportInputs {
            portcove_version: "0.1.0".to_owned(),
            platform: Platform::WindowsX86_64,
            port_id: Some("zelda64-recomp".to_owned()),
            installed_version: Some("1.2.3".to_owned()),
            last_session_outcome: Some("failed".to_owned()),
            last_exit_code: Some(-1_073_741_515),
            doctor_summary: vec!["Installed games: 2".to_owned()],
        }
    }

    fn value<'a>(draft: &'a BugReportDraft, id: &str) -> &'a str {
        &draft
            .fields
            .iter()
            .find(|field| field.id == id)
            .unwrap()
            .value
    }

    #[test]
    fn redaction_removes_home_library_and_user_in_either_separator_and_any_case() {
        let text = r"Saved to c:/users/alice smith/AppData\x and D:\games\portcove library\saves; owner ALICE SMITH";
        let redacted = redact_report_text(text, &redactions());
        assert_eq!(
            redacted,
            r"Saved to <home>/AppData\x and <library>\saves; owner <user>"
        );
        assert!(!redacted.to_lowercase().contains("alice"));
    }

    #[test]
    fn redaction_strips_credentials_and_ignores_too_short_identifiers() {
        let short = ReportRedactions {
            user_name: Some("ab".to_owned()),
            home_dir: Some("/".to_owned()),
            ..ReportRedactions::default()
        };
        let redacted = redact_report_text("token=abcd1234 about abc", &short);
        assert!(redacted.contains("token=[REDACTED]"));
        assert!(!redacted.contains("abcd1234"));
        assert!(redacted.contains("about abc"), "{redacted}");
    }

    #[test]
    fn draft_contains_only_the_stated_facts_and_is_redacted() {
        let mut facts = inputs();
        facts
            .doctor_summary
            .push(r"Library: D:\Games\Portcove Library".to_owned());
        let draft = draft_bug_report(&facts, &redactions());
        assert_eq!(value(&draft, "version"), "0.1.0");
        assert_eq!(value(&draft, "platform"), "Windows");
        assert!(value(&draft, "observed").contains("outcome: failed (exit code -1073741515)"));
        let evidence = value(&draft, "evidence");
        assert!(evidence.contains("Game: zelda64-recomp, installed version 1.2.3"));
        assert!(evidence.contains("Library: <library>"));
        assert!(!evidence.contains("Portcove Library"));
    }

    #[test]
    fn link_uses_the_fixed_template_encodes_text_and_ignores_unknown_fields() {
        let mut draft = draft_bug_report(&inputs(), &redactions());
        draft.fields.push(BugReportField {
            id: "acceptance".to_owned(),
            label: "Acceptance".to_owned(),
            value: "ignored".to_owned(),
        });
        let link = bug_report_link(&draft.fields, &redactions());
        let url = link.url.unwrap();
        assert!(url.starts_with(
            "https://github.com/boburning/portcove/issues/new?template=bug-report.yml&version=0.1.0&platform=Windows"
        ));
        assert!(url.contains("observed=The%20last%20launch"));
        assert!(!url.contains("acceptance"));
        assert!(!url.contains(' ') && !url.contains('\n'));
    }

    #[test]
    fn link_redacts_text_the_player_edited_in() {
        let fields = vec![BugReportField {
            id: "observed".to_owned(),
            label: "Observed behavior".to_owned(),
            value: r"crash in C:\Users\Alice Smith\game".to_owned(),
        }];
        let link = bug_report_link(&fields, &redactions());
        assert!(!link.url.unwrap().to_lowercase().contains("alice"));
        assert!(link.clipboard_text.contains("<home>"));
    }

    #[test]
    fn over_length_reports_fall_back_to_clipboard_text() {
        let fields = vec![BugReportField {
            id: "evidence".to_owned(),
            label: "Logs".to_owned(),
            value: "x".repeat(BUG_REPORT_URL_LIMIT),
        }];
        let link = bug_report_link(&fields, &ReportRedactions::default());
        assert!(link.url.is_none());
        assert!(link.clipboard_text.contains(&"x".repeat(100)));
    }

    #[test]
    fn percent_encoding_is_utf8_safe() {
        assert_eq!(percent_encode("a b&é"), "a%20b%26%C3%A9");
    }
}
