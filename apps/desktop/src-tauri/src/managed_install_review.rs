//! Keep the desktop's selected draft aligned with Core's registered-input review.
use crate::desktop_contract::InstallInput;
use portcove_core::{PortcoveError, ReleaseChannel, Result};
use std::path::Path;

pub(crate) fn require_matching_input(
    input: &InstallInput,
    channel: ReleaseChannel,
    registered_source: Option<&Path>,
) -> Result<()> {
    if input.bios.is_some() {
        return Err(PortcoveError::usage(
            "This game does not use a BIOS. Clear the BIOS selection and review installation again.",
        ));
    }
    if input.channel.is_some_and(|selected| selected != channel) {
        return Err(PortcoveError::conflict(
            "The selected update channel differs from the saved channel. Save the channel and review installation again.",
        ));
    }
    if let Some(selected) = &input.source {
        let registered = registered_source.ok_or_else(|| {
            PortcoveError::source(
                "Check and register the selected original game file before reviewing installation.",
            )
        })?;
        if std::fs::canonicalize(selected)? != std::fs::canonicalize(registered)? {
            return Err(PortcoveError::conflict(
                "The selected original game file differs from the registered file. Check and register the selected file, then review installation again.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_original_and_channel_cannot_be_silently_replaced() {
        let root = tempfile::tempdir().unwrap();
        let registered = root.path().join("registered.gbc");
        let replacement = root.path().join("replacement.gbc");
        std::fs::write(&registered, b"same original bytes").unwrap();
        std::fs::write(&replacement, b"same original bytes").unwrap();
        let mut input = InstallInput {
            port_id: "resident-evil-gaiden-recomp".into(),
            channel: Some(ReleaseChannel::Stable),
            source: Some(replacement),
            bios: None,
            stage: false,
            source_reference: None,
        };
        assert!(require_matching_input(&input, ReleaseChannel::Stable, Some(&registered)).is_err());
        input.source = Some(root.path().join(".").join("registered.gbc"));
        assert!(require_matching_input(&input, ReleaseChannel::Stable, Some(&registered)).is_ok());
        assert!(require_matching_input(&input, ReleaseChannel::Stable, None).is_err());
        input.channel = Some(ReleaseChannel::Beta);
        assert!(require_matching_input(&input, ReleaseChannel::Stable, Some(&registered)).is_err());
        input.channel = None;
        input.bios = Some(registered.clone());
        assert!(require_matching_input(&input, ReleaseChannel::Stable, Some(&registered)).is_err());
    }
}
