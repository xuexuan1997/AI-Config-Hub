import type { AppState } from "../model.js";

export function AssetsView(props: { readonly state: AppState; readonly onRefresh: () => void }) {
  return (
    <>
      <h1>Assets</h1>
      <button type="button" onClick={props.onRefresh}>
        Refresh assets
      </button>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Type</th>
            <th>Logical key</th>
            <th>Diagnostics</th>
          </tr>
        </thead>
        <tbody>
          {props.state.assets.map((asset) => (
            <tr key={asset.id}>
              <td>{asset.toolKey}</td>
              <td>{asset.resourceType}</td>
              <td>{asset.logicalKey}</td>
              <td>{asset.diagnosticCounts.error} errors</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
