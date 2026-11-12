//! Player-reviewed, pre-filled GitHub bug reports and feedback.
//!
//! Core builds and redacts the text; nothing is sent. The host opens the link
//! only after the player has seen the full text, and the link can carry only
//! the fixed field set of its kind, so a webview cannot open an arbitrary issue
//! form.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Platform, redact_diagnostic_text};

/// Conservative budget for the whole link; GitHub rejects very long URLs.
pub const BUG_REPORT_URL_LIMIT: usize = 7_500;
/// The only repository Portcove files reports in.
pub const REPORT_REPOSITORY: &str = "boburning/portcove";
const NEW_ISSUE_URL: &str = "https://github.com/boburning/portcove/issues/new";
/// GitHub refuses issue bodies above 65,536 characters; keep a margin.
const ISSUE_BODY_LIMIT: usize = 60_000;
const TITLE_SUMMARY_LIMIT: usize = 80;

/// Feedback form dropdown options, exactly as `feedback.yml` lists them.
const JOURNEY_OPTIONS: [&str; 10] = [
    "Find a game or choose a port",
    "Set up game files",
    "Install a game",
    "Play a game",
    "Update a game",
    "Recover, back up or restore",
    "Move from another launcher",
    "Use mods",
    "Change settings",
    "Something else",
];
/// Platform dropdown options shared by both forms.
const PLATFORM_OPTIONS: [&str; 7] = [
    "Windows",
    "Linux",
    "Steam Deck",
    "macOS Intel",
    "macOS Apple Silicon",
    "Multiple platforms",
    "Not applicable",
];
const OUTCOME_OPTIONS: [&str; 4] = [
    "I couldn't finish",
    "I finished, but it was difficult",
    "I finished, but it was confusing",
    "This is an idea or request",
];

/// Which issue form a report fills.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ReportKind {
    /// Something broke or behaved incorrectly (`bug-report.yml`).
    #[default]
    Problem,
    /// Something worked but was hard, slow or confusing, or an idea (`feedback.yml`).
    Feedback,
}

impl ReportKind {
    fn template(self) -> &'static str {
        match self {
            Self::Problem => "bug-report.yml",
            Self::Feedback => "feedback.yml",
        }
    }

    /// Template field ids the report may fill, in the form's order, with the
    /// form's own label for copied text and submitted issues. Everything else
    /// stays blank.
    fn fillable_fields(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Problem => &[
                ("observed", "Observed behavior"),
                ("reproduce", "What were you doing when it happened?"),
                ("version", "Portcove version or commit"),
                ("platform", "Platform"),
                ("evidence", "Logs, screenshots, and diagnostic evidence"),
            ],
            Self::Feedback => &[
                ("journey", "What were you trying to do?"),
                ("outcome", "How far did you get?"),
                ("happened", "What happened?"),
                ("expected", "What did you expect or want instead?"),
                ("game", "Game, if it was about one"),
                ("version", "Portcove version"),
                ("platform", "Platform"),
                ("context", "Portcove details"),
            ],
        }
    }

    /// Dropdowns the player picks in Portcove, with the form's exact options.
    fn choices(self) -> Vec<ReportChoice> {
        let choice = |id: &str, label: &str, options: &[&str]| ReportChoice {
            id: id.to_owned(),
            label: label.to_owned(),
            options: options.iter().map(|option| (*option).to_owned()).collect(),
        };
        match self {
            Self::Problem => Vec::new(),
            Self::Feedback => vec![
                choice("journey", "What were you trying to do?", &JOURNEY_OPTIONS),
                choice("outcome", "How far did you get?", &OUTCOME_OPTIONS),
            ],
        }
    }

    /// The player's own account of what happened; a submitted issue needs it.
    fn story_field(self) -> &'static str {
        match self {
            Self::Problem => "observed",
            Self::Feedback => "happened",
        }
    }

    fn title_prefix(self) -> &'static str {
        match self {
            Self::Problem => "[Bug] ",
            Self::Feedback => "[Feedback] ",
        }
    }
}

/// A dropdown from the issue form. Its value travels as a field with the same id
/// and must be one of `options`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReportChoice {
    pub id: String,
    pub label: String,
    pub options: Vec<String>,
}

/// The issue Portcove files on the player's behalf when they choose Submit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ReportIssue {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
}

/// An issue GitHub created from a submitted report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SubmittedReport {
    pub number: u64,
    pub url: String,
}

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
    /// Dropdowns the player picks; empty for a bug report.
    #[serde(default)]
    pub choices: Vec<ReportChoice>,
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
/// name with neutral placeholders. Path matching ignores ASCII case, treats `/`
/// and `\` alike, also catches the `%20` form of a path, and only matches whole
/// path segments (`C:\Users\Al` never rewrites `C:\Users\Alice`). The user name
/// matches whole words only, so it cannot rewrite unrelated text.
pub fn redact_report_text(input: &str, redactions: &ReportRedactions) -> String {
    redact_user_name(&redact_paths(input, redactions), redactions)
}

/// Secrets, then the library root and home directory. Safe for fixed fields: a
/// path is never a legitimate version or platform value.
fn redact_paths(input: &str, redactions: &ReportRedactions) -> String {
    let mut text = redact_diagnostic_text(input);
    // Most specific first, so a library inside the home directory reads <library>.
    for (path, placeholder) in [
        (&redactions.library_root, "<library>"),
        (&redactions.home_dir, "<home>"),
    ] {
        let Some(path) = path.as_deref() else {
            continue;
        };
        let trimmed = path.trim().trim_end_matches(['/', '\\']);
        // A bare drive or root ("C:", "/") identifies nothing and would match everywhere.
        if trimmed.chars().count() < 3 {
            continue;
        }
        text = replace_path(&text, trimmed, placeholder);
        if trimmed.contains(' ') {
            text = replace_path(&text, &trimmed.replace(' ', "%20"), placeholder);
        }
    }
    text
}

fn redact_user_name(text: &str, redactions: &ReportRedactions) -> String {
    match redactions
        .user_name
        .as_deref()
        .map(str::trim)
        .filter(|name| name.chars().count() >= 3)
    {
        Some(name) => replace_word(text, name, "<user>"),
        None => text.to_owned(),
    }
}

fn is_word(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

/// Byte ranges of `needle` in `text` (ASCII-case-insensitive) that satisfy `accept`.
fn matches(
    text: &str,
    needle: &str,
    accept: impl Fn(Option<char>, Option<char>) -> bool,
) -> Vec<(usize, usize)> {
    let lower_text = text.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut found = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = lower_text[cursor..].find(&lower_needle) {
        let start = cursor + offset;
        let end = start + lower_needle.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        if accept(before, after) {
            found.push((start, end));
            cursor = end;
        } else {
            // Step one character so overlapping candidates are still considered.
            cursor = start + lower_text[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    found
}

fn splice(text: &str, ranges: &[(usize, usize)], placeholder: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for &(start, end) in ranges {
        output.push_str(&text[cursor..start]);
        output.push_str(placeholder);
        cursor = end;
    }
    output.push_str(&text[cursor..]);
    output
}

/// Replaces `needle` where it is not glued to a longer word on either side.
fn replace_word(text: &str, needle: &str, placeholder: &str) -> String {
    let ranges = matches(text, needle, |before, after| {
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    });
    splice(text, &ranges, placeholder)
}

/// Replaces a path where it ends on a segment boundary. `/` and `\` are alike.
fn replace_path(text: &str, path: &str, placeholder: &str) -> String {
    // The swap keeps byte lengths, so ranges found on the canonical copy apply to `text`.
    let canonical = |value: &str| value.replace('\\', "/");
    let ranges = matches(&canonical(text), &canonical(path), |_, after| {
        !after.is_some_and(|next| is_word(next) || next == '-')
    });
    splice(text, &ranges, placeholder)
}

/// Builds the editable draft of the given kind. Every value is redacted before the
/// player sees it.
pub fn draft_report(
    kind: ReportKind,
    inputs: &BugReportInputs,
    redactions: &ReportRedactions,
) -> BugReportDraft {
    match kind {
        ReportKind::Problem => draft_bug_report(inputs, redactions),
        ReportKind::Feedback => draft_feedback(inputs, redactions),
    }
}

fn field(id: &str, label: &str, value: String, redactions: &ReportRedactions) -> BugReportField {
    BugReportField {
        id: id.to_owned(),
        label: label.to_owned(),
        value: redact_for_field(id, &value, redactions),
    }
}

/// The player writes what happened; Core fills only facts it knows, and the
/// Portcove details field carries the same summary a bug report would.
fn draft_feedback(inputs: &BugReportInputs, redactions: &ReportRedactions) -> BugReportDraft {
    let mut details = Vec::new();
    if let Some(version) = &inputs.installed_version {
        details.push(format!("Installed version: {version}"));
    }
    if let Some(outcome) = &inputs.last_session_outcome {
        details.push(match inputs.last_exit_code {
            Some(code) => format!("Last launch: {outcome} (exit code {code})"),
            None => format!("Last launch: {outcome}"),
        });
    }
    details.extend(inputs.doctor_summary.iter().cloned());
    BugReportDraft {
        fields: vec![
            field(
                "version",
                "Portcove version",
                inputs.portcove_version.clone(),
                redactions,
            ),
            field(
                "platform",
                "Platform",
                platform_label(inputs.platform).to_owned(),
                redactions,
            ),
            field(
                "game",
                "Game, if it was about one",
                inputs.port_id.clone().unwrap_or_default(),
                redactions,
            ),
            field("happened", "What happened?", String::new(), redactions),
            field(
                "expected",
                "What did you expect or want instead?",
                String::new(),
                redactions,
            ),
            field(
                "context",
                "Portcove details",
                details.join("\n"),
                redactions,
            ),
        ],
        choices: ReportKind::Feedback.choices(),
    }
}

/// Builds the editable bug-report draft. Every value is redacted before the
/// player sees it.
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
        value: redact_for_field(id, &value, redactions),
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
                "reproduce",
                "What were you doing when it happened?",
                String::new(),
            ),
            field(
                "evidence",
                "Logs, screenshots, and diagnostic evidence",
                evidence.join("\n"),
            ),
        ],
        choices: Vec::new(),
    }
}

/// `version`, `platform` and the game id are fixed facts matched against the issue
/// template or catalog, so a user name that happens to be a word inside them must
/// not rewrite them. Paths and secrets are still removed from them.
fn redact_for_field(id: &str, value: &str, redactions: &ReportRedactions) -> String {
    match id {
        "version" | "platform" | "game" => redact_paths(value, redactions),
        _ => redact_report_text(value, redactions),
    }
}

/// Builds the pre-filled bug-report link from the player's final text.
pub fn bug_report_link(fields: &[BugReportField], redactions: &ReportRedactions) -> BugReportLink {
    report_link(ReportKind::Problem, fields, redactions)
}

/// Builds the pre-filled link of the given kind from the player's final text.
/// Field ids outside that kind's form are ignored, the text is redacted again,
/// so an edit cannot add a path, and the copied headings are Core's own.
pub fn report_link(
    kind: ReportKind,
    fields: &[BugReportField],
    redactions: &ReportRedactions,
) -> BugReportLink {
    let mut query = vec![format!("template={}", kind.template())];
    let mut clipboard = String::new();
    for (wanted, label, value) in reviewed_values(kind, fields, redactions) {
        if value.trim().is_empty() {
            continue;
        }
        query.push(format!("{wanted}={}", percent_encode(&value)));
        clipboard.push_str(&format!("## {label}\n{value}\n\n"));
    }
    let url = format!("{NEW_ISSUE_URL}?{}", query.join("&"));
    BugReportLink {
        url: (url.len() <= BUG_REPORT_URL_LIMIT).then_some(url),
        clipboard_text: clipboard.trim_end().to_owned(),
    }
}

/// The reviewed value of each field the kind's form accepts, in form order. Text
/// is redacted again, and a dropdown keeps only one of the form's own options.
fn reviewed_values(
    kind: ReportKind,
    fields: &[BugReportField],
    redactions: &ReportRedactions,
) -> Vec<(&'static str, &'static str, String)> {
    let choices = kind.choices();
    kind.fillable_fields()
        .iter()
        .map(|&(id, label)| {
            let raw = fields
                .iter()
                .find(|field| field.id == id)
                .map_or("", |field| field.value.as_str());
            let value = match choices.iter().find(|choice| choice.id == id) {
                Some(choice) => choice
                    .options
                    .iter()
                    .find(|option| option.as_str() == raw)
                    .cloned()
                    .unwrap_or_default(),
                // A dropdown on both forms; anything else is not a platform.
                None if id == "platform" => PLATFORM_OPTIONS
                    .iter()
                    .find(|option| **option == raw)
                    .map(|option| (*option).to_owned())
                    .unwrap_or_default(),
                None => redact_for_field(id, raw, redactions),
            };
            (id, label, value)
        })
        .collect()
}

/// Builds the issue Portcove submits for the player from their final text. Every
/// dropdown needs one of the form's options and the player's own account must
/// not be blank. The body uses the form's headings, so a submitted report reads
/// like one filed on GitHub and triage treats both the same way.
pub fn report_issue(
    kind: ReportKind,
    fields: &[BugReportField],
    redactions: &ReportRedactions,
) -> crate::Result<ReportIssue> {
    let values = reviewed_values(kind, fields, redactions);
    for choice in kind.choices() {
        if values
            .iter()
            .any(|(id, _, value)| *id == choice.id && value.is_empty())
        {
            return Err(crate::PortcoveError::usage(format!(
                "choose an answer for \"{}\" before submitting",
                choice.label
            )));
        }
    }
    let story = values
        .iter()
        .find(|(id, _, _)| *id == kind.story_field())
        .map(|(_, _, value)| value.trim())
        .unwrap_or_default();
    let Some(summary) = story.lines().map(str::trim).find(|line| !line.is_empty()) else {
        return Err(crate::PortcoveError::usage(
            "describe what happened before submitting",
        ));
    };
    let summary = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    let summary = if summary.chars().count() > TITLE_SUMMARY_LIMIT {
        let cut = summary
            .chars()
            .take(TITLE_SUMMARY_LIMIT - 1)
            .collect::<String>();
        format!("{}…", cut.trim_end())
    } else {
        summary
    };
    let mut body = String::new();
    for (_, label, value) in &values {
        let value = value.trim();
        let value = if value.is_empty() {
            "_No response_"
        } else {
            value
        };
        body.push_str(&format!("### {label}\n\n{value}\n\n"));
    }
    body.push_str("---\n_Submitted from Portcove after the player reviewed this text._\n");
    if body.chars().count() > ISSUE_BODY_LIMIT {
        return Err(crate::PortcoveError::usage(
            "this report is too long to submit; shorten it or copy it instead",
        ));
    }
    Ok(ReportIssue {
        title: format!("{}{summary}", kind.title_prefix()),
        body,
        labels: vec!["needs-triage".to_owned()],
    })
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
            "https://github.com/boburning/portcove/issues/new?template=bug-report.yml&observed=The%20last%20launch"
        ));
        assert!(url.contains("&version=0.1.0&platform=Windows&evidence="));
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
    fn paths_match_whole_segments_only() {
        let home = ReportRedactions {
            home_dir: Some(r"C:\Users\Alice".to_owned()),
            ..ReportRedactions::default()
        };
        assert_eq!(
            redact_report_text(
                r"C:\Users\Alice\x and C:\Users\Alicia\y and C:\Users\Alice.",
                &home
            ),
            r"<home>\x and C:\Users\Alicia\y and <home>."
        );
        let prefix = ReportRedactions {
            home_dir: Some("/home/bob".to_owned()),
            ..ReportRedactions::default()
        };
        assert_eq!(
            redact_report_text("/home/bobby/x /home/bob/x", &prefix),
            "/home/bobby/x <home>/x"
        );
    }

    #[test]
    fn a_bare_drive_or_root_is_never_a_redaction_target() {
        for home in [r"C:\", "C:", "/", "/h"] {
            let redactions = ReportRedactions {
                home_dir: Some(home.to_owned()),
                ..ReportRedactions::default()
            };
            assert_eq!(
                redact_report_text(r"C:\Games and /usr/bin", &redactions),
                r"C:\Games and /usr/bin"
            );
        }
    }

    #[test]
    fn user_names_match_whole_words_and_never_rewrite_fixed_fields() {
        let redactions = ReportRedactions {
            user_name: Some("win".to_owned()),
            ..ReportRedactions::default()
        };
        assert_eq!(
            redact_report_text("Windows by win and WIN's win", &redactions),
            "Windows by <user> and <user>'s <user>"
        );
        let mut facts = inputs();
        facts.platform = Platform::WindowsX86_64;
        facts.portcove_version = "0.1.0-win".to_owned();
        let draft = draft_bug_report(&facts, &redactions);
        assert_eq!(value(&draft, "platform"), "Windows");
        assert_eq!(value(&draft, "version"), "0.1.0-win");
        let link = bug_report_link(&draft.fields, &redactions).url.unwrap();
        assert!(link.contains("platform=Windows&") && link.contains("version=0.1.0-win&"));
    }

    #[test]
    fn fixed_fields_lose_paths_and_secrets_but_keep_user_name_words() {
        let redactions = ReportRedactions {
            home_dir: Some(r"C:\Users\Alice".to_owned()),
            user_name: Some("win".to_owned()),
            ..ReportRedactions::default()
        };
        let fields = vec![
            BugReportField {
                id: "version".to_owned(),
                label: "Version".to_owned(),
                value: r"C:\Users\Alice\x token=abc12345".to_owned(),
            },
            BugReportField {
                id: "platform".to_owned(),
                label: "Platform".to_owned(),
                value: "Windows".to_owned(),
            },
        ];
        let link = bug_report_link(&fields, &redactions);
        let url = link.url.unwrap();
        assert!(!url.to_lowercase().contains("alice"), "{url}");
        assert!(!url.contains("abc12345"), "{url}");
        assert!(url.contains("platform=Windows"), "{url}");
        assert!(link.clipboard_text.contains("<home>"));
    }

    #[test]
    fn feedback_drafts_leave_the_story_to_the_player_and_fill_only_known_facts() {
        let draft = draft_report(ReportKind::Feedback, &inputs(), &redactions());
        let ids = draft
            .fields
            .iter()
            .map(|field| field.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "version", "platform", "game", "happened", "expected", "context"
            ]
        );
        assert_eq!(value(&draft, "game"), "zelda64-recomp");
        assert_eq!(value(&draft, "happened"), "");
        assert_eq!(value(&draft, "expected"), "");
        let context = value(&draft, "context");
        assert!(context.contains("Installed version: 1.2.3"), "{context}");
        assert!(
            context.contains("Last launch: failed (exit code"),
            "{context}"
        );
        assert!(context.contains("Installed games: 2"), "{context}");
    }

    #[test]
    fn feedback_links_open_the_feedback_form_with_only_its_fields_redacted() {
        let mut draft = draft_report(ReportKind::Feedback, &inputs(), &redactions());
        for field in &mut draft.fields {
            if field.id == "happened" {
                field.value = r"Setup asked for C:\Users\Alice Smith\rom twice".to_owned();
            }
        }
        // A bug-report field smuggled into a feedback link is dropped.
        draft.fields.push(BugReportField {
            id: "observed".to_owned(),
            label: "Observed".to_owned(),
            value: "smuggled".to_owned(),
        });
        let link = report_link(ReportKind::Feedback, &draft.fields, &redactions());
        let url = link.url.unwrap();
        assert!(url.contains("template=feedback.yml&"), "{url}");
        assert!(url.contains("game=zelda64-recomp"), "{url}");
        assert!(!url.contains("expected="), "blank fields stay blank: {url}");
        assert!(
            !url.contains("smuggled") && !url.contains("observed="),
            "{url}"
        );
        assert!(!url.to_lowercase().contains("alice"), "{url}");
        assert!(link.clipboard_text.contains("<home>"));
        assert!(link.clipboard_text.contains("## What happened?\n"));
        assert!(!link.clipboard_text.contains("## Observed"));
        assert_eq!(
            bug_report_link(&draft.fields, &redactions()).url,
            report_link(ReportKind::Problem, &draft.fields, &redactions()).url
        );
    }

    fn set(fields: &mut Vec<BugReportField>, id: &str, value: &str) {
        match fields.iter_mut().find(|field| field.id == id) {
            Some(field) => field.value = value.to_owned(),
            None => fields.push(BugReportField {
                id: id.to_owned(),
                label: id.to_owned(),
                value: value.to_owned(),
            }),
        }
    }

    #[test]
    fn feedback_choices_match_the_form_and_prefill_only_listed_options() {
        let form = include_str!("../../../.github/ISSUE_TEMPLATE/feedback.yml");
        let draft = draft_report(ReportKind::Feedback, &inputs(), &redactions());
        assert_eq!(draft.choices.len(), 2);
        for choice in &draft.choices {
            assert!(
                form.contains(&format!("id: {}\n", choice.id)),
                "{}",
                choice.id
            );
            assert!(form.contains(&format!("label: {}\n", choice.label)));
            for option in &choice.options {
                assert!(form.contains(&format!("- {option}\n")), "{option}");
            }
        }
        let mut fields = draft.fields.clone();
        set(&mut fields, "journey", "Install a game");
        set(&mut fields, "outcome", "anything the webview likes");
        let url = report_link(ReportKind::Feedback, &fields, &redactions())
            .url
            .unwrap();
        assert!(url.contains("journey=Install%20a%20game"), "{url}");
        assert!(!url.contains("outcome="), "{url}");
        assert!(
            draft_report(ReportKind::Problem, &inputs(), &redactions())
                .choices
                .is_empty()
        );
    }

    #[test]
    fn submitted_feedback_uses_the_form_headings_and_a_redacted_title() {
        let mut fields = draft_report(ReportKind::Feedback, &inputs(), &redactions()).fields;
        set(&mut fields, "journey", "Set up game files");
        set(&mut fields, "outcome", "I couldn't finish");
        set(
            &mut fields,
            "happened",
            "\n  Setup kept asking for   C:\\Users\\Alice Smith\\rom.z64\nThen it stopped.",
        );
        set(&mut fields, "observed", "not on this form");
        let issue = report_issue(ReportKind::Feedback, &fields, &redactions()).unwrap();
        assert_eq!(
            issue.title,
            "[Feedback] Setup kept asking for <home>\\rom.z64"
        );
        assert_eq!(issue.labels, ["needs-triage"]);
        assert!(issue.body.starts_with(
            "### What were you trying to do?\n\nSet up game files\n\n### How far did you get?\n\nI couldn't finish\n\n### What happened?\n\n"
        ));
        assert!(
            issue
                .body
                .contains("### What did you expect or want instead?\n\n_No response_\n\n")
        );
        assert!(issue.body.contains("### Platform\n\nWindows\n\n"));
        assert!(
            !issue.body.to_lowercase().contains("alice"),
            "{}",
            issue.body
        );
        assert!(!issue.body.contains("not on this form"));
        set(&mut fields, "platform", "Plan 9 <script>");
        let issue = report_issue(ReportKind::Feedback, &fields, &redactions()).unwrap();
        assert!(issue.body.contains("### Platform\n\n_No response_\n\n"));
    }

    #[test]
    fn submission_needs_every_choice_and_the_players_own_account() {
        let mut fields = draft_report(ReportKind::Feedback, &inputs(), &redactions()).fields;
        set(&mut fields, "happened", "It was slow");
        let missing = report_issue(ReportKind::Feedback, &fields, &redactions()).unwrap_err();
        assert!(missing.message.contains("What were you trying to do?"));
        set(&mut fields, "journey", "Play a game");
        set(&mut fields, "outcome", "Not an option");
        assert!(report_issue(ReportKind::Feedback, &fields, &redactions()).is_err());
        set(&mut fields, "outcome", "This is an idea or request");
        set(&mut fields, "happened", "   \n ");
        let blank = report_issue(ReportKind::Feedback, &fields, &redactions()).unwrap_err();
        assert!(blank.message.contains("describe what happened"));
        set(&mut fields, "happened", &"x".repeat(ISSUE_BODY_LIMIT));
        assert!(report_issue(ReportKind::Feedback, &fields, &redactions()).is_err());

        let mut bug = draft_report(ReportKind::Problem, &inputs(), &redactions()).fields;
        set(&mut bug, "observed", &"y".repeat(200));
        let issue = report_issue(ReportKind::Problem, &bug, &redactions()).unwrap();
        assert!(issue.title.starts_with("[Bug] yyy"));
        assert_eq!(
            issue.title.chars().count(),
            "[Bug] ".len() + TITLE_SUMMARY_LIMIT
        );
        assert!(issue.title.ends_with('…'));
        assert!(
            issue
                .body
                .contains("### What were you doing when it happened?\n\n_No response_")
        );
    }

    #[test]
    fn percent_encoded_space_paths_and_unc_paths_are_redacted() {
        let redactions = ReportRedactions {
            home_dir: Some(r"C:\Users\Alice Smith".to_owned()),
            library_root: Some(r"\\nas\games\library".to_owned()),
            ..ReportRedactions::default()
        };
        assert_eq!(
            redact_report_text(
                "file:///C:/Users/Alice%20Smith/x and //NAS/Games/Library/save",
                &redactions
            ),
            "file:///<home>/x and <library>/save"
        );
    }

    #[test]
    fn non_ascii_text_keeps_its_offsets() {
        let redactions = ReportRedactions {
            home_dir: Some("/home/zoë".to_owned()),
            ..ReportRedactions::default()
        };
        assert_eq!(
            redact_report_text("café /home/zoë/ünï ok", &redactions),
            "café <home>/ünï ok"
        );
    }

    #[test]
    fn percent_encoding_is_utf8_safe() {
        assert_eq!(percent_encode("a b&é"), "a%20b%26%C3%A9");
    }
}
