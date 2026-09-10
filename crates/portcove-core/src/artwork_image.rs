use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, Limits};

use crate::{PortcoveError, Result};

pub(crate) const MAX_ORIGINAL_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_DECODED_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_PIXELS: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;

pub(crate) struct DecodedArtwork {
    pub format: crate::ArtworkImageFormat,
    pub width: u32,
    pub height: u32,
    pub thumbnail: Vec<u8>,
}

pub(crate) fn decode(bytes: &[u8]) -> Result<DecodedArtwork> {
    if bytes.len() as u64 > MAX_ORIGINAL_BYTES {
        return Err(PortcoveError::verification(
            "artwork exceeds the encoded byte limit",
        ));
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    let (format, image) = match image::guess_format(bytes).map_err(image_error)? {
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits)
                .map_err(image_error)?;
            if decoder.is_apng().map_err(image_error)? {
                return Err(PortcoveError::unsupported(
                    "animated artwork is not supported",
                ));
            }
            (crate::ArtworkImageFormat::Png, decode_bounded(decoder)?)
        }
        ImageFormat::Jpeg => {
            let mut decoder =
                image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).map_err(image_error)?;
            decoder.set_limits(limits).map_err(image_error)?;
            (crate::ArtworkImageFormat::Jpeg, decode_bounded(decoder)?)
        }
        _ => {
            return Err(PortcoveError::unsupported(
                "choose a static PNG or JPEG image",
            ));
        }
    };
    let (width, height) = (image.width(), image.height());
    let thumbnail = image.thumbnail(384, 576).to_rgba8();
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(thumbnail)
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(image_error)?;
    let thumbnail = encoded.into_inner();
    if thumbnail.len() as u64 > MAX_THUMBNAIL_BYTES {
        return Err(PortcoveError::verification(
            "artwork thumbnail exceeds its byte limit",
        ));
    }
    Ok(DecodedArtwork {
        format,
        width,
        height,
        thumbnail,
    })
}

fn decode_bounded(decoder: impl ImageDecoder) -> Result<DynamicImage> {
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > MAX_PIXELS
        || decoder.total_bytes() > MAX_DECODED_BYTES
    {
        return Err(PortcoveError::verification(
            "artwork exceeds the decoded image limits",
        ));
    }
    // Bound the destination allocation explicitly: decoder limits alone do not
    // establish DynamicImage's destination-buffer budget.
    DynamicImage::from_decoder(decoder).map_err(image_error)
}

fn image_error(error: image::ImageError) -> PortcoveError {
    PortcoveError::verification("artwork could not be decoded as a supported bounded image")
        .detail("image_error", error.to_string())
}
