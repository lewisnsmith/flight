"""Tests for the Flight Python SDK client.

These tests start a real Flight HTTP collector and verify the Python client
can send events that end up as JSONL files on disk.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

# Add parent to path so we can import flight_sdk without installing
sys.path.insert(0, str(Path(__file__).parent.parent))

from flight_sdk import FlightClient, ModelConfig


def _find_flight_cmd() -> list[str]:
    """Find the flight CLI command."""
    repo_root = Path(__file__).parent.parent.parent.parent
    cli_js = repo_root / "dist" / "cli.js"
    if cli_js.exists():
        return ["node", str(cli_js)]
    # Fallback to global binary
    return ["flight"]


def _wait_for_health(port: int, timeout: float = 5.0) -> bool:
    """Wait for the collector health endpoint to respond."""
    from urllib.request import urlopen
    from urllib.error import URLError

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://localhost:{port}/health", timeout=1) as resp:
                data = json.loads(resp.read())
                if data.get("status") == "ok":
                    return True
        except (URLError, OSError):
            time.sleep(0.1)
    return False


@pytest.fixture
def collector():
    """Start a Flight collector server and yield (port, log_dir)."""
    log_dir = tempfile.mkdtemp(prefix="flight-pytest-")
    port = 14800 + os.getpid() % 1000

    flight_cmd = _find_flight_cmd()
    proc = subprocess.Popen(
        [*flight_cmd, "serve", "--port", str(port), "--log-dir", log_dir],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        if not _wait_for_health(port):
            proc.kill()
            stdout, stderr = proc.communicate(timeout=2)
            pytest.fail(
                f"Collector failed to start on port {port}.\n"
                f"stdout: {stdout.decode()}\nstderr: {stderr.decode()}"
            )
        yield port, log_dir
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(log_dir, ignore_errors=True)


class TestFlightClient:
    def test_generates_session_id(self):
        client = FlightClient(endpoint="http://localhost:1")  # won't connect
        assert client.session_id.startswith("session_")
        client._closed = True  # prevent timer from firing

    def test_custom_session_id(self):
        client = FlightClient(endpoint="http://localhost:1", session_id="my-session")
        assert client.session_id == "my-session"
        client._closed = True

    def test_context_manager(self):
        with FlightClient(endpoint="http://localhost:1") as client:
            assert client.session_id.startswith("session_")
        assert client._closed

    def test_tool_call_creates_two_entries(self, collector):
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="tool-test",
        )
        client.log_tool_call("read_file", {"path": "/tmp/test.txt"}, "file contents")
        client.close()

        log_file = Path(log_dir) / "tool-test.jsonl"
        assert log_file.exists(), f"Expected {log_file} to exist"
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]

        assert len(entries) == 2
        assert entries[0]["event_type"] == "tool_call"
        assert entries[0]["direction"] == "client->server"
        assert entries[0]["tool_name"] == "read_file"
        assert entries[1]["event_type"] == "tool_result"
        assert entries[1]["direction"] == "server->client"

    def test_tool_call_error(self, collector):
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="error-test",
        )
        client.log_tool_call("write_file", {"path": "/etc/passwd"}, error="Permission denied")
        client.close()

        log_file = Path(log_dir) / "error-test.jsonl"
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]
        assert entries[1]["error"] == "Permission denied"

    def test_log_action(self, collector):
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="action-test",
        )
        client.log_action("buy_stock", "success", {"ticker": "AAPL"})
        client.close()

        log_file = Path(log_dir) / "action-test.jsonl"
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]
        assert len(entries) == 1
        assert entries[0]["event_type"] == "agent_action"
        assert entries[0]["chosen_action"] == "buy_stock"
        assert entries[0]["execution_outcome"] == "success"

    def test_log_evaluation(self, collector):
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="eval-test",
        )
        client.log_evaluation(0.85, labels={"task": "rebalance"})
        client.close()

        log_file = Path(log_dir) / "eval-test.jsonl"
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]
        assert len(entries) == 1
        assert entries[0]["evaluator_score"] == 0.85
        assert entries[0]["labels"]["task"] == "rebalance"

    def test_stamps_run_and_agent_id(self, collector):
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="stamp-test",
            run_id="experiment-42",
            agent_id="agent-1",
        )
        client.log_action("decide", "hold")
        client.close()

        log_file = Path(log_dir) / "stamp-test.jsonl"
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]
        assert entries[0]["run_id"] == "experiment-42"
        assert entries[0]["agent_id"] == "agent-1"

    def test_stamps_model_config(self, collector):
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="model-test",
            model_config=ModelConfig(
                model="llama-3-8b",
                quantization="gptq-4bit",
                provider="local",
            ),
        )
        client.log_tool_call("predict", {"input": "test"}, {"score": 0.7})
        client.close()

        log_file = Path(log_dir) / "model-test.jsonl"
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]
        assert entries[0]["model_config"]["model"] == "llama-3-8b"
        assert entries[0]["model_config"]["quantization"] == "gptq-4bit"

    def test_buffered_flush(self, collector):
        """Entries are buffered and flushed together."""
        port, log_dir = collector
        client = FlightClient(
            endpoint=f"http://localhost:{port}",
            session_id="buffer-test",
            flush_size=5,  # flush after 5 entries
            flush_interval=60,  # don't auto-flush by time
        )
        # Log 3 actions (below flush_size, won't auto-flush)
        for i in range(3):
            client.log_action(f"action-{i}", "ok")

        # File shouldn't exist yet (not flushed)
        log_file = Path(log_dir) / "buffer-test.jsonl"
        assert not log_file.exists()

        # Manual flush
        client.flush()
        assert log_file.exists()
        entries = [json.loads(line) for line in log_file.read_text().strip().split("\n")]
        assert len(entries) == 3
        client.close()
