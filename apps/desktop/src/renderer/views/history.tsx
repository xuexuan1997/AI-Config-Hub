import { localeForState, t } from "../i18n.js";
import { deploymentConfirmationLabel, type AppState } from "../model.js";

export function HistoryView(props: {
  readonly state: AppState;
  readonly onRefresh: () => void;
  readonly onLoadDetail: (id: AppState["history"][number]["id"]) => void;
}) {
  const locale = localeForState(props.state);
  const detail = props.state.historyDetail;
  return (
    <>
      <h1>{t(locale, "History")}</h1>
      <button type="button" onClick={props.onRefresh}>
        {t(locale, "Refresh history")}
      </button>
      {props.state.history.length === 0 ? (
        <section className="empty-state" aria-label={t(locale, "No history records")}>
          <strong>{t(locale, "No deployment history yet.")}</strong>
          <p>{t(locale, "Completed deployments and rollback records will appear here.")}</p>
        </section>
      ) : (
        <ul className="history-list">
          {props.state.history.map((entry) => (
            <li key={entry.id} className="history-entry">
              <div className="history-entry-main">
                <strong>{historyKindLabel(locale, entry.kind)}</strong>
                <span>{historyStatusLabel(locale, entry.status)}</span>
              </div>
              <div className="history-entry-meta">
                <span>
                  {t(locale, "Created: {created}", { created: formatTimestamp(entry.createdAt) })}
                </span>
                {entry.finishedAt === undefined ? null : (
                  <span>
                    {t(locale, "Finished: {finished}", {
                      finished: formatTimestamp(entry.finishedAt),
                    })}
                  </span>
                )}
                {entry.phase === undefined ? null : (
                  <span>
                    {t(locale, "Phase: {phase}", { phase: historyPhaseLabel(locale, entry.phase) })}
                  </span>
                )}
                {entry.progress === undefined ? null : (
                  <span>
                    {entry.progress.completed}/{entry.progress.total ?? "?"} {entry.progress.unit}
                  </span>
                )}
                {entry.cancellable === undefined ? null : (
                  <span>
                    {entry.cancellable ? t(locale, "Cancellable") : t(locale, "Finalized")}
                  </span>
                )}
                {entry.snapshot === undefined ? null : (
                  <span>{snapshotLabel(locale, entry.snapshot)}</span>
                )}
              </div>
              <button type="button" onClick={() => props.onLoadDetail(entry.id)}>
                {t(locale, "Details")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail === undefined ? null : (
        <section className="detail-panel" aria-label={t(locale, "History detail")}>
          <h2>
            {t(locale, "{kind} detail", { kind: historyKindLabel(locale, detail.entry.kind) })}
          </h2>
          <dl>
            <dt>{t(locale, "Record ID")}</dt>
            <dd>{displayIdentifier(detail.entry.id)}</dd>
            <dt>{t(locale, "Status")}</dt>
            <dd>{historyStatusLabel(locale, detail.entry.status)}</dd>
            <dt>{t(locale, "Plan")}</dt>
            <dd>{displayIdentifier(detail.plan.planId)}</dd>
            <dt>{t(locale, "Plan hash")}</dt>
            <dd>{detail.plan.planHash}</dd>
            <dt>{t(locale, "Required confirmations")}</dt>
            <dd>
              {detail.plan.requiredConfirmations.length === 0
                ? t(locale, "none")
                : detail.plan.requiredConfirmations
                    .map((confirmation) => t(locale, deploymentConfirmationLabel(confirmation)))
                    .join(" ")}
            </dd>
          </dl>
          <h3>{t(locale, "Changes")}</h3>
          <ul className="history-list">
            {detail.changes.map((change) => (
              <li key={`${change.operation}:${change.pathDisplay}`} className="history-change">
                <div className="history-entry-main">
                  <strong>{changeOperationLabel(locale, change.operation)}</strong>
                  <span>{change.pathDisplay}</span>
                </div>
                <small className="history-change-hashes">
                  <span>
                    {t(locale, "Before")} {change.beforeHash ?? t(locale, "absent")}
                  </span>
                  <span>
                    {t(locale, "After")} {change.afterHash ?? t(locale, "absent")}
                  </span>
                </small>
                <pre>{change.diff}</pre>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function historyKindLabel(
  locale: ReturnType<typeof localeForState>,
  kind: AppState["history"][number]["kind"],
): string {
  switch (kind) {
    case "deployment":
      return t(locale, "Deployment");
    case "rollback":
      return t(locale, "Rollback");
  }
}

function historyStatusLabel(
  locale: ReturnType<typeof localeForState>,
  status: AppState["history"][number]["status"],
): string {
  switch (status) {
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
    default:
      return titleizeIdentifier(status);
  }
}

function historyPhaseLabel(
  locale: ReturnType<typeof localeForState>,
  phase: NonNullable<AppState["history"][number]["phase"]>,
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
    case "restoring":
      return t(locale, "Restoring");
    case "verifying":
      return t(locale, "Verifying");
    case "rolling_back":
      return t(locale, "Rolling back");
    case "completed":
      return t(locale, "Completed");
  }
}

function changeOperationLabel(
  locale: ReturnType<typeof localeForState>,
  operation: NonNullable<AppState["historyDetail"]>["changes"][number]["operation"],
): string {
  switch (operation) {
    case "create":
      return t(locale, "Create file");
    case "replace":
      return t(locale, "Replace file");
    case "delete":
      return t(locale, "Delete file");
  }
}

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp;
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(
    date.getUTCHours(),
  )}:${pad2(date.getUTCMinutes())} UTC`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function displayIdentifier(identifier: string): string {
  const delimiterIndex = identifier.indexOf(":");
  return delimiterIndex === -1 ? identifier : identifier.slice(delimiterIndex + 1);
}

function titleizeIdentifier(identifier: string): string {
  const words = identifier
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase());
  return words.length === 0 ? identifier : words.join(" ");
}

function snapshotLabel(
  locale: ReturnType<typeof localeForState>,
  snapshot: NonNullable<AppState["history"][number]["snapshot"]>,
): string {
  if (snapshot.status === "recorded") return `Snapshot ${snapshot.commitId.slice(0, 12)}`;
  if (snapshot.status === "missing") return "Snapshot missing";
  return `Snapshot ${historyStatusLabel(locale, snapshot.status)} ${snapshot.error.code}`;
}
