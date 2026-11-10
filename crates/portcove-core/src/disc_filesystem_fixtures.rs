//! Synthetic, hand-built XDVDFS and ISO 9660 images for tests. No real game data.
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
    path::Path,
};

pub(crate) const SECTOR: usize = 2048;

pub(crate) enum Item {
    File(String, Vec<u8>),
    Dir(String, Vec<Item>),
}

pub(crate) fn file(name: &str, data: &[u8]) -> Item {
    Item::File(name.into(), data.to_vec())
}

pub(crate) fn dir(name: &str, items: Vec<Item>) -> Item {
    Item::Dir(name.into(), items)
}

/// A sparse image: written segments over an all-zero background.
pub(crate) struct Image {
    pub(crate) len: u64,
    pub(crate) segments: Vec<(u64, Vec<u8>)>,
}

impl Image {
    fn new() -> Self {
        Self {
            len: 0,
            segments: Vec::new(),
        }
    }

    pub(crate) fn put(&mut self, offset: u64, bytes: &[u8]) {
        self.len = self.len.max(offset + bytes.len() as u64);
        self.segments.push((offset, bytes.to_vec()));
    }

    /// Overwrite bytes that a previous `put` already covers.
    pub(crate) fn patch(&mut self, offset: u64, bytes: &[u8]) {
        self.len = self.len.max(offset + bytes.len() as u64);
        self.segments.push((offset, bytes.to_vec()));
    }

    /// Absolute offset of the first occurrence of `needle` in any segment.
    pub(crate) fn find(&self, needle: &[u8]) -> u64 {
        self.segments
            .iter()
            .find_map(|(offset, bytes)| {
                bytes
                    .windows(needle.len())
                    .position(|window| window == needle)
                    .map(|position| offset + position as u64)
            })
            .expect("needle present in fixture")
    }

    pub(crate) fn write_to(&self, path: &Path) {
        let mut file = File::create(path).unwrap();
        file.set_len(self.len).unwrap();
        for (offset, bytes) in &self.segments {
            file.seek(SeekFrom::Start(*offset)).unwrap();
            file.write_all(bytes).unwrap();
        }
        file.sync_all().unwrap();
    }

    pub(crate) fn truncated(mut self, len: u64) -> Self {
        self.len = len;
        self.segments.retain(|(offset, _)| *offset < len);
        for (offset, bytes) in &mut self.segments {
            let keep = (len - *offset).min(bytes.len() as u64) as usize;
            bytes.truncate(keep);
        }
        self
    }
}

fn sectors(bytes: usize) -> u32 {
    bytes.div_ceil(SECTOR) as u32
}

fn sorted(items: Vec<Item>) -> Vec<Item> {
    let mut items = items;
    items.sort_by_key(|item| match item {
        Item::File(name, _) | Item::Dir(name, _) => name.to_ascii_lowercase(),
    });
    items
}

// ---- XDVDFS ---------------------------------------------------------------

enum XNode {
    File { sector: u32, data: Vec<u8> },
    Dir(XDir),
}

struct XDir {
    sector: u32,
    size: u32,
    entries: Vec<(String, XNode)>,
}

fn xdvdfs_table_size(names: &[&str]) -> u32 {
    let used: usize = names
        .iter()
        .map(|name| (14 + name.len()).div_ceil(4) * 4)
        .sum();
    (sectors(used.max(1)) as usize * SECTOR) as u32
}

fn place_xdvdfs(items: Vec<Item>, next: &mut u32) -> XDir {
    let items = sorted(items);
    let names: Vec<&str> = items
        .iter()
        .map(|item| match item {
            Item::File(name, _) | Item::Dir(name, _) => name.as_str(),
        })
        .collect();
    let size = xdvdfs_table_size(&names);
    let sector = *next;
    *next += size / SECTOR as u32;
    let mut entries = Vec::new();
    for item in items {
        match item {
            Item::File(name, data) => {
                let sector = *next;
                *next += sectors(data.len());
                entries.push((name, XNode::File { sector, data }));
            }
            Item::Dir(name, children) => {
                entries.push((name, XNode::Dir(place_xdvdfs(children, next))));
            }
        }
    }
    XDir {
        sector,
        size,
        entries,
    }
}

fn write_xdvdfs_dir(image: &mut Image, base: u64, directory: &XDir) {
    let mut table = vec![0xff_u8; directory.size as usize];
    let mut offsets = Vec::new();
    let mut at = 0;
    for (name, _) in &directory.entries {
        offsets.push(at);
        at += (14 + name.len()).div_ceil(4) * 4;
    }
    for (index, (name, node)) in directory.entries.iter().enumerate() {
        let at = offsets[index];
        let right = offsets.get(index + 1).map_or(0, |next| (next / 4) as u16);
        let (sector, size, attributes) = match node {
            XNode::File { sector, data } => (*sector, data.len() as u32, 0x20),
            XNode::Dir(child) => (child.sector, child.size, 0x10),
        };
        table[at..at + 2].copy_from_slice(&0_u16.to_le_bytes());
        table[at + 2..at + 4].copy_from_slice(&right.to_le_bytes());
        table[at + 4..at + 8].copy_from_slice(&sector.to_le_bytes());
        table[at + 8..at + 12].copy_from_slice(&size.to_le_bytes());
        table[at + 12] = attributes;
        table[at + 13] = name.len() as u8;
        table[at + 14..at + 14 + name.len()].copy_from_slice(name.as_bytes());
        // Pad bytes between entries are zero in practice; 0xFF only fills the tail.
        let padded = (14 + name.len()).div_ceil(4) * 4;
        for byte in &mut table[at + 14 + name.len()..at + padded] {
            *byte = 0;
        }
    }
    image.put(base + u64::from(directory.sector) * SECTOR as u64, &table);
    for (_, node) in &directory.entries {
        match node {
            XNode::File { sector, data } if !data.is_empty() => {
                image.put(base + u64::from(*sector) * SECTOR as u64, data);
                // Keep the file's final sector fully inside the image.
                let end = base + u64::from(*sector + sectors(data.len())) * SECTOR as u64;
                image.len = image.len.max(end);
            }
            XNode::Dir(child) => write_xdvdfs_dir(image, base, child),
            XNode::File { .. } => {}
        }
    }
}

/// Build an XDVDFS image whose game partition starts at `base`.
pub(crate) fn xiso(base: u64, items: Vec<Item>) -> Image {
    let mut next = 33_u32;
    let root = place_xdvdfs(items, &mut next);
    let mut image = Image::new();
    let mut descriptor = vec![0_u8; SECTOR];
    descriptor[..20].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
    descriptor[20..24].copy_from_slice(&root.sector.to_le_bytes());
    descriptor[24..28].copy_from_slice(&root.size.to_le_bytes());
    descriptor[0x7ec..0x7ec + 20].copy_from_slice(b"MICROSOFT*XBOX*MEDIA");
    image.put(base + 32 * SECTOR as u64, &descriptor);
    write_xdvdfs_dir(&mut image, base, &root);
    image.len = image.len.max(base + u64::from(next) * SECTOR as u64);
    image
}

// ---- ISO 9660 -------------------------------------------------------------

pub(crate) fn iso_record(extent: u32, size: u32, flags: u8, name: &[u8]) -> Vec<u8> {
    let length = (33 + name.len()).div_ceil(2) * 2;
    let mut record = vec![0_u8; length];
    record[0] = length as u8;
    record[2..6].copy_from_slice(&extent.to_le_bytes());
    record[6..10].copy_from_slice(&extent.to_be_bytes());
    record[10..14].copy_from_slice(&size.to_le_bytes());
    record[14..18].copy_from_slice(&size.to_be_bytes());
    record[25] = flags;
    record[28..30].copy_from_slice(&1_u16.to_le_bytes());
    record[30..32].copy_from_slice(&1_u16.to_be_bytes());
    record[32] = name.len() as u8;
    record[33..33 + name.len()].copy_from_slice(name);
    record
}

enum INode {
    File { sector: u32, data: Vec<u8> },
    Dir(IDir),
}

struct IDir {
    sector: u32,
    size: u32,
    parent: u32,
    entries: Vec<(String, INode)>,
}

fn iso_name(name: &str, file: bool) -> Vec<u8> {
    let mut bytes = name.as_bytes().to_vec();
    if file {
        bytes.extend_from_slice(b";1");
    }
    bytes
}

fn pack_records(records: Vec<Vec<u8>>) -> Vec<u8> {
    let mut table = Vec::new();
    for record in records {
        let used = table.len() % SECTOR;
        if used + record.len() > SECTOR {
            table.resize(table.len() + SECTOR - used, 0);
        }
        table.extend_from_slice(&record);
    }
    table.resize(table.len().div_ceil(SECTOR).max(1) * SECTOR, 0);
    table
}

fn place_iso(items: Vec<Item>, parent: u32, next: &mut u32) -> IDir {
    let items = sorted(items);
    let mut sizing = vec![iso_record(0, 0, 2, &[0]), iso_record(0, 0, 2, &[1])];
    for item in &items {
        match item {
            Item::File(name, _) => sizing.push(iso_record(0, 0, 0, &iso_name(name, true))),
            Item::Dir(name, _) => sizing.push(iso_record(0, 0, 2, &iso_name(name, false))),
        }
    }
    let size = pack_records(sizing).len() as u32;
    let sector = *next;
    *next += size / SECTOR as u32;
    let parent = if parent == 0 { sector } else { parent };
    let mut entries = Vec::new();
    for item in items {
        match item {
            Item::File(name, data) => {
                let sector = *next;
                *next += sectors(data.len());
                entries.push((name, INode::File { sector, data }));
            }
            Item::Dir(name, children) => {
                entries.push((name, INode::Dir(place_iso(children, sector, next))));
            }
        }
    }
    IDir {
        sector,
        size,
        parent,
        entries,
    }
}

fn write_iso_dir(image: &mut Image, directory: &IDir) {
    let mut records = vec![
        iso_record(directory.sector, directory.size, 2, &[0]),
        iso_record(directory.parent, directory.size, 2, &[1]),
    ];
    for (name, node) in &directory.entries {
        records.push(match node {
            INode::File { sector, data } => {
                iso_record(*sector, data.len() as u32, 0, &iso_name(name, true))
            }
            INode::Dir(child) => iso_record(child.sector, child.size, 2, &iso_name(name, false)),
        });
    }
    image.put(
        u64::from(directory.sector) * SECTOR as u64,
        &pack_records(records),
    );
    for (_, node) in &directory.entries {
        match node {
            INode::File { sector, data } if !data.is_empty() => {
                image.put(u64::from(*sector) * SECTOR as u64, data);
                let end = u64::from(*sector + sectors(data.len())) * SECTOR as u64;
                image.len = image.len.max(end);
            }
            INode::Dir(child) => write_iso_dir(image, child),
            INode::File { .. } => {}
        }
    }
}

/// Build a plain ISO 9660 image (Level 1 style names, no Joliet or Rock Ridge).
pub(crate) fn iso(items: Vec<Item>) -> Image {
    let mut next = 20_u32;
    let root = place_iso(items, 0, &mut next);
    let mut image = Image::new();
    let mut descriptor = vec![0_u8; SECTOR];
    descriptor[0] = 1;
    descriptor[1..6].copy_from_slice(b"CD001");
    descriptor[6] = 1;
    descriptor[80..84].copy_from_slice(&next.to_le_bytes());
    descriptor[84..88].copy_from_slice(&next.to_be_bytes());
    descriptor[128..130].copy_from_slice(&2048_u16.to_le_bytes());
    descriptor[130..132].copy_from_slice(&2048_u16.to_be_bytes());
    descriptor[156..156 + 34].copy_from_slice(&iso_record(root.sector, root.size, 2, &[0])[..34]);
    image.put(16 * SECTOR as u64, &descriptor);
    let mut terminator = vec![0_u8; SECTOR];
    terminator[0] = 255;
    terminator[1..6].copy_from_slice(b"CD001");
    terminator[6] = 1;
    image.put(17 * SECTOR as u64, &terminator);
    write_iso_dir(&mut image, &root);
    image.len = image.len.max(u64::from(next) * SECTOR as u64);
    image
}

// ---- Anchor-file headers -------------------------------------------------

pub(crate) fn xex(title: u32) -> Vec<u8> {
    let mut bytes = vec![0_u8; 0x100];
    bytes[..4].copy_from_slice(b"XEX2");
    bytes[0x14..0x18].copy_from_slice(&2_u32.to_be_bytes());
    bytes[0x18..0x1c].copy_from_slice(&0x0000_0101_u32.to_be_bytes());
    bytes[0x20..0x24].copy_from_slice(&0x0004_0006_u32.to_be_bytes());
    bytes[0x24..0x28].copy_from_slice(&0x80_u32.to_be_bytes());
    bytes[0x80 + 12..0x80 + 16].copy_from_slice(&title.to_be_bytes());
    bytes
}

pub(crate) fn xbe(title: u32) -> Vec<u8> {
    let mut bytes = vec![0_u8; 0x400];
    bytes[..4].copy_from_slice(b"XBEH");
    bytes[0x104..0x108].copy_from_slice(&0x0001_0000_u32.to_le_bytes());
    bytes[0x118..0x11c].copy_from_slice(&0x0001_0180_u32.to_le_bytes());
    bytes[0x180 + 8..0x180 + 12].copy_from_slice(&title.to_le_bytes());
    bytes
}

pub(crate) fn sfo(disc_id: &str) -> Vec<u8> {
    let mut bytes = vec![0_u8; 0x80];
    bytes[..4].copy_from_slice(b"\0PSF");
    bytes[8..12].copy_from_slice(&0x30_u32.to_le_bytes());
    bytes[12..16].copy_from_slice(&0x40_u32.to_le_bytes());
    bytes[16..20].copy_from_slice(&1_u32.to_le_bytes());
    bytes[20..22].copy_from_slice(&0_u16.to_le_bytes());
    bytes[24..28].copy_from_slice(&(disc_id.len() as u32 + 1).to_le_bytes());
    bytes[32..36].copy_from_slice(&0_u32.to_le_bytes());
    bytes[0x30..0x30 + 8].copy_from_slice(b"DISC_ID\0");
    bytes[0x40..0x40 + disc_id.len()].copy_from_slice(disc_id.as_bytes());
    bytes
}
