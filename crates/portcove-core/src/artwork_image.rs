use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, Limits};

use crate::{PortcoveError, Result};

#[cfg(test)]
thread_local! {
    static DECODE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn decode_count() -> usize {
    DECODE_COUNT.with(std::cell::Cell::get)
}

pub(crate) const MAX_ORIGINAL_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const MAX_DECODED_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_PIXELS: u64 = 8 * 1024 * 1024;
pub(crate) const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;
pub(crate) const THUMBNAIL_WIDTH: u32 = 384;
pub(crate) const THUMBNAIL_HEIGHT: u32 = 576;

pub(crate) struct DecodedArtwork {
    pub format: crate::ArtworkImageFormat,
    pub width: u32,
    pub height: u32,
    pub thumbnail: Vec<u8>,
}

pub(crate) fn decode(bytes: &[u8]) -> Result<DecodedArtwork> {
    decode_with_thumbnail_bounds(bytes, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
}

/// Preserve the same decoder and allocation limits for every descriptive role.
/// Callers choose a bounded derivative, never a cropped or upscaled original.
pub(crate) fn decode_with_thumbnail_bounds(
    bytes: &[u8],
    thumbnail_width: u32,
    thumbnail_height: u32,
) -> Result<DecodedArtwork> {
    if thumbnail_width == 0
        || thumbnail_height == 0
        || thumbnail_width > 1280
        || thumbnail_height > 720
    {
        return Err(PortcoveError::usage(
            "artwork derivative dimensions are unsupported",
        ));
    }
    #[cfg(test)]
    DECODE_COUNT.with(|count| count.set(count.get() + 1));
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
    let thumbnail = image
        .thumbnail(thumbnail_width, thumbnail_height)
        .to_rgba8();
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

#[cfg(test)]
mod role_derivative_tests {
    use super::*;

    #[test]
    fn role_derivatives_fit_without_cropping_or_stretching() {
        let image = DynamicImage::new_rgba8(1000, 250);
        let mut input = Cursor::new(Vec::new());
        image.write_to(&mut input, ImageFormat::Png).unwrap();
        let decoded = decode_with_thumbnail_bounds(input.get_ref(), 568, 320).unwrap();
        let derivative = image::load_from_memory(&decoded.thumbnail).unwrap();
        assert_eq!((decoded.width, decoded.height), (1000, 250));
        assert_eq!((derivative.width(), derivative.height()), (568, 142));
        assert_eq!(derivative.to_rgba8().get_pixel(0, 0).0[3], 0);
        assert!(decode_with_thumbnail_bounds(input.get_ref(), 0, 320).is_err());
        assert!(decode_with_thumbnail_bounds(input.get_ref(), 1281, 720).is_err());
    }
}
