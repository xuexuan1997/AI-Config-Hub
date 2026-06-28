import type { AppState } from "../model.js";

export function DeploymentView(props: {
  readonly state: AppState;
  readonly onConfirm: (confirmed: boolean) => void;
  readonly onDeploy: () => void;
  readonly onRollback: () => void;
}) {
  const disabled = props.state.preview === undefined || !props.state.deploymentConfirmed;
  return (
    <>
      <h1>Deployment</h1>
      <p>Deploy only from a fresh preview plan hash with explicit confirmation.</p>
      <label className="confirm">
        <input
          checked={props.state.deploymentConfirmed}
          disabled={props.state.preview === undefined}
          type="checkbox"
          onChange={(event) => props.onConfirm(event.currentTarget.checked)}
        />{" "}
        I understand this writes verified config files.
      </label>
      <button type="button" disabled={disabled} onClick={props.onDeploy}>
        Execute deployment
      </button>
      <button type="button" onClick={props.onRollback}>
        Preview rollback
      </button>
    </>
  );
}
