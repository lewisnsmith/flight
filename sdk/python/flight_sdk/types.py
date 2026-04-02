"""Flight SDK type definitions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelConfig:
    """Model and quantization info stamped on every log entry."""

    model: str
    quantization: str | None = None
    provider: str | None = None
    temperature: float | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"model": self.model}
        if self.quantization is not None:
            d["quantization"] = self.quantization
        if self.provider is not None:
            d["provider"] = self.provider
        if self.temperature is not None:
            d["temperature"] = self.temperature
        d.update(self.extra)
        return d


@dataclass
class LogEntry:
    """A single log entry matching the Flight JSONL schema."""

    session_id: str
    timestamp: str
    event_type: str  # tool_call, tool_result, agent_action, evaluation, lifecycle

    call_id: str | None = None
    direction: str | None = None
    method: str | None = None
    tool_name: str | None = None
    payload: Any = None
    error: str | None = None
    run_id: str | None = None
    agent_id: str | None = None
    model_config: dict[str, Any] | None = None
    chosen_action: str | None = None
    execution_outcome: str | None = None
    evaluator_score: float | None = None
    labels: dict[str, str] | None = None
    metadata: dict[str, Any] | None = None
    latency_ms: float | None = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "session_id": self.session_id,
            "timestamp": self.timestamp,
            "event_type": self.event_type,
        }
        for key in (
            "call_id", "direction", "method", "tool_name", "payload",
            "error", "run_id", "agent_id", "model_config", "chosen_action",
            "execution_outcome", "evaluator_score", "labels", "metadata",
            "latency_ms",
        ):
            val = getattr(self, key)
            if val is not None:
                d[key] = val
        return d
