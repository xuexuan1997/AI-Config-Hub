import {
  deploymentBlockersForState,
  deploymentConfirmationLabel,
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
          <p className="task-status-summary">
            <span>Status: {phaseLabel(activeTask.phase)}</span>
            {activeTask.progress === undefined ? null : <span>{progressLabel(activeTask)}</span>}
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
      <section className="deployment-confirmation-panel" aria-label="Deployment confirmations">
        <label className="confirmation-item">
          <input
            checked={props.state.deploymentConfirmed}
            disabled={props.state.preview === undefined}
            type="checkbox"
            onChange={(event) => props.onConfirm(event.currentTarget.checked)}
          />
          <span>I understand this writes verified config files.</span>
        </label>
        {requiredConfirmations.length === 0 ? null : (
          <fieldset className="confirmation-list">
            <legend>Required confirmations</legend>
            {requiredConfirmations.map((confirmation) => (
              <label key={confirmation} className="confirmation-item">
                <input
                  checked={grantedConfirmations.has(confirmation)}
                  type="checkbox"
                  onChange={(event) =>
                    props.onConfirmRequirement(confirmation, event.currentTarget.checked)
                  }
                />
                <span>{deploymentConfirmationLabel(confirmation)}</span>
              </label>
            ))}
          </fieldset>
        )}
      </section>
      <div className="deployment-action-row">
        <button type="button" disabled={blockers.length > 0} onClick={props.onDeploy}>
          Execute deployment
        </button>
      </div>
      {blockers.length === 0 ? null : (
        <ul className="blocker-panel">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      <div className="deployment-action-row">
        <button type="button" disabled={rollbackUnavailable} onClick={props.onRollback}>
          Execute rollback
        </button>
      </div>
      {rollbackUnavailable ? (
        <p className="deployment-blocker">No succeeded deployment is available to roll back.</p>
      ) : null}
    </>
  );
}

function phaseLabel(phase: NonNullable<AppState["activeTask"]>["phase"]): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "discovering":
      return "Discovering";
    case "reading":
      return "Reading";
    case "parsing":
      return "Parsing";
    case "validating":
      return "Validating";
    case "committing":
      return "Committing";
    case "preflight":
      return "Preflight";
    case "backing_up":
      return "Backing up";
    case "writing":
      return "Writing";
    case "verifying":
      return "Verifying";
    case "restoring":
      return "Restoring";
    case "rolling_back":
      return "Rolling back";
    case "completed":
      return "Completed";
  }
}

function progressLabel(task: NonNullable<AppState["activeTask"]>): string {
  const progress = task.progress;
  if (progress === undefined) return "";
  return progress.total === null
    ? `${progress.completed} ${progress.unit}`
    : `${progress.completed}/${progress.total} ${progress.unit}`;
}
