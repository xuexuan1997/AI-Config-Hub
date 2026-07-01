import { localeForState, t } from "../i18n.js";
import type { AppState } from "../model.js";

export function OverviewView(props: { readonly state: AppState; readonly onScan: () => void }) {
  const locale = localeForState(props.state);
  return (
    <>
      <h1>{t(locale, "Configuration manager overview")}</h1>
      <p>
        {t(
          locale,
          "Scan AI tool configuration, inspect normalized assets, preview conversions, deploy with confirmation, and roll back verified changes.",
        )}
      </p>
      <div className="cards">
        <article>
          <span>{t(locale, "Scan")}</span>
          <strong>{props.state.scanStatus}</strong>
        </article>
        <article>
          <span>{t(locale, "Assets")}</span>
          <strong>{props.state.assets.length}</strong>
        </article>
        <article>
          <span>{t(locale, "History")}</span>
          <strong>{props.state.history.length}</strong>
        </article>
      </div>
      <button type="button" onClick={props.onScan}>
        {t(locale, "Start scan")}
      </button>
    </>
  );
}
