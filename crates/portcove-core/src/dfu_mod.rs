//! Inert inspection of a finite Daggerfall Unity texture-bundle format.
//!
//! DFU uses the AssetBundle container names to find its manifest and possible
//! program text. Match the entire container to the serialized object table,
//! including objects absent from the container. Parse only the reviewed
//! Unity 2019.4.40f1 desktop layouts and only in memory.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use lzma_turbo::{FinishMode, LzmaDecoder, LzmaProps, LzmaReader, Status};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{ModPackageInspection, Platform, PortcoveError, Result};

const UNITY_VERSION: &str = "2019.4.40f1";
const DFU_VERSION: &str = "1.1.1";
const MOD_EXTENSION: &str = ".dfmod";
// Enough for one uncompressed 2048x2048 RGBA texture plus other small assets.
pub(crate) const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_METADATA: usize = 32 * 1024;
const MAX_OBJECTS: usize = 128;
const MAX_LZMA_MEMORY: u64 = 16 * 1024 * 1024;

pub(crate) struct DfuModInspection {
    pub(crate) package: ModPackageInspection,
    pub(crate) guid: String,
    pub(crate) title: String,
    /// Native filenames without the extension, compared ordinally by DFU.
    pub(crate) optional_dependencies: Vec<String>,
}

fn invalid(reason: &str) -> PortcoveError {
    PortcoveError::verification(format!("Daggerfall Unity mod cannot be imported: {reason}"))
}

fn require(condition: bool, reason: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(invalid(reason))
    }
}

struct Input<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Input<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| invalid("invalid offset"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid("truncated data"))?;
        self.offset = end;
        Ok(bytes)
    }

    fn fixed<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self
            .take(N)?
            .try_into()
            .expect("take returns the requested width"))
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.fixed::<1>()?[0])
    }

    fn be32(&mut self) -> Result<usize> {
        Ok(u32::from_be_bytes(self.fixed()?) as usize)
    }

    fn be64(&mut self) -> Result<usize> {
        usize::try_from(u64::from_be_bytes(self.fixed()?)).map_err(|_| invalid("unsupported size"))
    }

    fn le32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.fixed()?))
    }

    fn id(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.fixed()?))
    }

    fn count(&mut self, maximum: usize) -> Result<usize> {
        let count = self.le32()? as usize;
        require(count <= maximum, "record count exceeds the supported limit")?;
        Ok(count)
    }

    fn zero(&mut self, len: usize) -> Result<()> {
        require(
            self.take(len)?.iter().all(|byte| *byte == 0),
            "unexpected flags or padding",
        )
    }

    fn align(&mut self, alignment: usize) -> Result<()> {
        self.zero(self.offset.next_multiple_of(alignment) - self.offset)
    }

    fn terminated(&mut self, maximum: usize) -> Result<&'a str> {
        let len = self.bytes[self.offset..]
            .iter()
            .take(maximum + 1)
            .position(|byte| *byte == 0)
            .ok_or_else(|| invalid("unterminated or oversized name"))?;
        let bytes = self.take(len + 1)?;
        std::str::from_utf8(&bytes[..len]).map_err(|_| invalid("invalid UTF-8 name"))
    }

    fn string(&mut self, maximum: usize) -> Result<&'a str> {
        let len = self.count(maximum)?;
        let bytes = self.take(len)?;
        self.align(4)?;
        std::str::from_utf8(bytes).map_err(|_| invalid("invalid UTF-8 string"))
    }

    fn finish(self) -> Result<()> {
        require(
            self.offset == self.bytes.len(),
            "unrecognized trailing data",
        )
    }
}

fn lz4_length(input: &mut Input<'_>, mut length: usize, limit: usize) -> Result<usize> {
    if length == 15 {
        loop {
            let next = input.byte()? as usize;
            length += next;
            require(length <= limit, "LZ4 sequence exceeds its declared size")?;
            if next != 255 {
                break;
            }
        }
    }
    Ok(length)
}

// The observed UnityFS directory employs raw LZ4 blocks. No frame parser is
// needed. Validate each literal, distance and output bound before copying,
// including the final literal run and match start required by LZ4 blocks.
fn lz4_block(bytes: &[u8], decoded_size: usize) -> Result<Vec<u8>> {
    let mut input = Input::new(bytes);
    let mut decoded = Vec::with_capacity(decoded_size);
    loop {
        let token = input.byte()?;
        let literals = lz4_length(&mut input, (token >> 4) as usize, decoded_size)?;
        require(
            literals <= decoded_size - decoded.len(),
            "LZ4 literal exceeds its output",
        )?;
        decoded.extend_from_slice(input.take(literals)?);
        if input.offset == bytes.len() {
            require(
                decoded.len() == decoded_size,
                "LZ4 block has a different output size",
            )?;
            require(
                literals == decoded_size || literals >= 5,
                "LZ4 match must be followed by at least five final literals",
            )?;
            return Ok(decoded);
        }
        require(
            decoded_size - decoded.len() >= 12,
            "LZ4 match starts too near the end of the block",
        )?;
        let distance = u16::from_le_bytes(input.fixed()?) as usize;
        let copied = lz4_length(&mut input, (token & 15) as usize, decoded_size)? + 4;
        require(
            distance != 0 && distance <= decoded.len() && copied <= decoded_size - decoded.len(),
            "invalid LZ4 match",
        )?;
        for _ in 0..copied {
            decoded.push(decoded[decoded.len() - distance]);
        }
    }
}

fn decompress(bytes: &[u8], decoded_size: usize, method: u16) -> Result<Vec<u8>> {
    match method {
        0 if bytes.len() == decoded_size => Ok(bytes.to_vec()),
        1 => {
            let mut input = Input::new(bytes);
            let properties = LzmaProps::parse(&input.fixed()?)
                .map_err(|_| invalid("invalid LZMA properties"))?;
            require(
                LzmaReader::<&[u8]>::memory_required(properties) <= MAX_LZMA_MEMORY,
                "LZMA dictionary exceeds the allocation limit",
            )?;
            let mut decoder = LzmaDecoder::new(properties)
                .map_err(|_| invalid("could not prepare LZMA decoder"))?;
            let compressed = &bytes[input.offset..];
            let mut decoded = vec![0; decoded_size];
            let result = decoder
                .decode(compressed, &mut decoded, FinishMode::End)
                .map_err(|_| invalid("invalid LZMA block"))?;
            require(
                result.read == compressed.len()
                    && result.written == decoded_size
                    && matches!(
                        result.status,
                        Status::FinishedWithMark | Status::MaybeFinishedWithoutMark
                    ),
                "LZMA block did not end at its declared sizes",
            )?;
            Ok(decoded)
        }
        2 | 3 => lz4_block(bytes, decoded_size),
        _ => Err(invalid("unsupported compression")),
    }
}

fn read_bundle(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut input = Input::new(bytes);
    require(
        input.terminated(16)? == "UnityFS"
            && input.be32()? == 7
            && input.terminated(32)? == "5.x.x"
            && input.terminated(32)? == UNITY_VERSION
            && input.be64()? == bytes.len(),
        "unsupported UnityFS header or engine version",
    )?;
    let packed = input.be32()?;
    let unpacked = input.be32()?;
    let flags = input.be32()?;
    require(
        (1..=MAX_METADATA).contains(&packed)
            && (1..=MAX_METADATA).contains(&unpacked)
            && matches!(flags, 0x40 | 0x42 | 0x43),
        "unsupported UnityFS index encoding or size",
    )?;
    input.align(16)?;
    let metadata = decompress(input.take(packed)?, unpacked, (flags & 0x3f) as u16)?;
    let mut index = Input::new(&metadata);
    index.zero(16)?;
    let count = index.be32()?;
    require(
        (1..=256).contains(&count),
        "unsupported UnityFS block count",
    )?;
    let mut blocks = Vec::with_capacity(count);
    let mut total = 0;
    for _ in 0..count {
        let decoded = index.be32()?;
        let encoded = index.be32()?;
        let method = u16::from_be_bytes(index.fixed()?);
        require(
            (1..=MAX_BYTES as usize - total).contains(&decoded)
                && (1..=MAX_BYTES as usize).contains(&encoded)
                && method & !0x43 == 0,
            "unsupported UnityFS block size or flags",
        )?;
        total += decoded;
        blocks.push((decoded, encoded, method & 0x3f));
    }
    require(
        index.be32()? == 1 && index.be64()? == 0 && index.be64()? == total && index.be32()? == 4,
        "UnityFS must contain one complete serialized file",
    )?;
    let cab = index.terminated(36)?;
    require(
        cab.strip_prefix("CAB-").is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        }),
        "invalid serialized member name",
    )?;
    index.finish()?;
    let mut data = Vec::with_capacity(total);
    for (decoded, encoded, method) in blocks {
        data.extend(decompress(input.take(encoded)?, decoded, method)?);
    }
    input.finish()?;
    Ok(data)
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
enum ObjectKind {
    Texture,
    Bundle,
    Text,
}

impl ObjectKind {
    // Fingerprints cover the full serialized type description, including its
    // Unity type hash, tree strings and empty dependency list. These describe
    // the three engine layouts, independent of any mod, texture or manifest.
    fn read(input: &mut Input<'_>) -> Result<Self> {
        let start = input.offset;
        let (kind, layout) = match input.le32()? {
            28 => (
                Self::Texture,
                "3b7cd5c3c8e78311f3d56d3f244729d0c085c210cab671af724ab19c6308fc12",
            ),
            142 => (
                Self::Bundle,
                "57391d757c605bccb741cc272de2ba3655466bb0dcb719a3359a5155dfc05e5a",
            ),
            49 => (
                Self::Text,
                "a0c83efec4c718ba2b8d15a8f3967afb20602b79ec6f1b00d45a8c3ff1b5403f",
            ),
            _ => return Err(invalid("unreviewed Unity object type")),
        };
        input.take(19)?;
        let nodes = input.count(128)?;
        let strings = input.count(4096)?;
        input.take(nodes * 32 + strings)?;
        input.zero(4)?;
        require(
            hex::encode(Sha256::digest(&input.bytes[start..input.offset])) == layout,
            "unreviewed Unity object layout",
        )?;
        Ok(kind)
    }
}

struct Object<'a> {
    kind: ObjectKind,
    bytes: &'a [u8],
}

fn read_objects(data: &[u8], platform: Platform) -> Result<BTreeMap<i64, Object<'_>>> {
    let target = match platform {
        Platform::WindowsX86_64 => 5,
        Platform::LinuxX86_64 => 24,
        _ => return Err(invalid("unsupported Daggerfall Unity mod platform")),
    };
    let mut header = Input::new(data);
    let metadata_size = header.be32()?;
    require(
        (1..=MAX_METADATA).contains(&metadata_size)
            && header.be32()? == data.len()
            && header.be32()? == 21,
        "unsupported Unity serialized structure",
    )?;
    let data_offset = header.be32()?;
    header.zero(4)?;
    let mut info = Input::new(header.take(metadata_size)?);
    require(
        header.offset <= data_offset && data_offset - header.offset <= 4096,
        "invalid Unity serialized data offset",
    )?;
    header.zero(data_offset - header.offset)?;
    let payload = &data[data_offset..];
    require(
        info.terminated(32)? == UNITY_VERSION && info.le32()? == target && info.byte()? == 1,
        "bundle was built for a different engine, platform or type layout",
    )?;
    let types = (0..info.count(3)?)
        .map(|_| ObjectKind::read(&mut info))
        .collect::<Result<Vec<_>>>()?;
    require(
        types.iter().collect::<BTreeSet<_>>().len() == types.len(),
        "duplicate Unity type declaration",
    )?;
    let mut objects = BTreeMap::new();
    let mut ranges = Vec::new();
    for _ in 0..info.count(MAX_OBJECTS)? {
        info.align(4)?;
        let id = info.id()?;
        let start = info.le32()? as usize;
        let size = info.le32()? as usize;
        let kind = *types
            .get(info.le32()? as usize)
            .ok_or_else(|| invalid("unknown Unity object type reference"))?;
        let end = start
            .checked_add(size)
            .ok_or_else(|| invalid("invalid Unity object range"))?;
        let bytes = payload
            .get(start..end)
            .ok_or_else(|| invalid("invalid Unity object range"))?;
        require(
            id != 0 && start % 4 == 0 && size > 0,
            "invalid Unity object identity",
        )?;
        require(
            objects.insert(id, Object { kind, bytes }).is_none(),
            "duplicate Unity object identity",
        )?;
        ranges.push((start, end));
    }
    // External script records, external files, reference types and user data.
    info.zero(13)?;
    info.finish()?;
    ranges.sort_unstable();
    let mut pos = 0;
    for (start, end) in ranges {
        require(
            start >= pos && start - pos < 8 && payload[pos..start].iter().all(|byte| *byte == 0),
            "overlapping or unindexed Unity asset data",
        )?;
        pos = end;
    }
    require(pos == payload.len(), "unindexed trailing Unity asset data")?;
    Ok(objects)
}

fn safe_path(path: &str) -> Result<String> {
    crate::archive::validate_relative_path(path, false)
        .map(|(_, key)| key)
        .map_err(|_| invalid("unsafe native mod path"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "PascalCase")]
struct Dependency {
    name: String,
    is_optional: bool,
    #[serde(default)]
    is_peer: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "PascalCase")]
struct Manifest {
    #[serde(rename = "GUID")]
    guid: String,
    #[serde(rename = "DFUnity_Version")]
    runtime_version: String,
    mod_title: String,
    mod_version: String,
    #[serde(rename = "ModAuthor")]
    _author: String,
    #[serde(default, rename = "ContactInfo")]
    _contact: String,
    #[serde(default, rename = "ModDescription")]
    _description: String,
    files: Vec<String>,
    #[serde(default)]
    dependencies: Vec<Dependency>,
}

fn leaf(path: &str) -> &str {
    path.rsplit('/')
        .next()
        .expect("split always returns a component")
}

fn read_manifest(object: &Object<'_>, path: &str) -> Result<Manifest> {
    let mut input = Input::new(object.bytes);
    let name = input.string(128)?.to_ascii_lowercase();
    require(
        leaf(path).strip_suffix(".json") == Some(name.as_str()) && name.ends_with(MOD_EXTENSION),
        "the only supported text asset is the native mod manifest",
    )?;
    let json = input.string(MAX_METADATA)?;
    input.finish()?;
    serde_json::from_str(json).map_err(|_| invalid("invalid or unsupported DFU mod manifest"))
}

fn review_texture(object: &Object<'_>, path: &str) -> Result<()> {
    let mut input = Input::new(object.bytes);
    let name = input.string(128)?;
    require(
        leaf(path)
            .strip_suffix(".png")
            .is_some_and(|stem| stem.eq_ignore_ascii_case(name)),
        "the texture and native asset names differ",
    )?;
    require(input.le32()? == 4, "unsupported texture fallback format")?;
    input.zero(4)?;
    let width = input.count(2048)?;
    let height = input.count(2048)?;
    let pixels = width * height * 4;
    require(
        width > 0
            && height > 0
            && input.le32()? as usize == pixels
            && input.le32()? == 4
            && input.le32()? == 1,
        "only inline single-level RGBA textures are supported",
    )?;
    // Readable flag plus three unused pre-processing and streaming flags.
    require(
        matches!(input.fixed::<4>()?, [0 | 1, 0, 0, 0]),
        "unsupported texture flags",
    )?;
    input.zero(4)?;
    require(
        input.le32()? == 1 && input.le32()? == 2,
        "unsupported texture dimension",
    )?;
    require(
        input.le32()? <= 2
            && input.le32()? <= 16
            && f32::from_bits(input.le32()?).is_finite()
            && input.le32()? <= 3
            && input.le32()? <= 3
            && input.le32()? <= 3,
        "invalid texture sampling parameters",
    )?;
    require(
        input.le32()? == 0 && input.le32()? <= 1 && input.le32()? as usize == pixels,
        "inconsistent texture data size",
    )?;
    input.take(pixels)?;
    input.zero(12)?; // No inline offset, external stream, or external path.
    input.finish()
}

fn local_object(input: &mut Input<'_>) -> Result<i64> {
    input.zero(4)?;
    input.id()
}

fn inspect_objects(
    objects: &BTreeMap<i64, Object<'_>>,
    file_name: &str,
) -> Result<(Manifest, Vec<String>)> {
    let bundles: Vec<_> = objects
        .values()
        .filter(|object| object.kind == ObjectKind::Bundle)
        .collect();
    let [bundle] = bundles.as_slice() else {
        return Err(invalid("expected exactly one AssetBundle index"));
    };
    let mut index = Input::new(bundle.bytes);
    require(
        index.string(128)? == file_name,
        "use the mod's original file name",
    )?;
    let asset_count = objects.len() - 1;
    require(
        index.count(MAX_OBJECTS)? == asset_count,
        "unindexed Unity preload object",
    )?;
    let preload = (0..asset_count)
        .map(|_| local_object(&mut index))
        .collect::<Result<Vec<_>>>()?;
    require(
        index.count(MAX_OBJECTS)? == asset_count,
        "unindexed Unity container object",
    )?;
    let mut names = BTreeSet::new();
    let mut used = BTreeSet::new();
    let mut texture_paths = BTreeSet::new();
    let mut native_assets = BTreeSet::new();
    let mut manifest = None;
    for _ in 0..asset_count {
        let raw = index.string(512)?;
        let path = safe_path(raw)?;
        let id_index = index.count(MAX_OBJECTS)?;
        let preload_size = index.le32()?;
        let id = local_object(&mut index)?;
        require(
            raw == path
                && path.starts_with("assets/game/mods/")
                && names.insert(leaf(&path).to_owned())
                && preload_size == 1
                && preload.get(id_index) == Some(&id)
                && used.insert(id),
            "invalid or conflicting Unity asset name or reference",
        )?;
        let object = objects
            .get(&id)
            .ok_or_else(|| invalid("bundle references an unknown Unity object"))?;
        match object.kind {
            ObjectKind::Texture => {
                review_texture(object, &path)?;
                native_assets.insert(leaf(&path).to_owned());
                texture_paths.insert(path);
            }
            ObjectKind::Text if path.ends_with(".dfmod.json") && manifest.is_none() => {
                manifest = Some(read_manifest(object, &path)?);
            }
            _ => {
                return Err(invalid(
                    "the bundle contains code or another unsupported object",
                ));
            }
        }
    }
    index.zero(20)?; // Empty main asset.
    require(
        index.le32()? == 1 && index.string(128)? == file_name,
        "invalid AssetBundle identity",
    )?;
    index.zero(12)?; // No bundle dependencies, streamed scenes or explicit layout.
    require(index.le32()? == 7, "unsupported AssetBundle path flags")?;
    index.zero(4)?; // No scene hashes.
    index.finish()?;
    let manifest = manifest.ok_or_else(|| invalid("missing native mod manifest"))?;
    require(!texture_paths.is_empty(), "no supported texture assets")?;
    let declared = manifest
        .files
        .iter()
        .map(|path| safe_path(path))
        .collect::<Result<BTreeSet<_>>>()?;
    require(
        declared == texture_paths && declared.len() == manifest.files.len(),
        "the manifest and inspected asset inventory differ",
    )?;
    Ok((manifest, native_assets.into_iter().collect()))
}

pub(crate) fn inspect_data_only(path: &Path, platform: Platform) -> Result<DfuModInspection> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.len() <= 128)
        .ok_or_else(|| invalid("choose an original .dfmod file"))?;
    // DFU 1.1.1 removes every exact lowercase extension token, and
    // reconstructing the name must produce the original native filename.
    let stem = file_name
        .strip_suffix(MOD_EXTENSION)
        .filter(|stem| !stem.is_empty() && !stem.contains(MOD_EXTENSION))
        .ok_or_else(|| invalid("choose an original .dfmod file with one extension"))?;
    safe_path(file_name)?;
    let bytes = crate::external_runtime::read_single_link_metadata(path, MAX_BYTES)?;
    let decoded = read_bundle(&bytes)?;
    let objects = read_objects(&decoded, platform)?;
    let (manifest, asset_paths) = inspect_objects(&objects, file_name)?;
    let guid = Uuid::parse_str(&manifest.guid)
        .ok()
        .filter(|id| !id.is_nil())
        .map(|id| id.hyphenated().to_string())
        .filter(|id| *id == manifest.guid)
        .ok_or_else(|| invalid("a canonical mod GUID is required"))?;
    require(
        manifest.runtime_version == DFU_VERSION
            && (1..=128).contains(&manifest.mod_title.len())
            && manifest.mod_title.trim() == manifest.mod_title
            && manifest.mod_title.is_ascii()
            && !manifest.mod_title.chars().any(char::is_control)
            && (1..=64).contains(&manifest.mod_version.len())
            && manifest
                .mod_version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte)),
        "invalid mod identity or unsupported DFU version",
    )?;
    let mut dependency_names = BTreeSet::new();
    require(
        manifest.dependencies.len() <= 16
            && manifest.dependencies.iter().all(|dep| {
                dep.is_optional
                    && !dep.is_peer
                    && dep.name.len() <= 128
                    && !dep.name.contains('/')
                    && safe_path(&dep.name).is_ok()
                    && !dep.name.contains(MOD_EXTENSION)
                    && !stem.eq_ignore_ascii_case(&dep.name)
                    && dependency_names.insert(dep.name.to_ascii_lowercase())
            }),
        "required, peer or ambiguous mod dependencies need separate support",
    )?;
    Ok(DfuModInspection {
        guid,
        title: manifest.mod_title,
        optional_dependencies: manifest
            .dependencies
            .into_iter()
            .map(|dep| dep.name)
            .collect(),
        package: ModPackageInspection {
            file_name: file_name.into(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            size: bytes.len() as u64,
            entry_count: asset_paths.len(),
            declared_uncompressed_bytes: decoded.len() as u64,
            asset_paths,
            executable_entries: Vec::new(),
            holds: Vec::new(),
        },
    })
}

#[cfg(test)]
#[path = "dfu_mod_tests.rs"]
mod tests;
