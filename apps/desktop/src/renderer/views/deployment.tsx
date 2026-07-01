import { localeForState, t } from "../i18n.js";
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
  const locale = localeForState(props.state);
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
      <h1>{t(locale, "Deployment")}</h1>
      <p>{t(locale, "Deploy only from a fresh preview plan hash with explicit confirmation.")}</p>
      {activeTask === undefined ? null : (
        <section className="task-status">
          <h2>
            {activeTask.taskKind === "deployment"
              ? t(locale, "Deployment status")
              : t(locale, "Rollback status")}
          </h2>
          <p className="task-status-summary">
            <span>
              {t(locale, "Status: {status}", { status: phaseLabel(locale, activeTask.phase) })}
            </span>
            {activeTask.progress === undefined ? null : <span>{progressLabel(activeTask)}</span>}
          </p>
          {activeTask.message === undefined ? null : <p>{activeTask.message}</p>}
          {activeTask.recoveryLock ? (
            <div className="recovery-lock">
              <p>{t(locale, "Recovery lock active. Review history before retrying.")}</p>
              <button type="button" onClick={props.onReviewHistory}>
                {t(locale, "Review history")}
              </button>
            </div>
          ) : null}
        </section>
      )}
      <section
        className="deployment-confirmation-panel"
        aria-label={t(locale, "Deployment confirmations")}
      >
        <label className="confirmation-item">
          <input
            checked={props.state.deploymentConfirmed}
            disabled={props.state.preview === undefined}
            type="checkbox"
            onChange={(event) => props.onConfirm(event.currentTarget.checked)}
          />
          <span>{t(locale, "I understand this writes verified config files.")}</span>
        </label>
        {requiredConfirmations.length === 0 ? null : (
          <fieldset className="confirmation-list">
            <legend>{t(locale, "Required confirmations")}</legend>
            {requiredConfirmations.map((confirmation) => (
              <label key={confirmation} className="confirmation-item">
                <input
                  checked={grantedConfirmations.has(confirmation)}
                  type="checkbox"
                  onChange={(event) =>
                    props.onConfirmRequirement(confirmation, event.currentTarget.checked)
                  }
                />
                <span>{t(locale, deploymentConfirmationLabel(confirmation))}</span>
              </label>
            ))}
          </fieldset>
        )}
      </section>
      <div className="deployment-action-row">
        <button type="button" disabled={blockers.length > 0} onClick={props.onDeploy}>
          {t(locale, "Execute deployment")}
        </button>
      </div>
      {blockers.length === 0 ? null : (
        <ul className="blocker-panel">
          {blockers.map((blocker) => (
            <li key={blocker}>
              {localizeDeploymentBlocker(
                locale,
                blocker,
                missingConfirmationLabels(requiredConfirmations, grantedConfirmations),
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="deployment-action-row">
        <button type="button" disabled={rollbackUnavailable} onClick={props.onRollback}>
          {t(locale, "Execute rollback")}
        </button>
      </div>
      {rollbackUnavailable ? (
        <p className="deployment-blocker">
          {t(locale, "No succeeded deployment is available to roll back.")}
        </p>
      ) : null}
    </>
  );
}

function missingConfirmationLabels(
  requiredConfirmations: readonly DeploymentConfirmation[],
  grantedConfirmations: ReadonlySet<DeploymentConfirmation>,
): readonly string[] {
  return requiredConfirmations
    .filter((confirmation) => !grantedConfirmations.has(confirmation))
    .map(deploymentConfirmationLabel);
}

function localizeDeploymentBlocker(
  locale: ReturnType<typeof localeForState>,
  blocker: string,
  missingConfirmations: readonly string[],
): string {
  if (blocker.startsWith("Confirm required migration actions:")) {
    return `${t(locale, "Confirm required migration actions:")} ${missingConfirmations
      .map((confirmation) => t(locale, confirmation))
      .join(" ")}`;
  }
  return t(locale, blocker);
}

function phaseLabel(
  locale: ReturnType<typeof localeForState>,
  phase: NonNullable<AppState["activeTask"]>["phase"],
): string {
  switch (phase) {
    case "queued":
      return t(locale, "Queued");
    case "discovering":
      return t(locale, "Discovering");
    case "reading":
      return t(locale, "Reading");
    case "parsing":
      return t(locale, "Parsing");
    case "validating":
      return t(locale, "Validating");
    case "committing":
      return t(locale, "Committing");
    case "preflight":
      return t(locale, "Preflight");
    case "backing_up":
      return t(locale, "Backing up");
    case "writing":
      return t(locale, "Writing");
    case "verifying":
      return t(locale, "Verifying");
    case "restoring":
      return t(locale, "Restoring");
    case "rolling_back":
      return t(locale, "Rolling back");
    case "completed":
      return t(locale, "Completed");
  }
}

function progressLabel(task: NonNullable<AppState["activeTask"]>): string {
  const progress = task.progress;
  if (progress === undefined) return "";
  return progress.total === null
    ? `${progress.completed} ${progress.unit}`
    : `${progress.completed}/${progress.total} ${progress.unit}`;
}
