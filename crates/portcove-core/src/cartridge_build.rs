//! Read-only compatibility for already-created cartridge runtimes.
//! Variants remain in retained installation contracts; they grant no creation.
use crate::{PortDefinition, PortcoveError, Result, SourceProfile};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "cartridge_build_tests.rs"]
pub(crate) mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CartridgeBuildRecipe {
    #[serde(rename = "yoshis-cookie-nes-cycle-v1.1.0")]
    YoshisCookieNesCycle110,
    #[serde(rename = "dr-mario-nes-cycle-v1.3.0-usa")]
    DrMarioNesCycle130Usa,
    #[serde(rename = "advance-wars-gba-source-cb3facb53b6b-usa-rev1")]
    AdvanceWarsGbaSourceV1,
    #[serde(rename = "earthbound-snes-source-fe1155dc26ff-usa")]
    EarthBoundSnesSourceV1,
    #[serde(rename = "render96-us-source-48da5c491c8a")]
    Render96UsSourceV1,
    #[serde(rename = "gundam-wing-snes-source-c7aaaa152192-japan-offline")]
    GundamWingSnesSourceV1,
    #[serde(rename = "cvlod-n64-source-cb8548d145a1-ui-lifetime-v1")]
    CvlodSourceV1,
}

pub(crate) const RECEIPT: &str = ".portcove-cartridge-build.json";

pub(crate) fn retired_creation() -> PortcoveError {
    PortcoveError::unsupported(
        "This custom runtime builder is retired. Keep using an existing installed version, or prepare the game with upstream's tools and register its executable. Portcove does not replace the existing runtime.",
    )
}

impl CartridgeBuildRecipe {
    pub(crate) fn original_filename(self) -> &'static str {
        match self {
            Self::YoshisCookieNesCycle110 | Self::DrMarioNesCycle130Usa => "game.nes",
            Self::AdvanceWarsGbaSourceV1 => "game.gba",
            Self::EarthBoundSnesSourceV1 | Self::GundamWingSnesSourceV1 => "game.sfc",
            Self::Render96UsSourceV1 => "baserom.us.z64",
            Self::CvlodSourceV1 => ".portcove-cvlod-build-original.z64",
        }
    }

    pub(crate) fn fixed_launch_arguments_only(self) -> bool {
        !matches!(
            self,
            Self::YoshisCookieNesCycle110 | Self::DrMarioNesCycle130Usa
        )
    }

    pub(crate) fn require_runtime_environment(self) -> Result<()> {
        self.require_environment(std::env::vars_os())
    }

    fn require_environment(
        self,
        environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    ) -> Result<()> {
        if matches!(
            self,
            Self::YoshisCookieNesCycle110 | Self::DrMarioNesCycle130Usa
        ) {
            return Ok(());
        }
        for (name, value) in environment {
            let name = name.to_string_lossy().to_ascii_uppercase();
            if !value.is_empty()
                && (name == "SDL_DYNAMIC_API"
                    || (self == Self::CvlodSourceV1
                        && (name.starts_with("LOD_") || name.starts_with("RECOMP_UI_"))))
            {
                return Err(PortcoveError::unsupported("This retained runtime refuses ambient executable or debug overrides. Remove the override and restart Portcove.").detail("variable", name));
            }
        }
        Ok(())
    }

    pub(crate) fn minimum_template_version(self) -> u32 {
        match self {
            Self::YoshisCookieNesCycle110 => 6,
            Self::DrMarioNesCycle130Usa => 7,
            Self::AdvanceWarsGbaSourceV1 | Self::EarthBoundSnesSourceV1 => 9,
            Self::Render96UsSourceV1 => 13,
            Self::GundamWingSnesSourceV1 => 14,
            Self::CvlodSourceV1 => 3,
        }
    }

    pub(crate) fn capability_template(self) -> &'static str {
        if self == Self::CvlodSourceV1 {
            "n64-recomp-portable"
        } else {
            "staged-source-portable"
        }
    }

    fn historical_port(self) -> Result<PortDefinition> {
        let bytes = match self {
            Self::YoshisCookieNesCycle110 => {
                include_str!("legacy_cartridge/yoshis-cookie-recomp.json")
            }
            Self::DrMarioNesCycle130Usa => {
                include_str!("legacy_cartridge/dr-mario-nes-recomp.json")
            }
            Self::AdvanceWarsGbaSourceV1 => return Err(retired_creation()),
            Self::EarthBoundSnesSourceV1 => include_str!("legacy_cartridge/earthbound-recomp.json"),
            Self::Render96UsSourceV1 => include_str!("legacy_cartridge/render96ex.json"),
            Self::GundamWingSnesSourceV1 => {
                include_str!("legacy_cartridge/gundam-wing-endless-duel-recomp.json")
            }
            Self::CvlodSourceV1 => include_str!("legacy_cartridge/cvlod-recomp.json"),
        };
        Ok(serde_json::from_str(bytes)?)
    }
}

// Frozen historical reader contracts, not current authoring defaults. See the
// sibling README for source revisions, real consumers and retirement conditions.
fn execution_projection(port: &PortDefinition) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(port)?;
    let object = value.as_object_mut().expect("port serializes as an object");
    for key in [
        "name",
        "summary",
        "support_tier",
        "automated_tested_platforms",
        "manually_validated_platforms",
        "upstream_status",
        "presentation",
    ] {
        object.remove(key);
    }
    Ok(value)
}

pub(crate) fn validate_port(port: &PortDefinition, profile: &SourceProfile) -> Result<()> {
    let Some(recipe) = port.release.managed_build.values().next().copied() else {
        return Ok(());
    };
    let expected = recipe.historical_port()?;
    if execution_projection(port)? != execution_projection(&expected)?
        || expected.source_profile.as_deref() != Some(profile.id.as_str())
        || profile.kind != crate::SourceKind::File
    {
        return Err(PortcoveError::verification(
            "retained cartridge runtime contract differs from its historical interpretation",
        ));
    }
    let (extension, sha1, sha256) = match recipe {
        CartridgeBuildRecipe::YoshisCookieNesCycle110 => (
            "nes",
            "b19b67e59dd6bab7977e24e0052de7b48ae214a4",
            "ea416fff4a2d207236aa31a7abd2d41f06fe0a53486f485b109ed127be11a45a",
        ),
        CartridgeBuildRecipe::DrMarioNesCycle130Usa => (
            "nes",
            "0f18c2a5760be0647339b0e3cab9183af86fdd8c",
            "5f4849329f0ece227a3c7d6a63c0ecb6c9a1edee424e70e7bc6fa4bfda4a82d8",
        ),
        CartridgeBuildRecipe::AdvanceWarsGbaSourceV1 => return Err(retired_creation()),
        CartridgeBuildRecipe::EarthBoundSnesSourceV1 => (
            "sfc",
            "",
            "a8fe2226728002786d68c27ddddf0b90a894db52e4dfe268fdf72a68cae5f02e",
        ),
        CartridgeBuildRecipe::GundamWingSnesSourceV1 => (
            "sfc",
            "",
            "dd94308d822636c6ddf73c5e2644c84f2eb8fb4d9201150fc5f37d44d6f423f1",
        ),
        CartridgeBuildRecipe::Render96UsSourceV1 => return Ok(()),
        CartridgeBuildRecipe::CvlodSourceV1 => {
            return if profile.accepted_sha1 == ["879ead98f197fd05edda867655da5b1ce25aa5b8"]
                && profile.accepted_sha256.is_empty()
            {
                Ok(())
            } else {
                Err(PortcoveError::verification(
                    "retained CVLoD source contract differs",
                ))
            };
        }
    };
    let identity =
        (!sha1.is_empty() && profile.accepted_sha1 == [sha1] && profile.accepted_sha256.is_empty())
            || (!sha256.is_empty()
                && profile.accepted_sha256 == [sha256]
                && profile.accepted_sha1.is_empty());
    if profile.accepted_extensions != [extension] || !identity {
        return Err(PortcoveError::verification(
            "retained cartridge source contract differs",
        ));
    }
    Ok(())
}
