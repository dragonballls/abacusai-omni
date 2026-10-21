"""Unit tests for the source-based Mark LVI/Abacus adapter."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PLUGIN_PATH = Path(__file__).parent / "plugins" / "abacus_agent_team.py"
_spec = importlib.util.spec_from_file_location("abacus_agent_team", PLUGIN_PATH)
assert _spec and _spec.loader
_plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_plugin)


class AbacusAgentTeamPluginTests(unittest.TestCase):
    def test_loopback_validation_accepts_only_local_mcp_endpoints(self):
        self.assertTrue(_plugin._local_url("http://127.0.0.1:12345/mcp?session=bot-1"))
        self.assertTrue(_plugin._local_url("http://localhost:12345/mcp/"))
        self.assertFalse(_plugin._local_url("https://127.0.0.1:12345/mcp"))
        self.assertFalse(_plugin._local_url("http://example.com:12345/mcp"))
        self.assertFalse(_plugin._local_url("http://127.0.0.1:12345/other"))
        self.assertFalse(_plugin._local_url("http://user:pass@127.0.0.1:12345/mcp"))

    def test_runtime_discovery_reads_only_local_agent_tools_entries(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            runtime = root / "runtime"
            runtime.mkdir()
            valid = {
                "mcpServers": {
                    "agent-tools": {
                        "url": "http://127.0.0.1:14567/mcp?session=bot-1",
                        "headers": {"Authorization": "Bearer " + ("a" * 64)},
                    }
                }
            }
            (runtime / "mcp-tools-bot-1.json").write_text(
                json.dumps(valid), encoding="utf-8"
            )
            remote = {
                "mcpServers": {
                    "agent-tools": {
                        "url": "http://attacker.example:14567/mcp?session=bot-2",
                        "headers": {"Authorization": "Bearer " + ("b" * 64)},
                    }
                }
            }
            (runtime / "mcp-tools-bot-2.json").write_text(
                json.dumps(remote), encoding="utf-8"
            )
            with patch.dict(os.environ, {"ABACUSAI_BOT_HOME": temp}):
                entries = list(_plugin._agent_tool_entries())
            self.assertEqual(
                entries,
                [(
                    "http://127.0.0.1:14567/mcp?session=bot-1",
                    "Bearer " + ("a" * 64),
                )],
            )

    def test_request_validation_happens_before_any_network_access(self):
        self.assertIn(
            "not recognised",
            _plugin.run({"action": "execute_shell", "arguments": "{}"}),
        )
        self.assertIn(
            "not valid JSON",
            _plugin.run({"action": "list_agents", "arguments": "{"}),
        )
        self.assertIn(
            "exact current agent name",
            _plugin.run({"action": "delete_agent", "arguments": '{"agent_id":"x"}'}),
        )

    def test_response_parser_returns_text_and_rejects_mcp_errors(self):
        ok = {
            "result": {
                "content": [{"type": "text", "text": '{"agents": []}'}],
                "isError": False,
            }
        }
        self.assertEqual(_plugin._response_text(ok), '{"agents": []}')
        with self.assertRaisesRegex(ValueError, "denied"):
            _plugin._response_text({
                "result": {
                    "content": [{"type": "text", "text": "denied"}],
                    "isError": True,
                }
            })


if __name__ == "__main__":
    unittest.main()
