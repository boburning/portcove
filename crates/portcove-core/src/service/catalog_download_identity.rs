//! Provider-qualified references for non-owning downloads. Legacy GitHub JSON
//! remains numeric; a GitLab tag or link is never a synthetic GitHub ID.
use super::*;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "provider", rename_all = "kebab-case", deny_unknown_fields)]
pub enum CatalogForeignReleaseId {
    Gitlab { project_id: u64, tag: String },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum CatalogDownloadReleaseId {
    Github(u64),
    Foreign(CatalogForeignReleaseId),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "provider", rename_all = "kebab-case", deny_unknown_fields)]
pub enum CatalogForeignAssetId {
    Gitlab {
        project_id: u64,
        tag: String,
        link_id: u64,
        file_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum CatalogDownloadAssetId {
    Github(u64),
    Foreign(CatalogForeignAssetId),
}

fn require_gitlab_release(project_id: u64, tag: &str) -> Result<()> {
    if project_id == 0 || tag.is_empty() || tag.len() > 512 || tag.chars().any(char::is_control) {
        return Err(PortcoveError::verification(
            "invalid GitLab release identity",
        ));
    }
    Ok(())
}

impl CatalogDownloadReleaseId {
    pub fn github_id(&self) -> Option<u64> {
        match self {
            Self::Github(id) => Some(*id),
            Self::Foreign(_) => None,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::Github(0) => Err(PortcoveError::verification("release ID must be nonzero")),
            Self::Github(_) => Ok(()),
            Self::Foreign(CatalogForeignReleaseId::Gitlab { project_id, tag }) => {
                require_gitlab_release(*project_id, tag)
            }
        }
    }

    pub(crate) fn require_tag(&self, observed: &str) -> Result<()> {
        self.validate()?;
        if let Self::Foreign(CatalogForeignReleaseId::Gitlab { tag, .. }) = self
            && tag != observed
        {
            return Err(PortcoveError::verification(
                "download tag differs from its provider-qualified release identity",
            ));
        }
        Ok(())
    }
}

impl CatalogDownloadAssetId {
    pub fn github_id(&self) -> Option<u64> {
        match self {
            Self::Github(id) => Some(*id),
            Self::Foreign(_) => None,
        }
    }

    pub(crate) fn validate_for(&self, release: &CatalogDownloadReleaseId) -> Result<()> {
        release.validate()?;
        match (release, self) {
            (CatalogDownloadReleaseId::Github(_), Self::Github(id)) if *id != 0 => Ok(()),
            (
                CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
                    project_id,
                    tag,
                }),
                Self::Foreign(CatalogForeignAssetId::Gitlab {
                    project_id: asset_project,
                    tag: asset_tag,
                    link_id,
                    file_id,
                }),
            ) if project_id == asset_project
                && tag == asset_tag
                && *link_id != 0
                && *file_id != 0 =>
            {
                Ok(())
            }
            _ => Err(PortcoveError::verification(
                "download asset and release do not share one provider identity",
            )),
        }
    }
}

/// Only a filesystem key, never an upstream identifier or selection token.
pub(super) fn destination_identity(
    release: &CatalogDownloadReleaseId,
    asset: &CatalogDownloadAssetId,
) -> Result<String> {
    asset.validate_for(release)?;
    match (release, asset) {
        (CatalogDownloadReleaseId::Github(release), CatalogDownloadAssetId::Github(asset)) => {
            Ok(format!("{release}-{asset}"))
        }
        _ => Ok(format!(
            "gitlab-{}",
            crate::signed_catalog::digest(&serde_json::to_vec(&(release, asset))?)
        )),
    }
}

macro_rules! legacy_id {
    ($identity:ty) => {
        impl From<u64> for $identity {
            fn from(id: u64) -> Self {
                Self::Github(id)
            }
        }

        impl PartialEq<u64> for $identity {
            fn eq(&self, other: &u64) -> bool {
                self.github_id() == Some(*other)
            }
        }

        impl PartialEq<$identity> for u64 {
            fn eq(&self, other: &$identity) -> bool {
                other == self
            }
        }

        impl fmt::Display for $identity {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self {
                    Self::Github(id) => write!(formatter, "{id}"),
                    Self::Foreign(_) => {
                        formatter.write_str(&serde_json::to_string(self).map_err(|_| fmt::Error)?)
                    }
                }
            }
        }
    };
}

legacy_id!(CatalogDownloadReleaseId);
legacy_id!(CatalogDownloadAssetId);

#[cfg(test)]
mod tests {
    use super::*;

    fn gitlab(tag: &str) -> (CatalogDownloadReleaseId, CatalogDownloadAssetId) {
        (
            CatalogDownloadReleaseId::Foreign(CatalogForeignReleaseId::Gitlab {
                project_id: 42,
                tag: tag.into(),
            }),
            CatalogDownloadAssetId::Foreign(CatalogForeignAssetId::Gitlab {
                project_id: 42,
                tag: tag.into(),
                link_id: 7,
                file_id: 17,
            }),
        )
    }

    #[test]
    fn legacy_download_ids_keep_exact_numeric_json_and_destination() {
        let release = CatalogDownloadReleaseId::from(42);
        let asset = CatalogDownloadAssetId::from(7);
        assert_eq!(serde_json::to_string(&release).unwrap(), "42");
        assert_eq!(serde_json::to_string(&asset).unwrap(), "7");
        assert_eq!(destination_identity(&release, &asset).unwrap(), "42-7");
        assert_eq!(
            serde_json::from_str::<CatalogDownloadReleaseId>("42").unwrap(),
            release
        );
    }

    #[test]
    fn foreign_download_ids_do_not_alias_github_or_other_project_tags() {
        let (release, asset) = gitlab("v1/日本");
        assert_ne!(release, 42);
        assert_ne!(asset, 7);
        let key = destination_identity(&release, &asset).unwrap();
        assert!(key.starts_with("gitlab-"));
        assert!(!key.contains(['/', '\\']));
        let (other, _) = gitlab("v2");
        assert!(destination_identity(&other, &asset).is_err());
        assert!(destination_identity(&42.into(), &asset).is_err());
        assert!(destination_identity(&release, &7.into()).is_err());
        let mut changed = serde_json::to_value(&asset).unwrap();
        changed["project_id"] = 43.into();
        let changed: CatalogDownloadAssetId = serde_json::from_value(changed).unwrap();
        assert!(changed.validate_for(&release).is_err());
    }

    #[test]
    fn foreign_download_ids_refuse_unknown_malformed_and_inconsistent_values() {
        for value in [
            r#"{"provider":"other","project_id":42,"tag":"v1"}"#,
            r#"{"provider":"gitlab","project_id":42,"tag":"v1","extra":1}"#,
            r#"{"provider":"gitlab","project_id":42}"#,
            r#""42""#,
            "-1",
        ] {
            assert!(
                serde_json::from_str::<CatalogDownloadReleaseId>(value).is_err(),
                "{value}"
            );
        }
        for tag in ["", "v1\n"] {
            let (release, asset) = gitlab(tag);
            assert!(asset.validate_for(&release).is_err());
        }
        assert!(
            CatalogDownloadAssetId::from(0)
                .validate_for(&42.into())
                .is_err()
        );
    }
}
