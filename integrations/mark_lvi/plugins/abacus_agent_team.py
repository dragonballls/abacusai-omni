"""Mark-LVI plugin that routes requests to Abacus's built-in A2A tool.

This is an original adapter; it does not inspect, patch, or disable licensing
checks in Torvis.exe. It reads Abacus's per-session MCP config and talks only to
the loopback MCP endpoint already created by AbacusAI Bot.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import urllib.error
import urllib.request
from urllib.parse import urlsplit

PLUGIN = {
    "name": "abacus_agent_team",
    "description": (
        "Use AbacusAI Bot's existing agent-team capability for real specialist "
        "bots and persistent worker chats. Actions: list_agents, create_agent, "
        "update_agent, delete_agent, delegate_task, task_status, convene, "
        "meeting_status, follow_up. Call this when the user asks to inspect or "
        "manage Abacus agents, delegate work, or run a multi-agent meeting. "
        "Pass arguments as a JSON object string. Never claim a task is complete "
        "unless the returned task/meeting status says it completed. Only delete "
        "a worker when the user clearly requested deletion and you supply its "
        "exact current name as confirm_name. This adapter only uses Abacus's "
        "existing local MCP endpoint and does not bypass provider subscriptions "
        "or quotas."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "action": {
                "type": "STRING",
                "description": (
                    "One of list_agents, create_agent, update_agent, "
                    "delete_agent, delegate_task, task_status, convene, "
                    "meeting_status, follow_up."
                ),
            },
            "arguments": {
                "type": "STRING",
                "description": (
                    "JSON object containing the fields required by the chosen "
                    "action; use {} for list_agents."
                ),
            },
        },
        "required": ["action"],
    },
    "tier": "core",
    "brief": "Use Abacus agents to delegate work and coordinate meetings.",
}

_ALLOWED_ACTIONS = {
    "list_agents",
    "create_agent",
    "update_agent",
    "delete_agent",
    "delegate_task",
    "task_status",
    "convene",
    "meeting_status",
    "follow_up",
}
_MAX_ARGUMENT_BYTES = 16_000
_MAX_RESPONSE_BYTES = 512_000
_MAX_CONFIG_CANDIDATES = 30
_TIMEOUT_SECONDS = 1.5


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward Abacus's bearer token to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def _abacus_home() -> Path:
    configured = os.environ.get("ABACUSAI_BOT_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".abacusai-bot"


def _local_url(url: object) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        return (
            parsed.scheme == "http"
            and parsed.hostname in {"127.0.0.1", "localhost"}
            and parsed.port is not None
            and parsed.path.rstrip("/") == "/mcp"
            and parsed.username is None
            and parsed.password is None
            and parsed.fragment == ""
        )
    except (ValueError, TypeError):
        return False


def _agent_tool_entries():
    """Yield recent safe entries from Abacus's agent-tools runtime configs."""
    runtime = _abacus_home() / "runtime"
    try:
        runtime_real = runtime.resolve(strict=True)
        paths = sorted(
            (
                p for p in runtime.glob("mcp-*.json")
                if p.is_file() and not p.is_symlink()
            ),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:_MAX_CONFIG_CANDIDATES]
    except OSError:
        return

    for path in paths:
        try:
            if path.resolve(strict=True).parent != runtime_real:
                continue
            with path.open("r", encoding="utf-8") as stream:
                data = json.load(stream)
            entry = data.get("mcpServers", {}).get("agent-tools", {})
            if not isinstance(entry, dict) or not _local_url(entry.get("url")):
                continue
            raw_headers = entry.get("headers", {})
            if not isinstance(raw_headers, dict):
                continue
            headers = {
                str(key).lower(): value
                for key, value in raw_headers.items()
            }
            auth = headers.get("authorization")
            if not isinstance(auth, str) or not auth.startswith("Bearer ") or len(auth) < 20:
                continue
            yield entry["url"], auth
        except (OSError, UnicodeError, ValueError, TypeError, AttributeError):
            continue


def _response_text(envelope: object) -> str:
    if not isinstance(envelope, dict):
        raise ValueError("Abacus returned an invalid MCP response.")
    if envelope.get("error"):
        err = envelope["error"]
        message = err.get("message", "unknown MCP error") if isinstance(err, dict) else str(err)
        raise ValueError(f"Abacus MCP request failed: {message}")
    result = envelope.get("result")
    if not isinstance(result, dict):
        raise ValueError("Abacus returned no MCP result.")
    if result.get("isError"):
        parts = result.get("content", [])
        message = " ".join(
            item.get("text", "")
            for item in parts
            if isinstance(item, dict) and item.get("type") == "text"
        )
        raise ValueError(message or "The Abacus A2A tool returned an error.")
    parts = result.get("content", [])
    text_parts = [
        item.get("text", "")
        for item in parts
        if isinstance(item, dict) and item.get("type") == "text"
    ]
    if not text_parts:
        raise ValueError("Abacus returned no text for this agent-team action.")
    return "\n".join(text_parts)


def _mcp_call(url: str, token: str, method: str, params: dict) -> object:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": token,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with _OPENER.open(request, timeout=_TIMEOUT_SECONDS) as response:
        raw = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise ValueError("Abacus MCP response exceeded the size limit.")
    decoded = raw.decode("utf-8")
    try:
        return json.loads(decoded)
    except json.JSONDecodeError:
        # Some MCP transports may choose SSE framing instead of JSON.
        for line in decoded.splitlines():
            if line.startswith("data:"):
                try:
                    return json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
        raise ValueError("Abacus returned an unreadable MCP response.") from None


def _find_working_entry():
    for url, token in _agent_tool_entries():
        try:
            probe = _mcp_call(
                url,
                token,
                "tools/call",
                {"name": "a2a", "arguments": {"action": "list_agents"}},
            )
            probe_text = _response_text(probe)
            parsed = json.loads(probe_text)
            if isinstance(parsed, dict) and isinstance(parsed.get("agents"), list):
                return url, token
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            continue
    raise RuntimeError(
        "No active Abacus bot session exposed the A2A tool. Open an Abacus "
        "bot's persistent chat, enable A2A in Library > Tools, and try again. "
        "The adapter only checks local runtime MCP configs under "
        f"{_abacus_home() / 'runtime'}; it does not contact external hosts."
    )


def run(parameters: dict, player=None, session_memory=None) -> str:
    """Dispatch one validated user-directed action to Abacus's existing A2A tool."""
    try:
        action = str(parameters.get("action", "")).strip()
        if action not in _ALLOWED_ACTIONS:
            return "Abacus agent-team action not recognised. Choose a supported action."
        raw_args = parameters.get("arguments", "{}")
        if not isinstance(raw_args, str):
            return "The action arguments must be supplied as a JSON object string."
        if len(raw_args.encode("utf-8")) > _MAX_ARGUMENT_BYTES:
            return "The action arguments exceed the 16 KB limit."
        try:
            args = json.loads(raw_args or "{}")
        except json.JSONDecodeError:
            return "The action arguments are not valid JSON."
        if not isinstance(args, dict):
            return "The action arguments must decode to a JSON object."
        if action == "delete_agent" and not (
            isinstance(args.get("confirm_name"), str)
            and args.get("confirm_name", "").strip()
        ):
            return (
                "Refusing to send delete_agent without the exact current agent "
                "name in confirm_name."
            )

        url, token = _find_working_entry()
        envelope = _mcp_call(
            url,
            token,
            "tools/call",
            {"name": "a2a", "arguments": {"action": action, **args}},
        )
        return _response_text(envelope)[:20_000]
    except Exception as error:
        message = str(error).replace("\n", " ").strip()
        return f"Abacus agent-team request failed: {message[:700]}"
