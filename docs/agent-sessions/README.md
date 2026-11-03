# AI agent session exports

Raw Cursor agent session transcripts (JSONL, one structured event per line)
covering the entire build described in the main `README.md`, provided as
the "AI agent session exports" deliverable.

- **`orchestrator-session.jsonl`** — the main session: PRD analysis,
  clarifying questions, architecture/contracts design, writing the TDD test
  baseline, delegating to the four subagents below, and all integration
  work afterward (bug fixes, wiring replay/fault-injection end-to-end,
  building the app shell, writing `README.md`/`PERF.md`, this export).
- **`subagent-1-data-hub.jsonl`** — implemented order book sync
  (`OrderBookManager`), connection/subscription management, reconnect
  policy, backpressure, and the `SharedWorker` itself, against the
  pre-written tests and contracts.
- **`subagent-2-panels.jsonl`** — implemented the four panel components
  (depth ladder, trade tape, candlestick chart, watchlist) and their pure
  calculation modules.
- **`subagent-3-workspace.jsonl`** — implemented the dockview-based
  workspace shell, pop-out window management, and the layout schema/store
  and management UI.
- **`subagent-4-perf-replay.jsonl`** — implemented the performance
  overlay, benchmark runner, replay engine, fault injection, and the
  sample-recording script.

**Redaction note:** these are mechanically exported from Cursor's local
session history. The only redaction applied is a blanket replacement of
the local Windows account name with `REDACTED_USER` (it appears throughout
as part of absolute file paths, e.g. in tool-call arguments) — no other
content, wording, tool output, or ordering has been edited. No API keys,
tokens, or other secrets were used anywhere in this build (the app only
talks to Binance's public, keyless market-data endpoints), and a pattern
scan for common secret-like strings across all five files turned up
nothing. Still, skim before sharing further if that matters for your
situation — this redaction was automated, not manually reviewed line by
line.
