import { useCallback, useEffect, useState } from "react";

const COLUMNS = [
  { id: "inbox", label: "Inbox" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In progress" },
  { id: "pr", label: "PR" },
  { id: "done", label: "Done" },
];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "X-Feedback-Board": "1",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function Card({ card, onStop }) {
  const blocked = card.runStatus === "out_of_scope" || card.runStatus === "credential_refused";
  return (
    <article
      className={blocked ? "card blocked" : "card"}
      draggable={card.runStatus !== "running"}
      data-title={card.title}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", card.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <h3>{card.title}</h3>
      {card.notes ? <p className="notes">{card.notes}</p> : null}
      {card.issueNumber ? (
        <p className="meta">
          {card.issueUrl ? (
            <a href={card.issueUrl} target="_blank" rel="noreferrer">
              Issue #{card.issueNumber}
            </a>
          ) : (
            `Issue #${card.issueNumber}`
          )}
        </p>
      ) : null}
      {card.prUrl ? (
        <p className="meta">
          <a href={card.prUrl} target="_blank" rel="noreferrer">
            Draft pull request
          </a>
        </p>
      ) : null}
      {card.runStatus === "running" ? <p className="note">Run in progress</p> : null}
      {blocked ? (
        <div className="scope">
          <p>{card.message}</p>
          <ul>
            {(card.outOfScopePaths || []).map((filePath) => (
              <li key={filePath}>{filePath}</li>
            ))}
          </ul>
        </div>
      ) : card.message ? (
        <p className="note">{card.message}</p>
      ) : null}
      {card.runStatus === "running" ? (
        <button type="button" className="stop" onClick={() => onStop(card.id)}>
          Stop
        </button>
      ) : null}
    </article>
  );
}

export default function App() {
  const [board, setBoard] = useState(null);
  const [banner, setBanner] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState("");

  const applyBoard = useCallback((body) => {
    setBoard(body);
    setBanner(body.notice || body.error || "");
  }, []);

  const refresh = useCallback(async () => {
    applyBoard(await api("/api/refresh", { method: "POST" }));
  }, [applyBoard]);

  useEffect(() => {
    let active = true;
    refresh().catch((error) => {
      if (active) setBanner(error.message);
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!board?.cards?.some((card) => card.runStatus === "running") && !board?.runningCardId) return undefined;
    const timer = setInterval(() => {
      api("/api/board")
        .then((body) => setBoard(body))
        .catch((error) => setBanner(error.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [board]);

  async function onAdd(event) {
    event.preventDefault();
    setBusy(true);
    try {
      applyBoard(await api("/api/cards", { method: "POST", body: JSON.stringify({ title, notes }) }));
      setTitle("");
      setNotes("");
    } catch (error) {
      setBanner(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDrop(columnId, event) {
    event.preventDefault();
    setOver("");
    const id = event.dataTransfer.getData("text/plain");
    if (!id || busy) return;
    setBusy(true);
    try {
      if (columnId === "todo") {
        applyBoard(await api(`/api/cards/${id}/start`, { method: "POST" }));
      } else {
        applyBoard(
          await api(`/api/cards/${id}`, {
            method: "PATCH",
            body: JSON.stringify({ column: columnId }),
          }),
        );
      }
    } catch (error) {
      setBanner(error.message);
      try {
        setBoard(await api("/api/board"));
      } catch {
        // The banner already reports the failure.
      }
    } finally {
      setBusy(false);
    }
  }

  async function onStop(id) {
    setBusy(true);
    try {
      applyBoard(await api(`/api/cards/${id}/stop`, { method: "POST" }));
    } catch (error) {
      setBanner(error.message);
    } finally {
      setBusy(false);
    }
  }

  const cards = board?.cards || [];

  return (
    <main>
      <header className="top">
        <div>
          <h1>Feedback</h1>
          <p className="sub">On this computer only. Nothing here posts.</p>
        </div>
        <div className="status">
          <p>
            {board
              ? `${board.agentsEnabled ? "Agents on" : "Agents off"} · ${board.runsToday} of ${board.dailyCap} runs today`
              : "Loading the board"}
          </p>
          <button type="button" onClick={() => refresh().catch((error) => setBanner(error.message))} disabled={busy}>
            Refresh
          </button>
        </div>
      </header>

      <form className="composer" onSubmit={onAdd}>
        <input
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          required
        />
        <textarea
          aria-label="Notes"
          placeholder="Notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={2}
        />
        <button type="submit" disabled={busy}>
          Add card
        </button>
      </form>

      {banner ? (
        <p className="banner" role="alert">
          {banner}
        </p>
      ) : null}

      <section className="board" aria-label="Feedback board">
        {COLUMNS.map((column) => {
          const items = cards.filter((card) => card.column === column.id);
          return (
            <section
              key={column.id}
              className={over === column.id ? "column over" : "column"}
              data-column={column.id}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(column.id);
              }}
              onDragLeave={() => setOver((current) => (current === column.id ? "" : current))}
              onDrop={(event) => onDrop(column.id, event)}
            >
              <h2>
                {column.label}
                <span>{items.length}</span>
              </h2>
              {items.map((card) => (
                <Card key={card.id} card={card} onStop={onStop} />
              ))}
            </section>
          );
        })}
      </section>
    </main>
  );
}
