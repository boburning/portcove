use quick_xml::{
    NsReader, XmlVersion,
    events::{BytesStart, Event},
    name::ResolveResult,
};
use std::collections::HashSet;
use time::{
    OffsetDateTime, UtcOffset,
    format_description::well_known::{Rfc2822, Rfc3339},
};

pub(crate) const PORT_ID: &str = "quake-vkquake";
pub(crate) const ATTRIBUTION: &str = "Mod DB - Game Development";
pub(crate) const FEED_URL: &str =
    "https://rss.moddb.com/mods/arcane-dimensions/downloads/feed/rss.xml";
pub(crate) const FILES_PAGE: &str = "https://www.moddb.com/mods/arcane-dimensions/downloads";
const SELF_LINK: &str = "https://www.moddb.com/mods/arcane-dimensions/downloads/feed/rss.xml";
pub(crate) const MAX_BODY_BYTES: usize = 128 * 1024;
const MAX_DEPTH: usize = 12;
const MAX_NOTICES: usize = 32;
const MAX_FIELD_BYTES: usize = 512;
const ATOM_NS: &str = "http://www.w3.org/2005/Atom";

/// Mod DB's Files channel also contains tutorials and patches. A notice
/// identifies a page to open, without classifying it as an installable release.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FileNotice {
    pub source_id: String,
    pub title: String,
    pub page_url: String,
    pub published_at: Option<String>,
}

#[derive(Clone, Copy)]
enum Field {
    ChannelLink,
    Category,
    Title,
    ItemLink,
    Guid,
    Date,
}

#[derive(Default)]
struct Item {
    title: Option<String>,
    link: Option<String>,
    guid: Option<String>,
    date: Option<String>,
}

impl Item {
    fn into_notice(self) -> Result<FileNotice, &'static str> {
        let title = self.title.ok_or("Mod DB title is missing")?;
        if title.is_empty() || title.contains(['<', '>']) || title.chars().any(char::is_control) {
            return Err("Mod DB title is invalid");
        }
        let guid = self.guid.ok_or("Mod DB file identity is missing")?;
        let digits = guid
            .strip_prefix("downloads")
            .ok_or("Mod DB file identity is invalid")?;
        if digits.is_empty()
            || digits.len() > 16
            || digits.starts_with('0')
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("Mod DB file identity is invalid");
        }
        let url = self.link.ok_or("Mod DB file page is missing")?;
        let slug = url
            .strip_prefix(FILES_PAGE)
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or("Mod DB file page is outside the reviewed scope")?;
        if slug.len() > 128
            || !slug.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            })
        {
            return Err("Mod DB file page is outside the reviewed scope");
        }
        let published_at = self
            .date
            .map(|date| {
                let at =
                    OffsetDateTime::parse(&date, &Rfc2822).map_err(|_| "Mod DB date is invalid")?;
                at.to_offset(UtcOffset::UTC)
                    .format(&Rfc3339)
                    .map_err(|_| "Mod DB date is invalid")
            })
            .transpose()?;
        Ok(FileNotice {
            source_id: guid,
            title,
            page_url: url,
            published_at,
        })
    }
}

fn attribute(tag: &BytesStart<'_>, key: &str) -> Result<Option<String>, &'static str> {
    let mut value = None;
    for attr in tag.attributes() {
        let attr = attr.map_err(|_| "Mod DB XML attributes are invalid")?;
        if attr.key.as_ref() == key {
            value = Some(
                attr.normalized_value(XmlVersion::Explicit1_0)
                    .map_err(|_| "Mod DB XML attribute is invalid")?
                    .into_owned(),
            );
        }
    }
    Ok(value)
}

#[derive(Default)]
struct Feed {
    depth: usize,
    root: bool,
    channel: bool,
    self_link: bool,
    channel_link: Option<String>,
    category: Option<String>,
    capture: Option<(Field, String)>,
    item: Option<Item>,
    notices: Vec<FileNotice>,
}

impl Feed {
    fn open(
        &mut self,
        namespace: &ResolveResult<'_>,
        tag: &BytesStart<'_>,
    ) -> Result<(), &'static str> {
        if self.depth >= MAX_DEPTH || self.capture.is_some() {
            return Err("Mod DB XML nesting exceeds the supported structure");
        }
        let local = tag.local_name();
        let name = local.as_ref();
        let unbound = matches!(namespace, ResolveResult::Unbound);
        let field = match self.depth {
            0 => {
                if self.root
                    || !unbound
                    || name != "rss"
                    || attribute(tag, "version")?.as_deref() != Some("2.0")
                {
                    return Err("Mod DB response is not the expected RSS 2.0 feed");
                }
                self.root = true;
                None
            }
            1 => {
                if self.channel || !unbound || name != "channel" {
                    return Err("Mod DB RSS channel is invalid");
                }
                self.channel = true;
                None
            }
            2 if unbound && name == "item" => {
                if self.notices.len() >= MAX_NOTICES {
                    return Err("Mod DB RSS item count exceeds its bound");
                }
                self.item = Some(Item::default());
                None
            }
            2 if unbound && name == "link" => Some(Field::ChannelLink),
            2 if unbound && name == "category" => Some(Field::Category),
            2 if matches!(namespace, ResolveResult::Bound(ns) if ns.as_ref() == ATOM_NS)
                && name == "link" =>
            {
                if attribute(tag, "rel")?.as_deref() == Some("self") {
                    let url = attribute(tag, "href")?;
                    if self.self_link
                        || ![Some(SELF_LINK), Some(FEED_URL)].contains(&url.as_deref())
                        || attribute(tag, "type")?.as_deref() != Some("application/rss+xml")
                    {
                        return Err("Mod DB RSS self link differs from the reviewed feed");
                    }
                    self.self_link = true;
                }
                None
            }
            3 if unbound && self.item.is_some() => match name {
                "title" => Some(Field::Title),
                "link" => Some(Field::ItemLink),
                "guid" => {
                    if attribute(tag, "isPermaLink")?.as_deref() != Some("false") {
                        return Err("Mod DB GUID must be a provider ID");
                    }
                    Some(Field::Guid)
                }
                "pubDate" => Some(Field::Date),
                _ => None,
            },
            _ => None,
        };
        self.capture = field.map(|field| (field, String::new()));
        self.depth += 1;
        Ok(())
    }

    fn text(&mut self, value: &str) -> Result<(), &'static str> {
        if let Some((_, field)) = &mut self.capture {
            if field.len() + value.len() > MAX_FIELD_BYTES {
                return Err("Mod DB RSS field exceeds its bound");
            }
            field.push_str(value);
        } else if self.depth == 0 && !value.trim().is_empty() {
            return Err("Mod DB RSS contains text outside the document");
        }
        Ok(())
    }

    fn close(&mut self) -> Result<(), &'static str> {
        self.depth = self
            .depth
            .checked_sub(1)
            .ok_or("Mod DB XML closing tag is invalid")?;
        if let Some((field, value)) = self.capture.take() {
            let target = match field {
                Field::ChannelLink => &mut self.channel_link,
                Field::Category => &mut self.category,
                Field::Title => &mut self.item.as_mut().expect("item field").title,
                Field::ItemLink => &mut self.item.as_mut().expect("item field").link,
                Field::Guid => &mut self.item.as_mut().expect("item field").guid,
                Field::Date => &mut self.item.as_mut().expect("item field").date,
            };
            if target.replace(value.trim().to_owned()).is_some() {
                return Err("Mod DB RSS contains a duplicate field");
            }
        }
        if self.depth == 2
            && let Some(item) = self.item.take()
        {
            self.notices.push(item.into_notice()?);
        }
        Ok(())
    }

    fn finish(self) -> Result<Vec<FileNotice>, &'static str> {
        if self.depth != 0
            || !self.root
            || !self.channel
            || !self.self_link
            || self.channel_link.as_deref() != Some(FILES_PAGE)
            || self.category.as_deref() != Some("Downloads")
        {
            return Err("Mod DB RSS channel differs from the reviewed Files source");
        }
        let mut ids = HashSet::new();
        let mut urls = HashSet::new();
        if self
            .notices
            .iter()
            .any(|item| !ids.insert(&item.source_id) || !urls.insert(&item.page_url))
        {
            return Err("Mod DB RSS contains a duplicate file notice");
        }
        Ok(self.notices)
    }
}

/// The caller retrieves only FEED_URL with a bounded, credential-free request
/// and refuses redirects. This parser performs no I/O and does not read media,
/// descriptions, enclosures or URLs outside the canonical file-page scope.
pub(crate) fn parse_files(body: &[u8]) -> Result<Vec<FileNotice>, &'static str> {
    if body.len() > MAX_BODY_BYTES {
        return Err("Mod DB RSS body exceeds its bound");
    }
    let text = std::str::from_utf8(body).map_err(|_| "Mod DB RSS is not UTF-8")?;
    let mut reader = NsReader::from_str(text);
    reader.config_mut().expand_empty_elements = true;
    reader.config_mut().check_comments = true;
    let mut feed = Feed::default();
    let mut declaration = false;
    loop {
        let (namespace, event) = reader
            .read_resolved_event()
            .map_err(|_| "Mod DB XML is malformed")?;
        if matches!(namespace, ResolveResult::Unknown(_)) {
            return Err("Mod DB XML uses an undeclared namespace");
        }
        match event {
            Event::Start(tag) => feed.open(&namespace, &tag)?,
            Event::End(_) => feed.close()?,
            Event::Text(text) => feed.text(&text.xml10_content())?,
            Event::CData(text) => feed.text(&text.xml10_content())?,
            Event::GeneralRef(reference) => {
                if let Some(character) = reference
                    .resolve_char_ref()
                    .map_err(|_| "Mod DB character reference is invalid")?
                {
                    feed.text(character.encode_utf8(&mut [0; 4]))?;
                } else {
                    feed.text(
                        quick_xml::escape::resolve_predefined_entity(&reference)
                            .ok_or("Mod DB XML entity is forbidden")?,
                    )?;
                }
            }
            Event::Decl(decl) if !declaration && !feed.root => {
                declaration = true;
                if decl
                    .version()
                    .map_err(|_| "Mod DB XML declaration is invalid")?
                    .as_ref()
                    != "1.0"
                    || decl
                        .encoding()
                        .is_some_and(|enc| !enc.is_ok_and(|v| v.eq_ignore_ascii_case("utf-8")))
                {
                    return Err("Mod DB XML declaration is invalid");
                }
            }
            Event::Comment(_) => {}
            Event::Eof => return feed.finish(),
            // No DTD, processing instruction, or external resolver is available.
            _ => return Err("Mod DB XML contains a forbidden event"),
        }
    }
}

#[cfg(test)]
#[path = "moddb_feed_tests.rs"]
mod tests;
