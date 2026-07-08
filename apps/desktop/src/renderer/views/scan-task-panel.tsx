import { localizeUiMessage, t, type DesktopLocale } from "../i18n.js";
import type { AppState } from "../model.js";

type ScanTask = NonNullable<AppState["activeTask"]>;

export function ScanTaskModal(props: {
  readonly heading: string;
  readonly locale: DesktopLocale;
  readonly task: ScanTask | undefined;
}) {
  if (props.task === undefined || !isActiveScanTask(props.task)) return null;

  return (
    <div
      className="scan-task-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-task-modal-title"
    >
      <div className="scan-task-dialog" role="status" aria-live="polite">
        <div className="scan-task-spinner" aria-hidden="true" />
        <ScanTaskPanel
          ariaLabel={t(props.locale, "Active scan status")}
          heading={props.heading}
          locale={props.locale}
          message={undefined}
          task={props.task}
          titleId="scan-task-modal-title"
        />
        <p className="scan-task-modal-hint">
          {t(props.locale, "Keep this window open while AI Config Hub scans your assets.")}
        </p>
      </div>
    </div>
  );
}

function isActiveScanTask(task: ScanTask): boolean {
  return task.taskKind === "scan" && (task.status === "running" || task.phase !== "completed");
}

export function ScanTaskPanel(props: {
  readonly ariaLabel: string;
  readonly heading: string;
  readonly locale: DesktopLocale;
  readonly task: ScanTask | undefined;
  readonly message: string | undefined;
  readonly titleId?: string;
}) {
  if (props.task === undefined && props.message === undefined) return null;
  const progress = props.task?.progress;
  const failures =
    props.task?.failures ?? (props.task?.failure === undefined ? [] : [props.task.failure]);

  return (
    <section className="scan-task-panel" aria-label={props.ariaLabel}>
      <header className="scan-task-heading">
        <div>
          <span className="eyebrow">{t(props.locale, "Scan status")}</span>
          <h2 id={props.titleId}>{props.heading}</h2>
        </div>
        {props.task === undefined ? null : (
          <span className={`scan-task-state ${props.task.status}`}>
            {taskStatusLabel(props.locale, props.task.status)}
          </span>
        )}
      </header>
      {props.task === undefined ? null : (
        <p className="task-status-summary">
          <span>
            {t(props.locale, "Status: {status}", {
              status: phaseLabel(props.locale, props.task.phase),
            })}
          </span>
          {progress === undefined ? null : <span>{progressLabel(props.locale, props.task)}</span>}
        </p>
      )}
      {progress?.total === null || progress === undefined ? null : (
        <progress
          aria-label={t(props.locale, "Scan progress")}
          max={progress.total}
          value={progress.completed}
        />
      )}
      {props.task?.message === undefined ? null : (
        <p>{localizeUiMessage(props.locale, props.task.message)}</p>
      )}
      {props.message === undefined ? null : (
        <p className="scan-task-message">{localizeUiMessage(props.locale, props.message)}</p>
      )}
      {failures.length === 0 ? null : (
        <section
          className="scan-failure-details"
          aria-label={t(props.locale, "Scan failure details")}
        >
          <h3>{t(props.locale, "Failed items")}</h3>
          <ul>
            {failures.map((failure) => (
              <li key={`${failure.itemRef}:${failure.errorCode}`}>
                <strong>{failure.itemRef}</strong>
                <dl>
                  <dt>{t(props.locale, "Error code")}</dt>
                  <dd>{failure.errorCode}</dd>
                  <dt>{t(props.locale, "Retry")}</dt>
                  <dd>{t(props.locale, failure.retryable ? "Retryable" : "Not retryable")}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function phaseLabel(locale: DesktopLocale, phase: ScanTask["phase"]): string {
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
    case "completed":
      return t(locale, "Completed");
    default:
      return phase;
  }
}

function taskStatusLabel(locale: DesktopLocale, status: ScanTask["status"]): string {
  switch (status) {
    case "running":
      return t(locale, "Running");
    case "succeeded":
      return t(locale, "Succeeded");
    case "partially_succeeded":
      return t(locale, "Partially succeeded");
    case "cancelled":
      return t(locale, "Cancelled");
    case "failed":
      return t(locale, "Failed");
    case "rolled_back":
      return t(locale, "Rolled back");
  }
}

function progressLabel(locale: DesktopLocale, task: ScanTask): string {
  const progress = task.progress;
  if (progress === undefined) return "";
  const unit = progressUnitLabel(locale, progress.unit);
  return progress.total === null
    ? `${progress.completed} ${unit}`
    : `${progress.completed}/${progress.total} ${unit}`;
}

function progressUnitLabel(
  locale: DesktopLocale,
  unit: NonNullable<ScanTask["progress"]>["unit"],
): string {
  if (locale === "zh-CN") {
    switch (unit) {
      case "files":
        return "个文件";
      case "operations":
        return "个操作";
      case "items":
        return "项";
    }
  }
  return unit;
}
