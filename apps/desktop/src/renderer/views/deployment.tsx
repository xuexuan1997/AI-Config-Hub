import {
  deploymentBlockersForState,
  rollbackRequestForState,
  type AppState,
  type DeploymentConfirmation,
} from "../model.js";

export function DeploymentView(props: {
  readonly state: AppState;
  readonly onConfirm: (confirmed: boolean) => void;
  readonly onConfirmRequirement: (confirmation: DeploymentConfirmation, granted: boolean) => void;
  readonly onDeploy: () => void;
  readonly onRollback: () => void;
  readonly onReviewHistory: () => void;
}) {
  const blockers = deploymentBlockersForState(props.state);
  const rollbackUnavailable = rollbackRequestForState(props.state) === undefined;
  const requiredConfirmations = props.state.preview?.requiredConfirmations ?? [];
  const grantedConfirmations = new Set(props.state.deploymentConfirmationGrants);
  const activeTask =
    props.state.activeTask?.taskKind === "deployment" ||
    props.state.activeTask?.taskKind === "rollback"
      ? props.state.activeTask
      : undefined;
  return (
    <>
      <h1>Deployment</h1>
      <p>Deploy only from a fresh preview plan hash with explicit confirmation.</p>
      {activeTask === undefined ? null : (
        <section className="task-status">
          <h2>{activeTask.taskKind === "deployment" ? "Deployment status" : "Rollback status"}</h2>
          <p>
            {activeTask.phase}{" "}
            {activeTask.progress === undefined ? null : progressLabel(activeTask)}
          </p>
          {activeTask.message === undefined ? null : <p>{activeTask.message}</p>}
          {activeTask.recoveryLock ? (
            <div className="recovery-lock">
              <p>Recovery lock active. Review history before retrying.</p>
              <button type="button" onClick={props.onReviewHistory}>
                Review history
              </button>
            </div>
          ) : null}
        </section>
      )}
      <label className="confirm">
        <input
          checked={props.state.deploymentConfirmed}
          disabled={props.state.preview === undefined}
          type="checkbox"
          onChange={(event) => props.onConfirm(event.currentTarget.checked)}
        />{" "}
        I understand this writes verified config files.
      </label>
      {requiredConfirmations.length === 0 ? null : (
        <fieldset className="confirmation-list">
          <legend>Required confirmations</legend>
          {requiredConfirmations.map((confirmation) => (
            <label key={confirmation} className="confirm">
              <input
                checked={grantedConfirmations.has(confirmation)}
                type="checkbox"
                onChange={(event) =>
                  props.onConfirmRequirement(confirmation, event.currentTarget.checked)
                }
              />{" "}
              {confirmationLabel(confirmation)}
            </label>
          ))}
        </fieldset>
      )}
      <button type="button" disabled={blockers.length > 0} onClick={props.onDeploy}>
        Execute deployment
      </button>
      {blockers.length === 0 ? null : (
        <ul className="deployment-blockers">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      <button type="button" disabled={rollbackUnavailable} onClick={props.onRollback}>
        Execute rollback
      </button>
      {rollbackUnavailable ? (
        <p className="deployment-blocker">No succeeded deployment is available to roll back.</p>
      ) : null}
    </>
  );
}

function progressLabel(task: NonNullable<AppState["activeTask"]>): string {
  const progress = task.progress;
  if (progress === undefined) return "";
  return progress.total === null
    ? `${progress.completed} ${progress.unit}`
    : `${progress.completed}/${progress.total} ${progress.unit}`;
}

function confirmationLabel(confirmation: DeploymentConfirmation): string {
  switch (confirmation) {
    case "overwrite":
      return "Overwrite existing target files.";
    case "partial_conversion":
      return "Deploy a partial conversion with documented warnings.";
    case "delete":
      return "Delete target files listed in the preview.";
  }
}
