//! Presentation of the fixed progress and retained tool-capture phases emitted by Core.
//! Exact identifiers stay in diagnostic inspection; unknown progress data is not a label.

const OTHER_PHASE: &str = "Other operation phase";

pub(crate) fn phase_name(phase: &str) -> &'static str {
    match phase {
        "download" => "Downloading release files",
        "verify" => "Checking file identity",
        "copy" => "Copying game files",
        "psx-toolchain-download" => "Downloading PlayStation build tools",
        "preparation.extract" => "Extracting game files",
        "preparation.setup" => "Preparing game data",
        "install.ps1.builder" => "Building the PlayStation port",
        "metadata" => "Checking catalog metadata",
        "prepare" | "preparing" => "Preparing",
        "finishing" => "Finishing publication",
        "hash" | "hashing" => "Calculating file hashes",
        "install.cartridge.host.configure" => "Configuring cartridge translation tools",
        "install.cartridge.host.compile" => "Building cartridge translation tools",
        "install.cartridge.host.imports" => "Checking cartridge translation tool dependencies",
        "install.cartridge.configure" => "Configuring the cartridge port",
        "install.cartridge.compile" => "Building the cartridge port",
        "install.cartridge.source.configure" => "Configuring the cartridge source build",
        "install.cartridge.source.host.configure" => "Configuring game-file translation tools",
        "install.cartridge.source.host.imports" => {
            "Checking game-file translation tool dependencies"
        }
        "install.cartridge.source.generate" => "Generating native game code",
        "install.cartridge.source.headers" => "Generating native game code headers",
        "install.cartridge.source.analyzer.imports" => {
            "Checking game-file analysis tool dependencies"
        }
        "install.cartridge.source.gbarecomp.link" => "Linking game-file translation tools",
        "install.cartridge.source.AWRE.link"
        | "install.cartridge.source.EarthBoundRecomp.link"
        | "install.cartridge.source.GundamWingEndlessDuelSNESRecomp.link" => {
            "Linking the cartridge source build"
        }
        "install.cartridge.render96.tools.audiofile" => "Building Render96 audio tools",
        "install.cartridge.render96.tools" => "Building Render96 conversion tools",
        "install.cartridge.render96.level-headers" => "Generating Render96 level headers",
        "install.cartridge.render96.sound-player" => "Building the Render96 sound player",
        "install.cartridge.render96.sound" => "Preparing Render96 sound data",
        "install.cartridge.render96.object-plan" => "Checking the Render96 compilation plan",
        "install.cartridge.render96.link-plan" => "Checking the Render96 linking plan",
        "install.cartridge.render96.link" => "Linking the Render96 game",
        "install.cartridge.cvlod.generate" => "Generating Legacy of Darkness game code",
        "historical-producer-child" => "Running the historical qualification producer",
        _ => numbered_phase_name(phase),
    }
}

fn numbered_phase_name(phase: &str) -> &'static str {
    let Some((family, index)) = phase.rsplit_once('.') else {
        return OTHER_PHASE;
    };
    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return OTHER_PHASE;
    }
    match family {
        "install.cartridge.objects" => "Compiling cartridge port code",
        "install.cartridge.imports" => "Checking cartridge runtime dependencies",
        "install.cartridge.source.imports" => "Checking cartridge source build dependencies",
        "install.cartridge.source.gbarecomp.objects" => "Compiling game-file translation tools",
        "install.cartridge.source.AWRE.objects"
        | "install.cartridge.source.EarthBoundRecomp.objects"
        | "install.cartridge.source.GundamWingEndlessDuelSNESRecomp.objects" => {
            "Compiling cartridge game code from source"
        }
        "install.cartridge.render96.extract" => "Extracting Render96 game data",
        "install.cartridge.render96.textures" => "Preparing Render96 textures",
        "install.cartridge.render96.samples" => "Preparing Render96 sound samples",
        "install.cartridge.render96.compile" => "Compiling Render96 game code",
        "install.cartridge.render96.imports" => "Checking Render96 runtime dependencies",
        "install.cartridge.cvlod.prepare-original" => "Preparing Legacy of Darkness game files",
        "install.cartridge.cvlod.repair-generated" => {
            "Applying Legacy of Darkness code corrections"
        }
        "install.cartridge.cvlod.validate-generated" => {
            "Checking generated Legacy of Darkness game code"
        }
        "install.cartridge.cvlod.imports" => "Checking Legacy of Darkness runtime dependencies",
        "install.cartridge.cvlod.install-sdk" => "Preparing Legacy of Darkness build dependencies",
        "install.cartridge.cvlod.plan" => "Checking the Legacy of Darkness compilation plan",
        "install.cartridge.cvlod.compile" => "Compiling Legacy of Darkness game code",
        "install.cartridge.cvlod.configure" => "Configuring the Legacy of Darkness build",
        _ => OTHER_PHASE,
    }
}

#[cfg(test)]
mod tests {
    use super::{OTHER_PHASE, phase_name};

    #[test]
    fn shipped_cartridge_capture_phases_are_named_and_distinguish_build_steps() {
        for phase in [
            "install.cartridge.host.configure",
            "install.cartridge.host.compile",
            "install.cartridge.host.imports",
            "install.cartridge.configure",
            "install.cartridge.compile",
            "install.cartridge.source.configure",
            "install.cartridge.source.host.configure",
            "install.cartridge.source.host.imports",
            "install.cartridge.source.generate",
            "install.cartridge.source.headers",
            "install.cartridge.source.analyzer.imports",
            "install.cartridge.source.gbarecomp.link",
            "install.cartridge.source.AWRE.link",
            "install.cartridge.source.EarthBoundRecomp.link",
            "install.cartridge.source.GundamWingEndlessDuelSNESRecomp.link",
            "install.cartridge.render96.tools.audiofile",
            "install.cartridge.render96.tools",
            "install.cartridge.render96.level-headers",
            "install.cartridge.render96.sound-player",
            "install.cartridge.render96.sound",
            "install.cartridge.render96.object-plan",
            "install.cartridge.render96.link-plan",
            "install.cartridge.render96.link",
            "install.cartridge.cvlod.generate",
            "historical-producer-child",
        ] {
            assert_ne!(phase_name(phase), OTHER_PHASE, "unlabeled phase: {phase}");
            assert!(!phase_name(phase).contains("install.cartridge"));
        }
        assert_ne!(
            phase_name("install.cartridge.host.configure"),
            phase_name("install.cartridge.host.compile")
        );
        assert_ne!(
            phase_name("install.cartridge.host.imports"),
            phase_name("install.cartridge.imports.0")
        );
        assert_ne!(
            phase_name("install.cartridge.render96.object-plan"),
            phase_name("install.cartridge.render96.link-plan")
        );
        assert_ne!(
            phase_name("install.cartridge.source.gbarecomp.link"),
            phase_name("install.cartridge.source.AWRE.link")
        );
    }

    #[test]
    fn numbered_build_families_accept_only_the_emitted_identifier_shape() {
        for family in [
            "install.cartridge.objects",
            "install.cartridge.imports",
            "install.cartridge.source.imports",
            "install.cartridge.source.gbarecomp.objects",
            "install.cartridge.source.AWRE.objects",
            "install.cartridge.source.EarthBoundRecomp.objects",
            "install.cartridge.source.GundamWingEndlessDuelSNESRecomp.objects",
            "install.cartridge.render96.extract",
            "install.cartridge.render96.textures",
            "install.cartridge.render96.samples",
            "install.cartridge.render96.compile",
            "install.cartridge.render96.imports",
            "install.cartridge.cvlod.prepare-original",
            "install.cartridge.cvlod.repair-generated",
            "install.cartridge.cvlod.validate-generated",
            "install.cartridge.cvlod.imports",
            "install.cartridge.cvlod.install-sdk",
            "install.cartridge.cvlod.plan",
            "install.cartridge.cvlod.compile",
            "install.cartridge.cvlod.configure",
        ] {
            for index in ["0", "1", "79", "1024"] {
                let phase = format!("{family}.{index}");
                assert_ne!(phase_name(&phase), OTHER_PHASE, "unlabeled phase: {phase}");
            }
            for suffix in ["", "-1", "secret", "0\nforged", "0.1", "0\u{1b}"] {
                assert_eq!(phase_name(&format!("{family}.{suffix}")), OTHER_PHASE);
            }
        }
        for unknown in [
            "install.cartridge.unrecognized.0",
            "install.cartridge.source.unrecognized.objects.0",
            "install.cartridge.cvlod.unrecognized.0",
            "token=private-fixture-value\nphase",
        ] {
            assert_eq!(phase_name(unknown), OTHER_PHASE);
        }
    }
}
