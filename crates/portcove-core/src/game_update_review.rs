//! Exact review for explicit game updates; saved policy never chooses the action.
use super::{InstallOverrides, OperationReporter};
use crate::{
    ActivityOperation, ActivityTargetKind, DestructiveAuthorization, GameUpdatePlan, InstallRecord,
    OperationEvent, OperationResult, PortcoveError, PortcoveService, Result,
};

impl PortcoveService {
    pub async fn plan_game_update(&self, port_id: &str, activate: bool) -> Result<GameUpdatePlan> {
        let _guard = self.library.try_lock_port(port_id, "review-update")?;
        self.plan_game_update_locked(port_id, activate).await
    }

    async fn plan_game_update_locked(
        &self,
        port_id: &str,
        activate: bool,
    ) -> Result<GameUpdatePlan> {
        let status = self.status(port_id)?;
        if status.active.is_none() {
            return Err(PortcoveError::not_found(
                "install this game before reviewing an update",
            ));
        }
        let plan = self.plan_install(port_id, Some(status.channel)).await?;
        let port = self.catalog.port(port_id)?;
        let sources = self
            .library
            .sources()?
            .into_iter()
            .filter(|source| {
                Some(&source.profile_id) == port.source_profile.as_ref()
                    || Some(&source.profile_id) == port.bios_source_profile.as_ref()
            })
            .collect::<Vec<_>>();
        // Free space is checked again at execution, but changing free bytes is
        // not a change to what the user reviewed. Release, destination, source,
        // definition, retained state and execution mode are exact identities.
        let plan_sha256 = crate::signed_catalog::digest(&serde_json::to_vec(&(
            "Portcove game update review v1",
            port,
            &plan.release,
            plan.channel,
            plan.platform,
            &plan.bundled_runtime,
            plan.action,
            &plan.output_location,
            (
                &status.active,
                &status.previous,
                &status.staged,
                status.update_policy,
            ),
            sources,
            activate,
        ))?);
        Ok(GameUpdatePlan {
            plan,
            activate,
            plan_sha256,
        })
    }

    pub async fn authorize_game_update(
        &self,
        port_id: &str,
        activate: bool,
        expected_plan: &str,
    ) -> Result<DestructiveAuthorization> {
        let reviewed = self.plan_game_update(port_id, activate).await?;
        if reviewed.plan_sha256 != expected_plan {
            return Err(PortcoveError::conflict(
                "update inputs changed; review the update again",
            ));
        }
        self.library
            .issue_authorization("game-update", port_id, expected_plan)
    }

    pub async fn apply_game_update(
        &self,
        port_id: &str,
        activate: bool,
        authorization: &str,
        mut emit: impl FnMut(OperationEvent),
    ) -> Result<InstallRecord> {
        let (activity, operation) = self.begin_cancellable_activity(
            ActivityOperation::Update,
            ActivityTargetKind::Port,
            Some(port_id),
        )?;
        emit(operation.started());
        let result = async {
            let _guard = self.library.try_lock_port(port_id, "reviewed-update")?;
            let reviewed = operation
                .interruptible(self.plan_game_update_locked(port_id, activate))
                .await?;
            self.library.consume_authorization(
                authorization,
                "game-update",
                port_id,
                &reviewed.plan_sha256,
            )?;
            let status = self.status(port_id)?;
            self.record_update_check(port_id, &status, &reviewed.plan.release)?;
            let mut reporter = OperationReporter {
                operation: &operation,
                emit: &mut emit,
            };
            self.apply_resolved_release(
                self.catalog.port(port_id)?,
                status,
                InstallOverrides {
                    source: None,
                    bios: None,
                    output_directory: None,
                },
                reviewed.plan.release,
                activate,
                &mut reporter,
            )
            .await
        }
        .await;
        let result = self.finish_activity(activity, result);
        emit(operation.finished(OperationResult::from_result(&result)));
        result
    }
}
