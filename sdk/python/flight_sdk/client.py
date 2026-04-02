"""Flight SDK client — logs agent events to a Flight collector over HTTP."""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import URLError

from .types import LogEntry, ModelConfig


class FlightClient:
    """Buffered client that sends log entries to a Flight HTTP collector.

    Entries are buffered and flushed every ``flush_interval`` seconds
    or when the buffer reaches ``flush_size`` entries, whichever comes first.
    """

    def __init__(
        self,
        endpoint: str = "http://localhost:4242",
        session_id: str | None = None,
        run_id: str | None = None,
        agent_id: str | None = None,
        model_config: ModelConfig | None = None,
        flush_size: int = 100,
        flush_interval: float = 1.0,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.session_id = session_id or f"session_{uuid.uuid4().hex[:12]}"
        self.run_id = run_id
        self.agent_id = agent_id
        self.model_config = model_config

        self._buffer: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._flush_size = flush_size
        self._flush_interval = flush_interval
        self._closed = False

        # Start background flush timer
        self._timer: threading.Timer | None = None
        self._schedule_flush()

    def _schedule_flush(self) -> None:
        if self._closed:
            return
        self._timer = threading.Timer(self._flush_interval, self._timed_flush)
        self._timer.daemon = True
        self._timer.start()

    def _timed_flush(self) -> None:
        self.flush()
        self._schedule_flush()

    def _now(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def _make_entry(self, event_type: str, **kwargs: Any) -> LogEntry:
        return LogEntry(
            session_id=self.session_id,
            timestamp=self._now(),
            event_type=event_type,
            run_id=self.run_id,
            agent_id=self.agent_id,
            model_config=self.model_config.to_dict() if self.model_config else None,
            **kwargs,
        )

    def _enqueue(self, entry: LogEntry) -> None:
        with self._lock:
            self._buffer.append(entry.to_dict())
            if len(self._buffer) >= self._flush_size:
                self._do_flush()

    def log_tool_call(
        self,
        tool_name: str,
        input: Any,
        output: Any = None,
        error: str | None = None,
    ) -> None:
        """Log a tool call as a request/response pair (2 entries)."""
        call_id = uuid.uuid4().hex[:8]

        # Request entry
        req = self._make_entry(
            "tool_call",
            call_id=call_id,
            direction="client->server",
            method="tools/call",
            tool_name=tool_name,
            payload=input if isinstance(input, dict) else {"value": input},
        )
        self._enqueue(req)

        # Response entry
        resp = self._make_entry(
            "tool_result",
            call_id=call_id,
            direction="server->client",
            method="tools/call",
            tool_name=tool_name,
            payload=output if isinstance(output, dict) else {"value": output} if output is not None else None,
            error=error,
        )
        self._enqueue(resp)

    def log_action(
        self,
        action: str,
        outcome: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Log an agent action/decision."""
        entry = self._make_entry(
            "agent_action",
            method="agent/action",
            chosen_action=action,
            execution_outcome=outcome,
            metadata=metadata,
        )
        self._enqueue(entry)

    def log_evaluation(
        self,
        score: float,
        labels: dict[str, str] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Log an evaluation score."""
        entry = self._make_entry(
            "evaluation",
            method="agent/evaluation",
            evaluator_score=score,
            labels=labels,
            metadata=metadata,
        )
        self._enqueue(entry)

    def log_event(self, event_type: str, **kwargs: Any) -> None:
        """Log a custom event with arbitrary fields."""
        entry = self._make_entry(event_type, **kwargs)
        self._enqueue(entry)

    def flush(self) -> None:
        """Flush buffered entries to the collector."""
        with self._lock:
            self._do_flush()

    def _do_flush(self) -> None:
        """Flush without acquiring the lock (caller must hold it)."""
        if not self._buffer:
            return
        entries = self._buffer[:]
        self._buffer.clear()

        body = "\n".join(json.dumps(e) for e in entries)
        try:
            req = Request(
                f"{self.endpoint}/ingest",
                data=body.encode("utf-8"),
                headers={"Content-Type": "application/x-ndjson"},
                method="POST",
            )
            with urlopen(req, timeout=5) as resp:
                resp.read()  # drain response
        except (URLError, OSError):
            # Best-effort: if collector is down, entries are lost.
            # Re-buffer on failure so next flush retries.
            self._buffer.extend(entries)

    def close(self) -> None:
        """Flush remaining entries and stop the background timer."""
        self._closed = True
        if self._timer:
            self._timer.cancel()
            self._timer = None
        self.flush()

    def __enter__(self) -> "FlightClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
