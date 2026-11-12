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
    let (format, orientation, image) = match image::guess_format(bytes).map_err(image_error)? {
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), limits)
                .map_err(image_error)?;
            if decoder.is_apng().map_err(image_error)? {
                return Err(PortcoveError::unsupported(
                    "animated artwork is not supported",
                ));
            }
            let (orientation, image) = decode_bounded(decoder)?;
            (crate::ArtworkImageFormat::Png, orientation, image)
        }
        ImageFormat::Jpeg => {
            let mut decoder =
                image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes)).map_err(image_error)?;
            decoder.set_limits(limits).map_err(image_error)?;
            let (orientation, image) = decode_bounded(decoder)?;
            (crate::ArtworkImageFormat::Jpeg, orientation, image)
        }
        _ => {
            return Err(PortcoveError::unsupported(
                "choose a static PNG or JPEG image",
            ));
        }
    };
    // Width and height stay the stored pixel axes: the handoff reader compares
    // them with the decoded original. Only the preview derivative is shown as
    // displayed. Fit the stored axes to the transposed bounds, then orient the
    // small derivative, so no second full-size buffer is allocated.
    let (width, height) = (image.width(), image.height());
    let transposed = transposes(orientation);
    let (fit_width, fit_height) = if transposed {
        (thumbnail_height, thumbnail_width)
    } else {
        (thumbnail_width, thumbnail_height)
    };
    let mut thumbnail = image.thumbnail(fit_width, fit_height);
    thumbnail.apply_orientation(orientation);
    let thumbnail = thumbnail.to_rgba8();
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

/// Whether the image's embedded orientation displays it rotated by a quarter
/// turn, so its stored width and height are swapped on screen and in Steam.
pub(crate) fn transposes_axes(bytes: &[u8]) -> Result<bool> {
    let orientation = match image::guess_format(bytes).map_err(image_error)? {
        ImageFormat::Png => image::codecs::png::PngDecoder::new(Cursor::new(bytes))
            .map_err(image_error)?
            .orientation(),
        ImageFormat::Jpeg => image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes))
            .map_err(image_error)?
            .orientation(),
        _ => return Ok(false),
    }
    .map_err(image_error)?;
    Ok(transposes(orientation))
}

fn transposes(orientation: image::metadata::Orientation) -> bool {
    use image::metadata::Orientation;
    matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    )
}

fn decode_bounded(
    mut decoder: impl ImageDecoder,
) -> Result<(image::metadata::Orientation, DynamicImage)> {
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
    let orientation = decoder.orientation().map_err(image_error)?;
    let image = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    Ok((orientation, image))
}

fn image_error(error: image::ImageError) -> PortcoveError {
    PortcoveError::verification("artwork could not be decoded as a supported bounded image")
        .detail("image_error", error.to_string())
}

/// Encode `pixels` as a JPEG tagged with EXIF Orientation=6 (rotate 90
/// clockwise), so it is displayed with its stored axes swapped.
#[cfg(test)]
pub(crate) fn quarter_turn_jpeg(pixels: &image::RgbImage) -> Vec<u8> {
    use image::ImageEncoder;
    let exif = [
        b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
    ];
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100);
    encoder.set_exif_metadata(exif.to_vec()).unwrap();
    encoder
        .write_image(
            pixels.as_raw(),
            pixels.width(),
            pixels.height(),
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    bytes
}

#[cfg(test)]
mod role_derivative_tests {
    use super::*;

    #[test]
    fn thumbnails_show_the_displayed_orientation_while_keeping_stored_axes() {
        // Stored 400x120: left half red, right half blue. Orientation=6 turns
        // the stored left edge into the displayed top edge.
        let pixels = image::RgbImage::from_fn(400, 120, |x, _| {
            if x < 200 {
                image::Rgb([220, 20, 20])
            } else {
                image::Rgb([20, 20, 220])
            }
        });
        let bytes = quarter_turn_jpeg(&pixels);
        assert!(transposes_axes(&bytes).unwrap());
        let decoded = decode(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (400, 120));
        let thumbnail = image::load_from_memory(&decoded.thumbnail)
            .unwrap()
            .to_rgba8();
        let (width, height) = thumbnail.dimensions();
        assert!(height > width, "{width}x{height}");
        assert!(width <= THUMBNAIL_WIDTH && height <= THUMBNAIL_HEIGHT);
        let top = thumbnail.get_pixel(width / 2, height / 8).0;
        let bottom = thumbnail.get_pixel(width / 2, height * 7 / 8).0;
        assert!(top[0] > 150 && top[2] < 100, "{top:?}");
        assert!(bottom[2] > 150 && bottom[0] < 100, "{bottom:?}");
        // An untagged image keeps its stored orientation.
        let mut plain = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(pixels)
            .write_to(&mut plain, ImageFormat::Png)
            .unwrap();
        let plain = decode(plain.get_ref()).unwrap();
        let derivative = image::load_from_memory(&plain.thumbnail).unwrap();
        assert!(derivative.width() > derivative.height());
    }

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
