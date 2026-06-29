import { createApiClient, type ApiClient } from "@ai-config-hub/api/browser";
import { useMemo, useState } from "react";

import { createLocalApiTransport } from "./local-transport.js";

type Connection = {
  readonly baseUrl: string;
  readonly token: string;
};

const defaultConnection: Connection = {
  baseUrl: "http://127.0.0.1:49152",
  token: "",
};

export function App() {
  const [connection, setConnection] = useState(defaultConnection);
  const [assets, setAssets] = useState<readonly string[]>([]);
  const [events, setEvents] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("Idle");

  const client = useMemo<ApiClient | undefined>(() => {
    if (connection.token.trim().length === 0 || connection.baseUrl.trim().length === 0) {
      return undefined;
    }
    return createApiClient(
      createLocalApiTransport({
        baseUrl: connection.baseUrl.trim(),
        authToken: connection.token.trim(),
      }),
      { requestId: () => `request:web-${crypto.randomUUID()}` },
    );
  }, [connection]);

  async function startScan() {
    if (client === undefined) {
      setMessage("Enter the local API URL and token.");
      return;
    }
    setMessage("Starting scan");
    const response = await client.invoke("scan.start", { mode: "full" });
    if (!response.ok) {
      setMessage(response.error.message);
      return;
    }
    setMessage(`Queued ${response.data.taskId}`);
    client.subscribeTask(response.data.taskId, 0, (event) => {
      setEvents((current) => [`${event.sequence ?? "-"} ${event.type}`, ...current].slice(0, 8));
      if (event.type === "completed") void refreshAssets(client);
    });
  }

  async function refreshAssets(activeClient = client) {
    if (activeClient === undefined) {
      setMessage("Enter the local API URL and token.");
      return;
    }
    const response = await activeClient.invoke("assets.list", { limit: 25 });
    if (!response.ok) {
      setMessage(response.error.message);
      return;
    }
    setAssets(response.data.items.map((asset) => `${asset.toolKey} ${asset.logicalKey}`));
    setMessage(`Loaded ${response.data.items.length} assets`);
  }

  function updateConnection(patch: Partial<Connection>) {
    setConnection((current) => ({ ...current, ...patch }));
  }

  return (
    <main className="workspace">
      <section className="toolbar" aria-label="Connection">
        <label>
          <span>Local API</span>
          <input
            value={connection.baseUrl}
            onChange={(event) => updateConnection({ baseUrl: event.target.value })}
          />
        </label>
        <label>
          <span>Token</span>
          <input
            type="password"
            value={connection.token}
            onChange={(event) => updateConnection({ token: event.target.value })}
          />
        </label>
        <button type="button" onClick={() => void startScan()}>
          Scan
        </button>
        <button type="button" onClick={() => void refreshAssets()}>
          Assets
        </button>
      </section>

      <section className="status" aria-live="polite">
        {message}
      </section>

      <section className="panels">
        <Panel title="Assets" rows={assets} empty="No assets loaded" />
        <Panel title="Task Events" rows={events} empty="No task events" />
      </section>
    </main>
  );
}

function Panel(props: {
  readonly title: string;
  readonly rows: readonly string[];
  readonly empty: string;
}) {
  return (
    <section className="panel">
      <h2>{props.title}</h2>
      <ul>
        {(props.rows.length === 0 ? [props.empty] : props.rows).map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </section>
  );
}
