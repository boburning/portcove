//! Informational upstream release notes for a game update review.
//!
//! Notes come only from release-list pages the provider already persisted while
//! resolving the offered release: building them makes no request. Upstream text is
//! untrusted and returned as bounded plain text; links are built from the provider
//! origin, repository and tag rather than taken from upstream data.
use crate::{ReleaseChannel, UpdateReleaseNotes, UpdateReleaseNotesEntry};

/// Releases listed in one review, including the offered one.
pub(crate) const MAX_RELEASES: usize = 20;
/// Characters kept from one release's notes.
pub(crate) const MAX_NOTE_CHARS: usize = 4_000;
const MAX_TITLE_CHARS: usize = 200;

/// One release as the provider listed it, newest first.
pub(crate) struct ListedRelease<'a> {
    pub tag: &'a str,
    pub title: Option<&'a str>,
    pub published_at: Option<&'a str>,
    pub notes: &'a str,
    /// Published (not a draft or upcoming release).
    pub published: bool,
    pub beta: bool,
}

pub(crate) struct NotesRequest<'a> {
    pub channel: ReleaseChannel,
    pub rolling_tag: Option<&'a str>,
    pub installed: Option<&'a str>,
    pub offered: &'a str,
}

/// Selects the releases between the installed (exclusive) and offered (inclusive)
/// versions using the channel rules of release selection. An offered release that
/// is not listed yields no entries.
pub(crate) fn between(
    listed: &[ListedRelease<'_>],
    request: &NotesRequest<'_>,
    releases_url: String,
    release_url: impl Fn(&str) -> Option<String>,
) -> UpdateReleaseNotes {
    let unknown = |releases_url| UpdateReleaseNotes {
        releases_url,
        entries: Vec::new(),
        complete: false,
    };
    let Some(offered_index) = listed
        .iter()
        .position(|release| release.tag == request.offered)
    else {
        return unknown(releases_url);
    };
    let entry = |release: &ListedRelease<'_>| {
        let url = release_url(release.tag)?;
        let (notes, notes_truncated) = plain_text(release.notes, MAX_NOTE_CHARS);
        let title = release
            .title
            .map(|title| plain_text(title, MAX_TITLE_CHARS).0.replace('\n', " "))
            .map(|title| title.trim().to_owned())
            .filter(|title| !title.is_empty() && title != release.tag);
        Some(UpdateReleaseNotesEntry {
            version: release.tag.to_owned(),
            title,
            published_at: release.published_at.map(str::to_owned),
            url,
            notes,
            notes_truncated,
        })
    };
    let Some(offered) = entry(&listed[offered_index]) else {
        return unknown(releases_url);
    };
    let mut entries = vec![offered];
    if request.installed == Some(request.offered) {
        return UpdateReleaseNotes {
            releases_url,
            entries,
            complete: true,
        };
    }
    // A rolling tag is republished in place; earlier tags are a different stream.
    if request.channel == ReleaseChannel::Rolling {
        return UpdateReleaseNotes {
            releases_url,
            entries,
            complete: false,
        };
    }
    let is_rolling = |tag: &str| {
        request
            .rolling_tag
            .is_some_and(|rolling| tag.eq_ignore_ascii_case(rolling))
    };
    let mut complete = false;
    for release in &listed[offered_index + 1..] {
        if request.installed == Some(release.tag) {
            complete = true;
            break;
        }
        let eligible = release.published
            && !is_rolling(release.tag)
            && (request.channel == ReleaseChannel::Beta || !release.beta);
        if !eligible {
            continue;
        }
        if entries.len() == MAX_RELEASES {
            break;
        }
        let Some(entry) = entry(release) else {
            continue;
        };
        entries.push(entry);
    }
    UpdateReleaseNotes {
        releases_url,
        entries,
        complete,
    }
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

/// Splits `owner/name` (or a GitLab group path) into URL path segments.
pub(crate) fn repository_segments(repository: &str) -> Option<Vec<&str>> {
    let segments = repository.split('/').collect::<Vec<_>>();
    (segments.len() >= 2
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && *segment != "." && *segment != ".."))
    .then_some(segments)
}

/// Normalizes untrusted upstream text for plain-text display: unified newlines,
/// no HTML comments, no control or bidirectional formatting characters, at most
/// two consecutive blank lines, and at most `limit` characters (cut at a line
/// boundary when one is near).
pub(crate) fn plain_text(text: &str, limit: usize) -> (String, bool) {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let text = strip_html_comments(&text);
    let mut cleaned = String::with_capacity(text.len().min(limit * 4));
    let mut newlines = 0;
    for character in text.chars() {
        let character = if character == '\t' { ' ' } else { character };
        if character == '\n' {
            newlines += 1;
            if newlines <= 2 {
                cleaned.push('\n');
            }
            continue;
        }
        if character.is_control() || is_bidi_or_invisible_format(character) {
            continue;
        }
        newlines = 0;
        cleaned.push(character);
    }
    let lines = cleaned
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = lines.trim();
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

fn strip_html_comments(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        result.push_str(&rest[..start]);
        match rest[start + 4..].find("-->") {
            Some(end) => rest = &rest[start + 4 + end + 3..],
            None => return result,
        }
    }
    result.push_str(rest);
    result
}

fn is_bidi_or_invisible_format(character: char) -> bool {
    matches!(
        character,
        '\u{061C}'
            | '\u{200B}'..='\u{200F}'
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
            published: true,
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

    fn url(tag: &str) -> Option<String> {
        web_url("https://example.test/owner/repo", &["releases", "tag", tag])
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
        let mut draft = release("v3.5", "draft");
        draft.published = false;
        let listed = [
            release("v5", "newer than offered"),
            release("v4", "four"),
            beta,
            draft,
            release("v3", "three"),
            release("v2", "installed"),
            release("v1", "older"),
        ];
        let notes = between(
            &listed,
            &request(Some("v2"), "v4"),
            "https://example.test/all".into(),
            url,
        );
        assert_eq!(versions(&notes), ["v4", "v3"]);
        assert!(notes.complete);
        assert_eq!(notes.entries[0].notes, "four");
        assert_eq!(
            notes.entries[0].url,
            "https://example.test/owner/repo/releases/tag/v4"
        );

        let mut beta_request = request(Some("v2"), "v4");
        beta_request.channel = ReleaseChannel::Beta;
        let notes = between(&listed, &beta_request, "x".into(), url);
        assert_eq!(versions(&notes), ["v4", "v4-beta.1", "v3"]);
    }

    #[test]
    fn unknown_installed_or_offered_and_the_bound_are_reported_incomplete() {
        let listed = [release("v3", ""), release("v2", ""), release("v1", "")];
        let missing_installed = between(&listed, &request(Some("v0"), "v3"), "x".into(), url);
        assert_eq!(versions(&missing_installed), ["v3", "v2", "v1"]);
        assert!(!missing_installed.complete);
        let no_installed = between(&listed, &request(None, "v3"), "x".into(), url);
        assert!(!no_installed.complete);
        let missing_offered = between(&listed, &request(Some("v1"), "v9"), "all".into(), url);
        assert!(missing_offered.entries.is_empty());
        assert!(!missing_offered.complete);
        assert_eq!(missing_offered.releases_url, "all");

        let tags = (0..40)
            .map(|index| format!("v{}", 40 - index))
            .collect::<Vec<_>>();
        let many = tags.iter().map(|tag| release(tag, "")).collect::<Vec<_>>();
        let bounded = between(&many, &request(Some("v1"), "v40"), "x".into(), url);
        assert_eq!(bounded.entries.len(), MAX_RELEASES);
        assert!(!bounded.complete);
        let exact = between(&many, &request(Some("v20"), "v40"), "x".into(), url);
        assert_eq!(exact.entries.len(), MAX_RELEASES);
        assert!(exact.complete);
    }

    #[test]
    fn same_tag_and_rolling_list_only_the_offered_release() {
        let listed = [
            release("nightly", "rebuilt"),
            release("v2", ""),
            release("v1", ""),
        ];
        let same = between(
            &listed,
            &request(Some("nightly"), "nightly"),
            "x".into(),
            url,
        );
        assert_eq!(versions(&same), ["nightly"]);
        assert!(same.complete);
        let mut rolling = request(Some("v1"), "nightly");
        rolling.channel = ReleaseChannel::Rolling;
        rolling.rolling_tag = Some("Nightly");
        let rolling = between(&listed, &rolling, "x".into(), url);
        assert_eq!(versions(&rolling), ["nightly"]);
        assert!(!rolling.complete);
        let mut stable = request(Some("v1"), "v2");
        stable.rolling_tag = Some("nightly");
        let listed = [release("v2", ""), release("NIGHTLY", ""), release("v1", "")];
        assert_eq!(
            versions(&between(&listed, &stable, "x".into(), url)),
            ["v2"]
        );
    }

    #[test]
    fn upstream_text_is_normalized_bounded_and_kept_inert() {
        let (text, truncated) = plain_text(
            "Fixes\r\n<!-- template -->\r\n- a\u{202E}b\u{0007}\n\n\n\n\n<script>alert(1)</script>\t",
            100,
        );
        assert_eq!(text, "Fixes\n\n- ab\n\n<script>alert(1)</script>");
        assert!(!truncated);
        let (text, truncated) = plain_text("open <!-- never closed", 100);
        assert_eq!((text.as_str(), truncated), ("open", false));
        let long = format!("{}\n{}", "a".repeat(90), "b".repeat(40));
        let (text, truncated) = plain_text(&long, 100);
        assert_eq!(text, "a".repeat(90));
        assert!(truncated);
        let (text, truncated) = plain_text(&"é".repeat(120), 100);
        assert_eq!(text.chars().count(), 100);
        assert!(truncated);
    }

    #[test]
    fn titles_equal_to_the_tag_are_dropped_and_links_encode_tags() {
        let mut titled = release("v1 / x?#", "");
        titled.title = Some("v1 / x?#");
        let mut named = release("v0", "");
        named.title = Some("  Big\nupdate ");
        let listed = [titled, named];
        let notes = between(&listed, &request(None, "v1 / x?#"), "x".into(), url);
        assert_eq!(notes.entries[0].title, None);
        assert_eq!(
            notes.entries[0].url,
            "https://example.test/owner/repo/releases/tag/v1%20%2F%20x%3F%23"
        );
        assert_eq!(notes.entries[1].title.as_deref(), Some("Big update"));
        assert_eq!(web_url("javascript:alert(1)", &["x"]), None);
        assert_eq!(web_url("http://example.test", &["x"]), None);
        assert_eq!(web_url("https://example.test", &[""]), None);
        assert_eq!(repository_segments("owner/../x"), None);
        assert_eq!(repository_segments("owner"), None);
        assert_eq!(
            repository_segments("group/sub/name"),
            Some(vec!["group", "sub", "name"])
        );
    }
}
