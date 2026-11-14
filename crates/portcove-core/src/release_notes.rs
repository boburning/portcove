//! Informational upstream release notes for a game update review.
//!
//! Notes come only from release-list pages the provider already persisted while
//! resolving the offered release: building them makes no request. Upstream text is
//! untrusted and returned as bounded plain text. The only link is the project's
//! release list page, built from the provider origin and repository; the review
//! keeps it only when it passes the reviewed-link check.
use std::collections::HashSet;

use crate::{
    ReleaseChannel, UpdateReleaseNotes, UpdateReleaseNotesCoverage as Coverage,
    UpdateReleaseNotesEntry,
};

/// Releases listed in one review, including the offered one.
pub(crate) const MAX_RELEASES: usize = 20;
/// Characters kept from one release's notes.
pub(crate) const MAX_NOTE_CHARS: usize = 4_000;
const MAX_TITLE_CHARS: usize = 200;
const MAX_VERSION_CHARS: usize = 100;
/// Later cached pages are used only when confirmed within this window of the first
/// page, so the list is one observation rather than pages from different times.
pub(crate) const PAGE_SKEW_SECONDS: i64 = 300;

/// One release as the provider listed it, newest first.
pub(crate) struct ListedRelease<'a> {
    pub tag: &'a str,
    pub title: Option<&'a str>,
    pub published_at: Option<&'a str>,
    pub notes: &'a str,
    /// Published (not a draft or upcoming release) and for this platform.
    pub selectable: bool,
    pub beta: bool,
}

pub(crate) struct NotesRequest<'a> {
    pub channel: ReleaseChannel,
    pub rolling_tag: Option<&'a str>,
    pub installed: Option<&'a str>,
    pub offered: &'a str,
}

/// Reads consecutive cached list pages. A later page confirmed well before the first
/// one belongs to an older observation, so reading stops there and the result is a
/// contiguous prefix rather than a list with a silent gap.
pub(crate) fn cached_pages<T: serde::de::DeserializeOwned>(
    max_pages: usize,
    page_size: usize,
    max_bytes: usize,
    mut page: impl FnMut(usize) -> Option<crate::library::HttpCacheEntry>,
) -> Vec<T> {
    let mut items = Vec::new();
    let mut first_confirmed = None;
    for number in 1..=max_pages {
        let Some(cached) = page(number).filter(|cached| cached.body.len() <= max_bytes) else {
            break;
        };
        let first = *first_confirmed.get_or_insert(cached.updated_at);
        if cached.updated_at < first - PAGE_SKEW_SECONDS {
            break;
        }
        let Ok(mut current) = serde_json::from_str::<Vec<T>>(&cached.body) else {
            break;
        };
        let has_more = current.len() == page_size;
        items.append(&mut current);
        if !has_more {
            break;
        }
    }
    items
}

/// Selects the releases between the installed (exclusive) and offered (inclusive)
/// versions using the channel rules of release selection. An offered release that
/// is not listed yields no entries. Repeated tags keep their first listing.
pub(crate) fn between(
    listed: &[ListedRelease<'_>],
    request: &NotesRequest<'_>,
    releases_url: Option<String>,
) -> UpdateReleaseNotes {
    let mut seen = HashSet::new();
    let listed = listed
        .iter()
        .filter(|release| seen.insert(release.tag))
        .collect::<Vec<_>>();
    let result = |entries: Vec<UpdateReleaseNotesEntry>, coverage| UpdateReleaseNotes {
        releases_url: releases_url.clone(),
        coverage: if entries.is_empty() {
            Coverage::Unavailable
        } else {
            coverage
        },
        entries,
    };
    let position = |tag: &str| listed.iter().position(|release| release.tag == tag);
    let Some(offered_index) = position(request.offered) else {
        return result(Vec::new(), Coverage::Unavailable);
    };
    let mut entries = entry(listed[offered_index]).into_iter().collect::<Vec<_>>();
    match request.installed.and_then(position) {
        Some(installed) if installed == offered_index => {
            return result(entries, Coverage::Complete);
        }
        Some(installed) if installed < offered_index => {
            return result(entries, Coverage::InstalledNewer);
        }
        _ => {}
    }
    // A rolling tag is republished in place; earlier tags are a different stream.
    if request.channel == ReleaseChannel::Rolling {
        return result(entries, Coverage::InstalledNotListed);
    }
    let is_rolling = |tag: &str| {
        request
            .rolling_tag
            .is_some_and(|rolling| tag.eq_ignore_ascii_case(rolling))
    };
    for release in &listed[offered_index + 1..] {
        if request.installed == Some(release.tag) {
            return result(entries, Coverage::Complete);
        }
        let eligible = release.selectable
            && !is_rolling(release.tag)
            && (request.channel == ReleaseChannel::Beta || !release.beta);
        if !eligible {
            continue;
        }
        if entries.len() == MAX_RELEASES {
            return result(entries, Coverage::Shortened);
        }
        entries.extend(entry(release));
    }
    result(entries, Coverage::InstalledNotListed)
}

fn entry(release: &ListedRelease<'_>) -> Option<UpdateReleaseNotesEntry> {
    let version = single_line(release.tag, MAX_VERSION_CHARS);
    if version.is_empty() {
        return None;
    }
    let (notes, notes_truncated) = plain_text(release.notes, MAX_NOTE_CHARS);
    let title = release
        .title
        .map(|title| single_line(title, MAX_TITLE_CHARS))
        .filter(|title| !title.is_empty() && *title != version);
    Some(UpdateReleaseNotesEntry {
        version,
        title,
        published_at: release.published_at.and_then(timestamp),
        notes,
        notes_truncated,
    })
}

/// Accepts only a bounded RFC 3339-shaped timestamp; anything else is absent.
fn timestamp(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let shaped = (20..=35).contains(&bytes.len())
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[10] == b'T'
        && bytes[11..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || b":.+-Z".contains(byte));
    shaped.then(|| value.to_owned())
}

/// Builds `<root>/<segments...>` with each segment percent-encoded. Only an https
/// root (or a test fixture's loopback http origin) produces a link.
pub(crate) fn web_url(root: &str, segments: &[&str]) -> Option<String> {
    let mut url = reqwest::Url::parse(root).ok()?;
    let loopback = url
        .host_str()
        .is_some_and(|host| host == "127.0.0.1" || host == "localhost" || host == "[::1]");
    if url.scheme() != "https" && !(cfg!(test) && url.scheme() == "http" && loopback) {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        return None;
    }
    {
        let mut path = url.path_segments_mut().ok()?;
        path.pop_if_empty();
        for segment in segments {
            if segment.is_empty() {
                return None;
            }
            path.push(segment);
        }
    }
    Some(url.into())
}

/// Splits `owner/name` (or a GitLab group path) into URL path segments made of
/// ordinary repository characters only.
pub(crate) fn repository_segments(repository: &str) -> Option<Vec<&str>> {
    let segments = repository.split('/').collect::<Vec<_>>();
    (segments.len() >= 2
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && *segment != "."
                && *segment != ".."
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        }))
    .then_some(segments)
}

/// Normalizes untrusted upstream text for plain-text display: unified line breaks,
/// complete HTML comments removed (an unclosed `<!--` stays as text), no control or
/// bidirectional/invisible formatting characters, trailing spaces removed, at most
/// one blank line in a row, and at most `limit` characters (cut at a line boundary
/// when one is near).
pub(crate) fn plain_text(text: &str, limit: usize) -> (String, bool) {
    let text = text
        .replace("\r\n", "\n")
        .replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let text = strip_html_comments(&text);
    let mut lines = Vec::<String>::new();
    for line in text.split('\n') {
        let line = line
            .chars()
            .map(|character| if character == '\t' { ' ' } else { character })
            .filter(|character| !character.is_control() && !is_bidi_or_invisible_format(*character))
            .collect::<String>();
        let line = line.trim_end();
        if line.is_empty() && lines.last().is_some_and(String::is_empty) {
            continue;
        }
        lines.push(line.to_owned());
    }
    let joined = lines.join("\n");
    let trimmed = joined.trim();
    if trimmed.chars().count() <= limit {
        return (trimmed.to_owned(), false);
    }
    let cut = trimmed
        .char_indices()
        .nth(limit)
        .map_or(trimmed.len(), |(offset, _)| offset);
    let head = &trimmed[..cut];
    // Prefer ending at a line break in the last quarter of the bound.
    let head = match head.rfind('\n') {
        Some(offset) if head[..offset].chars().count() >= limit * 3 / 4 => &head[..offset],
        _ => head,
    };
    (head.trim_end().to_owned(), true)
}

fn single_line(text: &str, limit: usize) -> String {
    plain_text(text, limit)
        .0
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_html_comments(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        let Some(end) = rest[start + 4..].find("-->") else {
            break;
        };
        result.push_str(&rest[..start]);
        rest = &rest[start + 4 + end + 3..];
    }
    result.push_str(rest);
    result
}

/// Bidirectional controls and invisible characters that can disguise text. Zero
/// width joiners/non-joiners stay: several scripts and emoji need them.
fn is_bidi_or_invisible_format(character: char) -> bool {
    matches!(
        character,
        '\u{061C}'
            | '\u{200B}'
            | '\u{200E}'
            | '\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release<'a>(tag: &'a str, notes: &'a str) -> ListedRelease<'a> {
        ListedRelease {
            tag,
            title: None,
            published_at: None,
            notes,
            selectable: true,
            beta: false,
        }
    }

    fn request<'a>(installed: Option<&'a str>, offered: &'a str) -> NotesRequest<'a> {
        NotesRequest {
            channel: ReleaseChannel::Stable,
            rolling_tag: None,
            installed,
            offered,
        }
    }

    fn notes(listed: &[ListedRelease<'_>], request: &NotesRequest<'_>) -> UpdateReleaseNotes {
        between(listed, request, Some("https://example.test/all".into()))
    }

    fn versions(notes: &UpdateReleaseNotes) -> Vec<&str> {
        notes
            .entries
            .iter()
            .map(|entry| entry.version.as_str())
            .collect()
    }

    #[test]
    fn lists_eligible_releases_between_installed_and_offered_newest_first() {
        let mut beta = release("v4-beta.1", "beta");
        beta.beta = true;
        let mut draft = release("v3.5", "draft or other platform");
        draft.selectable = false;
        let listed = [
            release("v5", "newer than offered"),
            release("v4", "four"),
            beta,
            draft,
            release("v3", "three"),
            release("v2", "installed"),
            release("v1", "older"),
        ];
        let stable = notes(&listed, &request(Some("v2"), "v4"));
        assert_eq!(versions(&stable), ["v4", "v3"]);
        assert_eq!(stable.coverage, Coverage::Complete);
        assert_eq!(stable.entries[0].notes, "four");
        assert_eq!(
            stable.releases_url.as_deref(),
            Some("https://example.test/all")
        );

        let mut beta_request = request(Some("v2"), "v4");
        beta_request.channel = ReleaseChannel::Beta;
        assert_eq!(
            versions(&notes(&listed, &beta_request)),
            ["v4", "v4-beta.1", "v3"]
        );
    }

    #[test]
    fn each_incomplete_reason_is_distinct() {
        let listed = [release("v3", ""), release("v2", ""), release("v1", "")];
        let missing_installed = notes(&listed, &request(Some("v0"), "v3"));
        assert_eq!(versions(&missing_installed), ["v3", "v2", "v1"]);
        assert_eq!(missing_installed.coverage, Coverage::InstalledNotListed);
        assert_eq!(
            notes(&listed, &request(None, "v3")).coverage,
            Coverage::InstalledNotListed
        );
        let missing_offered = between(&listed, &request(Some("v1"), "v9"), None);
        assert!(missing_offered.entries.is_empty());
        assert_eq!(missing_offered.coverage, Coverage::Unavailable);
        assert_eq!(missing_offered.releases_url, None);

        // A newer installed version (for example after a channel switch) never
        // lists older releases as new.
        let newer = notes(&listed, &request(Some("v3"), "v2"));
        assert_eq!(versions(&newer), ["v2"]);
        assert_eq!(newer.coverage, Coverage::InstalledNewer);

        let tags = (0..40)
            .map(|index| format!("v{}", 40 - index))
            .collect::<Vec<_>>();
        let many = tags.iter().map(|tag| release(tag, "")).collect::<Vec<_>>();
        let bounded = notes(&many, &request(Some("v1"), "v40"));
        assert_eq!(bounded.entries.len(), MAX_RELEASES);
        assert_eq!(bounded.coverage, Coverage::Shortened);
        let exact = notes(&many, &request(Some("v20"), "v40"));
        assert_eq!(exact.entries.len(), MAX_RELEASES);
        assert_eq!(exact.coverage, Coverage::Complete);
    }

    #[test]
    fn repeated_tags_keep_their_first_listing() {
        let listed = [
            release("v3", "fresh"),
            release("v2", "two"),
            release("v3", "stale duplicate"),
            release("v2", "stale duplicate"),
            release("v1", ""),
        ];
        let deduplicated = notes(&listed, &request(Some("v1"), "v3"));
        assert_eq!(versions(&deduplicated), ["v3", "v2"]);
        assert_eq!(deduplicated.entries[0].notes, "fresh");
        assert_eq!(deduplicated.coverage, Coverage::Complete);
    }

    #[test]
    fn same_tag_and_rolling_list_only_the_offered_release() {
        let listed = [
            release("nightly", "rebuilt"),
            release("v2", ""),
            release("v1", ""),
        ];
        let same = notes(&listed, &request(Some("nightly"), "nightly"));
        assert_eq!(versions(&same), ["nightly"]);
        assert_eq!(same.coverage, Coverage::Complete);
        let mut rolling = request(Some("v1"), "nightly");
        rolling.channel = ReleaseChannel::Rolling;
        rolling.rolling_tag = Some("Nightly");
        let rolling = notes(&listed, &rolling);
        assert_eq!(versions(&rolling), ["nightly"]);
        assert_eq!(rolling.coverage, Coverage::InstalledNotListed);
        let mut stable = request(Some("v1"), "v2");
        stable.rolling_tag = Some("nightly");
        let listed = [release("v2", ""), release("NIGHTLY", ""), release("v1", "")];
        assert_eq!(versions(&notes(&listed, &stable)), ["v2"]);
    }

    #[test]
    fn upstream_text_is_normalized_bounded_and_kept_inert() {
        let (text, truncated) = plain_text(
            "Fixes\r\n<!-- template -->\r\n- a\u{202E}b\u{0007}\n \n\t\n  \n\n<script>alert(1)</script>\t",
            100,
        );
        assert_eq!(text, "Fixes\n\n- ab\n\n<script>alert(1)</script>");
        assert!(!truncated);
        // An unclosed comment is shown, not used to hide the rest.
        let (text, truncated) = plain_text("open <!-- never closed\nrest", 100);
        assert_eq!(
            (text.as_str(), truncated),
            ("open <!-- never closed\nrest", false)
        );
        // Line and paragraph separators break lines; joiners stay.
        let (text, _) = plain_text("a\u{2028}b\u{2029}c \u{200D}\u{200C}", 100);
        assert_eq!(text, "a\nb\nc \u{200D}\u{200C}");
        let long = format!("{}\n{}", "a".repeat(90), "b".repeat(40));
        let (text, truncated) = plain_text(&long, 100);
        assert_eq!(text, "a".repeat(90));
        assert!(truncated);
        let (text, truncated) = plain_text(&"é".repeat(120), 100);
        assert_eq!(text.chars().count(), 100);
        assert!(truncated);
    }

    #[test]
    fn version_title_and_date_are_bounded_single_line_values() {
        let long_tag = format!("v\u{202E}{}", "1".repeat(300));
        let mut listed = [release(&long_tag, ""), release("v0", "")];
        listed[0].title = Some("\u{202E} ");
        listed[0].published_at = Some("<script>");
        listed[1].title = Some("  Big\nupdate ");
        listed[1].published_at = Some("2026-11-01T00:00:00Z");
        let result = notes(&listed, &request(None, &long_tag));
        let first = &result.entries[0];
        assert_eq!(first.version.chars().count(), MAX_VERSION_CHARS);
        assert!(!first.version.contains('\u{202E}'));
        assert_eq!(first.title, None);
        assert_eq!(first.published_at, None);
        assert_eq!(result.entries[1].title.as_deref(), Some("Big update"));
        assert_eq!(
            result.entries[1].published_at.as_deref(),
            Some("2026-11-01T00:00:00Z")
        );
        assert!(timestamp("2026-11-01T00:00:00.123+02:00").is_some());
        assert_eq!(timestamp("2026-11-01"), None);
    }

    #[test]
    fn release_page_links_accept_only_ordinary_repository_segments() {
        assert_eq!(
            web_url("https://example.test", &["owner", "repo", "releases"]).as_deref(),
            Some("https://example.test/owner/repo/releases")
        );
        assert_eq!(web_url("javascript:alert(1)", &["x"]), None);
        assert_eq!(web_url("http://example.test", &["x"]), None);
        assert_eq!(web_url("https://example.test", &[""]), None);
        assert_eq!(repository_segments("owner/../x"), None);
        assert_eq!(repository_segments("owner"), None);
        assert_eq!(repository_segments("owner/re%2Fpo"), None);
        assert_eq!(repository_segments("owner/re po"), None);
        assert_eq!(
            repository_segments("group/sub/name"),
            Some(vec!["group", "sub", "name"])
        );
    }
}
