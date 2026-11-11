use super::*;
use crate::{
    ErrorCode,
    disc_filesystem::{DiscImage, MAX_IMAGE_BYTES, fixtures::*},
};

fn nothing() -> crate::Result<()> {
    Ok(())
}

#[test]
fn parsers_read_only_the_documented_fields() {
    assert_eq!(xex_title_id(&xex(0x4D53_07E6)).unwrap(), "4D5307E6");
    assert_eq!(xbe_title_id(&xbe(0x4D53_0004)).unwrap(), "4D530004");
    assert_eq!(
        ps2_serial(b"BOOT2 = cdrom0:\\SLUS_200.62;1\r\nVER = 1.00\r\n").unwrap(),
        "SLUS-20062"
    );
    assert_eq!(psp_disc_id(&sfo("UCUS98612")).unwrap(), "UCUS-98612");
    for bad in [&b""[..], b"XEX2", b"XBEH", b"\0PSF"] {
        assert!(xex_title_id(bad).is_err() || bad != b"XEX2");
        assert!(xbe_title_id(bad).is_err());
        assert!(psp_disc_id(bad).is_err());
    }
    assert!(ps2_serial(b"VER = 1.00\r\n").is_err());
    assert!(ps2_serial(b"BOOT2 = cdrom0:\\NOTASERIAL;1").is_err());
    assert!(xex_title_id(b"XEX2").is_err());
}

#[test]
fn codes_compare_by_letters_and_digits() {
    assert!(same_code("slus-20062", "SLUS_200.62"));
    assert!(same_code("4d5307e6", "4D5307E6"));
    assert!(!same_code("SLES-50330", "SLUS-20062"));
    assert!(!same_code("", ""));
}

fn disc(format: DiscImageFormat, image: Image) -> (tempfile::TempDir, DiscImage) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("image.bin");
    image.write_to(&path);
    let disc = DiscImage::open(&path, format, MAX_IMAGE_BYTES).unwrap();
    (directory, disc)
}

#[test]
fn a_matching_disc_is_recognized_and_a_wrong_one_is_refused_with_both_codes() {
    let declared = vec!["SLUS-20062".to_owned()];
    let (_keep, mut right) = disc(
        DiscImageFormat::Iso9660,
        iso(vec![file(
            "SYSTEM.CNF",
            b"BOOT2 = cdrom0:\\SLUS_200.62;1\r\n",
        )]),
    );
    assert_eq!(
        require_product_code(&mut right, DiscImageFormat::Iso9660, &declared, &nothing).unwrap(),
        "SLUS-20062"
    );
    let (_keep, mut wrong) = disc(
        DiscImageFormat::Iso9660,
        iso(vec![file(
            "SYSTEM.CNF",
            b"BOOT2 = cdrom0:\\SLES_503.30;1\r\n",
        )]),
    );
    let error = require_product_code(&mut wrong, DiscImageFormat::Iso9660, &declared, &nothing)
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Verification);
    assert_eq!(error.details["found"], "SLES-50330");
    assert_eq!(error.details["expected"], "SLUS-20062");
    let report = error.report();
    assert!(
        report
            .presentation
            .summary
            .contains("found SLES-50330, needs SLUS-20062"),
        "{}",
        report.presentation.summary
    );
}

#[test]
fn xbox_and_psp_anchors_are_read_through_the_image() {
    let (_keep, mut xbox) = disc(
        DiscImageFormat::Xdvdfs,
        xiso(0, vec![file("default.xex", &xex(0x4D53_07E6))]),
    );
    assert_eq!(
        read_product_code(&mut xbox, DiscImageFormat::Xdvdfs, &nothing)
            .unwrap()
            .as_deref(),
        Some("4D5307E6")
    );
    let (_keep, mut original) = disc(
        DiscImageFormat::Xdvdfs,
        xiso(0, vec![file("default.xbe", &xbe(0x4D53_0004))]),
    );
    assert_eq!(
        read_product_code(&mut original, DiscImageFormat::Xdvdfs, &nothing)
            .unwrap()
            .as_deref(),
        Some("4D530004")
    );
    let (_keep, mut psp) = disc(
        DiscImageFormat::Iso9660,
        iso(vec![dir(
            "PSP_GAME",
            vec![file("PARAM.SFO", &sfo("UCUS98612"))],
        )]),
    );
    assert_eq!(
        read_product_code(&mut psp, DiscImageFormat::Iso9660, &nothing)
            .unwrap()
            .as_deref(),
        Some("UCUS-98612")
    );
    let (_keep, mut empty) = disc(
        DiscImageFormat::Iso9660,
        iso(vec![file("README.TXT", b"x")]),
    );
    assert_eq!(
        read_product_code(&mut empty, DiscImageFormat::Iso9660, &nothing).unwrap(),
        None
    );
}
