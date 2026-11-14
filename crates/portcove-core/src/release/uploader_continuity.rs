//! Uploader continuity for ordinary GitHub release progression.
//!
//! An observed digest proves the downloaded bytes match what was uploaded, not who
//! uploaded them. Before Core follows a newly selected release automatically, the
//! selected asset's uploader must continue the project's existing publishing
//! identities. The check uses only the provider observation already fetched for
//! selection and makes no extra request.
//!
//! Limitation: an upload by the project's Actions app passes. Anyone with write
//! access can change or trigger the project's release workflow, so this guard
//! stops direct manual or token uploads by a new account, not a release built by
//! a compromised or altered workflow. Workflow provenance is tracked in #5841.
use serde::{Deserialize, Deserializer};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{GithubAsset, GithubRelease};
use crate::{PortDefinition, PortcoveError, Result};

/// Assets uploaded before 2026-11-14T00:00:00Z keep the behavior they had before
/// the guard existed, and their uploaders form each project's established set.
/// Later uploads must come from an established, owner, automation or reviewed
/// account. The instant is fixed so a later upload can never join the baseline.
const BASELINE_UNIX_SECONDS: i64 = 1_794_614_400;

/// GitHub's Actions app account. A workflow's repository token can only upload to
/// the repository whose workflow ran, so this uploader is the project's own
/// automation acting with the project's write access (see the module limitation).
const ACTIONS_LOGIN: &str = "github-actions[bot]";
const ACTIONS_ACCOUNT_ID: u64 = 41_898_282;

/// GitHub's placeholder for deleted accounts. Many unrelated deleted uploaders
/// share it, so it never establishes or accepts continuity.
const GHOST_ACCOUNT_ID: u64 = 10_137;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(super) struct GithubAccount {
    pub(super) id: u64,
    pub(super) login: String,
    #[serde(rename = "type", default)]
    pub(super) kind: Option<String>,
}

/// What the provider response says about who uploaded one asset. A response
/// without the field does not cover uploaders (UNKNOWN); GitHub's explicit
/// `null` is an observed fact that no account is attributed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) enum AssetUploader {
    #[default]
    NotObserved,
    Unattributed,
    Account(GithubAccount),
}

impl<'de> Deserialize<'de> for AssetUploader {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Ok(match Option::<GithubAccount>::deserialize(deserializer)? {
            Some(account) => Self::Account(account),
            None => Self::Unattributed,
        })
    }
}

/// Why a selected asset may be followed automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Continuity {
    /// Uploaded before the baseline; behavior is unchanged.
    PredatesBaseline,
    RepositoryOwner,
    ProjectAutomation,
    /// The uploader also uploaded an asset of this project before the baseline.
    Established,
    /// A maintainer reviewed and accepted this uploader for the integration.
    Accepted,
    /// No asset in the observed listing carries uploader facts, so the response
    /// does not cover uploaders; no continuity is claimed.
    NotObserved,
}

fn uploaded_at(asset: &GithubAsset) -> Option<OffsetDateTime> {
    asset
        .created_at
        .as_deref()
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
}

fn predates_baseline(asset: &GithubAsset) -> bool {
    uploaded_at(asset).is_some_and(|uploaded| uploaded.unix_timestamp() < BASELINE_UNIX_SECONDS)
}

fn is_project_automation(account: &GithubAccount) -> bool {
    account.id == ACTIONS_ACCOUNT_ID
        && account.login == ACTIONS_LOGIN
        && account.kind.as_deref() == Some("Bot")
}

/// A deleted account's placeholder identifies no continuing publisher.
fn identifies(account: &GithubAccount, id: u64) -> bool {
    account.id == id && account.id != GHOST_ACCOUNT_ID
}

const HOLD_SUFFIX: &str =
    "Nothing was downloaded or changed. Check again after Portcove's next update.";

fn held(
    port: &PortDefinition,
    tag: &str,
    asset: &GithubAsset,
    cause: &str,
    reason: &str,
) -> PortcoveError {
    PortcoveError::unsupported(format!(
        "Portcove is holding back this version because {cause}. {HOLD_SUFFIX}"
    ))
    .detail("reason", reason)
    .detail("port_id", port.id.clone())
    .detail("release_tag", tag)
    .detail("asset", asset.name.clone())
}

/// Refuses automatic progression to `asset` of release `tag` unless its uploader
/// continues the project's publishing identities. `releases` is the complete
/// observed listing used for selection.
pub(super) fn require(
    port: &PortDefinition,
    owner: Option<&GithubAccount>,
    releases: &[GithubRelease],
    tag: &str,
    asset: &GithubAsset,
) -> Result<Continuity> {
    let not_continuous = "provider_uploader_not_continuous";
    let account = match &asset.uploader {
        AssetUploader::NotObserved => {
            let observed_elsewhere = releases
                .iter()
                .flat_map(|release| &release.assets)
                .any(|other| other.uploader != AssetUploader::NotObserved);
            if observed_elsewhere {
                // The same response attributes other assets, so a missing field on
                // the selected one is an inconsistent observation, not absent coverage.
                return Err(held(
                    port,
                    tag,
                    asset,
                    "GitHub's answer doesn't show who uploaded it",
                    "provider_uploader_not_observed",
                ));
            }
            tracing::warn!(
                port_id = %port.id,
                tag,
                "release listing carries no uploader facts; uploader continuity is UNKNOWN"
            );
            return Ok(Continuity::NotObserved);
        }
        _ if predates_baseline(asset) => return Ok(Continuity::PredatesBaseline),
        AssetUploader::Unattributed => {
            return Err(held(
                port,
                tag,
                asset,
                "GitHub doesn't show who uploaded it",
                not_continuous,
            ));
        }
        AssetUploader::Account(account) => account,
    };
    if owner.is_some_and(|owner| identifies(account, owner.id)) {
        return Ok(Continuity::RepositoryOwner);
    }
    if is_project_automation(account) {
        return Ok(Continuity::ProjectAutomation);
    }
    if releases
        .iter()
        .flat_map(|release| &release.assets)
        .any(|earlier| {
            predates_baseline(earlier)
                && matches!(&earlier.uploader, AssetUploader::Account(earlier) if identifies(account, earlier.id))
        })
    {
        return Ok(Continuity::Established);
    }
    if port
        .release
        .accepted_uploaders
        .iter()
        .any(|accepted| identifies(account, accepted.id))
    {
        return Ok(Continuity::Accepted);
    }
    Err(held(
        port,
        tag,
        asset,
        "it was uploaded by a GitHub account that hasn't published this project's earlier versions",
        not_continuous,
    )
    .detail("uploader", account.login.clone())
    .detail("uploader_id", account.id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: u64, login: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "login": login, "type": "User"})
    }

    fn asset(uploader: Option<serde_json::Value>, created_at: &str) -> GithubAsset {
        let mut value = serde_json::json!({
            "name": "game-windows.zip", "size": 1, "digest": null,
            "browser_download_url": "https://example.invalid/game-windows.zip",
            "created_at": created_at,
        });
        if let Some(uploader) = uploader {
            value["uploader"] = uploader;
        }
        serde_json::from_value(value).unwrap()
    }

    fn release(assets: Vec<GithubAsset>) -> GithubRelease {
        GithubRelease {
            id: None,
            tag_name: "earlier".into(),
            draft: false,
            prerelease: false,
            published_at: None,
            assets,
        }
    }

    #[test]
    fn continuity_distinguishes_unknown_coverage_from_known_uploaders() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("shipwright")
            .unwrap()
            .clone();
        let after = "2026-12-01T00:00:00Z";
        let before = "2026-11-13T23:59:59Z";
        let owner: GithubAccount = serde_json::from_value(account(1, "owner")).unwrap();
        let history = [release(vec![asset(Some(account(2, "regular")), before)])];
        let check = |port: &PortDefinition, selected: &GithubAsset| {
            require(port, Some(&owner), &history, "v2", selected)
        };
        // A listing with no uploader facts at all is UNKNOWN coverage.
        let unobserved = [release(vec![asset(None, before)])];
        assert_eq!(
            require(&port, Some(&owner), &unobserved, "v2", &asset(None, after)).unwrap(),
            Continuity::NotObserved
        );
        // A missing field beside attributed assets is an inconsistent observation.
        let inconsistent = check(&port, &asset(None, after)).unwrap_err();
        assert_eq!(
            inconsistent.details["reason"],
            "provider_uploader_not_observed"
        );
        assert_eq!(
            check(&port, &asset(Some(account(9, "foreign")), before)).unwrap(),
            Continuity::PredatesBaseline
        );
        assert_eq!(
            check(&port, &asset(Some(serde_json::Value::Null), before)).unwrap(),
            Continuity::PredatesBaseline
        );
        assert_eq!(
            check(&port, &asset(Some(account(1, "renamed-owner")), after)).unwrap(),
            Continuity::RepositoryOwner
        );
        assert_eq!(
            check(&port, &asset(Some(account(2, "regular")), after)).unwrap(),
            Continuity::Established
        );
        let bot =
            serde_json::json!({"id": ACTIONS_ACCOUNT_ID, "login": ACTIONS_LOGIN, "type": "Bot"});
        assert_eq!(
            check(&port, &asset(Some(bot), after)).unwrap(),
            Continuity::ProjectAutomation
        );
        // A look-alike login or a user account with the bot's login is not the app.
        for impostor in [
            serde_json::json!({"id": 77, "login": ACTIONS_LOGIN, "type": "Bot"}),
            serde_json::json!({"id": ACTIONS_ACCOUNT_ID, "login": ACTIONS_LOGIN, "type": "User"}),
            serde_json::json!({"id": 78, "login": "other-actions[bot]", "type": "Bot"}),
        ] {
            assert!(check(&port, &asset(Some(impostor), after)).is_err());
        }
        let foreign = asset(Some(account(9, "foreign")), after);
        let refused = check(&port, &foreign).unwrap_err();
        assert_eq!(refused.code, crate::ErrorCode::Unsupported);
        assert!(
            refused
                .message
                .starts_with("Portcove is holding back this version")
        );
        assert!(
            refused
                .message
                .contains("hasn't published this project's earlier versions")
        );
        assert_eq!(
            refused.details["reason"],
            "provider_uploader_not_continuous"
        );
        assert_eq!(refused.details["release_tag"], "v2");
        assert_eq!(refused.details["uploader"], "foreign");
        assert_eq!(refused.details["uploader_id"], "9");
        let unattributed = check(&port, &asset(Some(serde_json::Value::Null), after)).unwrap_err();
        assert!(
            unattributed
                .message
                .contains("doesn't show who uploaded it")
        );
        // A missing or malformed upload time cannot place an asset before the baseline.
        assert!(check(&port, &asset(Some(account(9, "foreign")), "")).is_err());
        let late_history = [release(vec![asset(Some(account(9, "foreign")), after)])];
        assert!(require(&port, Some(&owner), &late_history, "v2", &foreign).is_err());
        // Acceptance is by stable numeric ID; a reused login does not match.
        port.release.accepted_uploaders = vec![crate::AcceptedUploader {
            id: 10,
            login: "foreign".into(),
        }];
        assert!(check(&port, &foreign).is_err());
        port.release.accepted_uploaders[0].id = 9;
        assert_eq!(check(&port, &foreign).unwrap(), Continuity::Accepted);
    }

    #[test]
    fn the_deleted_account_placeholder_never_continues_a_project() {
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .port("shipwright")
            .unwrap()
            .clone();
        let ghost = || account(GHOST_ACCOUNT_ID, "ghost");
        let after = "2026-12-01T00:00:00Z";
        // Established by an earlier deleted uploader, owned by the placeholder and
        // accepted by ID: none of these lets a new placeholder upload continue.
        let history = [release(vec![asset(Some(ghost()), "2026-11-01T00:00:00Z")])];
        let owner: GithubAccount = serde_json::from_value(ghost()).unwrap();
        port.release.accepted_uploaders = vec![crate::AcceptedUploader {
            id: GHOST_ACCOUNT_ID,
            login: "ghost".into(),
        }];
        let refused = require(
            &port,
            Some(&owner),
            &history,
            "v2",
            &asset(Some(ghost()), after),
        )
        .unwrap_err();
        assert_eq!(refused.details["uploader_id"], GHOST_ACCOUNT_ID.to_string());
        // Its existing pre-baseline releases keep their behavior.
        assert_eq!(
            require(
                &port,
                Some(&owner),
                &history,
                "v1",
                &asset(Some(ghost()), "2026-11-01T00:00:00Z")
            )
            .unwrap(),
            Continuity::PredatesBaseline
        );
    }
}
