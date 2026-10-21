# FaithMakes/TORVIS source route and Mark-LVI adapter

Repository: dragonballls/abacusai-omni

This integration implements the source-based alternative route. It does **not**
patch, unpack, or disable a subscription check inside the compiled Torvis.exe.

## Route A — exact TORVIS build

The checked TORVIS 0.5.0 package contains a compiled app/Torvis.exe; the
editable application source for the FaithMakes Community gate was not present.
The only surfaced Python source was a plugin example. Therefore this repository
cannot safely make a source-level change to that exact gate yet.

For that route, use the owner's authorized source checkout or an owner-provided
patch that identifies the check and intended replacement. Keep the change
isolated and test launch, sign-in, offline startup, and plugin loading. Do not
pretend this adapter removes the gate from Torvis.exe.

## Route B — public Mark-LVI plugin adapter

The creator's public Mark-LVI repository documents a drop-in Python plugin
contract. This repository supplies an original plugin that calls Abacus's
existing local agent-tools MCP server and its A2A tool. It does not copy
Mark-LVI implementation code or modify the creator's repository.

File to install: plugins/abacus_agent_team.py

1. Keep Mark-LVI's own license and use requirements in force.
2. Copy plugins/abacus_agent_team.py into your local Mark-LVI plugins folder.
   The plugin is discovered by Mark-LVI at startup; restart the app after
   installing it, then explicitly enable it in the plugin manager.
3. Start AbacusAI Bot and open a persistent bot chat where the A2A capability
   is enabled in Library > Tools. The plugin discovers Abacus runtime MCP
   configuration under ~/.abacusai-bot/runtime (or the directory selected by
   ABACUSAI_BOT_HOME), probes the local A2A tool, and then makes the requested
   call.
4. Use the plugin actions for listing, creating, updating, and delegating to
   bots, task-status checks, meetings, and follow-up rounds. Pass the action
   arguments as a JSON object string. Deletion requires confirm_name to match
   the worker's current exact name.

## Security and limitations

- The plugin accepts only http://127.0.0.1:<port>/mcp and
  http://localhost:<port>/mcp, refuses redirects, and sends the bearer token
  only to the local endpoint copied from Abacus's runtime configuration.
- The plugin never takes a URL or bearer token from model output. It bounds
  candidate config count, request timeout, argument size, and response size.
- The token is still a local secret. Only install plugins you trust; a plugin
  running as your user can potentially read files available to that account.
- This uses Abacus's existing A2A permissions and provider credentials. It does
  not bypass Abacus permissions, FaithMakes subscription controls, or provider
  pricing/quotas.
- The test suite in this folder covers loopback-only validation, safe config
  discovery, input checks, and MCP response parsing. Run it with:
  python -m unittest discover -s integrations/mark_lvi -p 'test_*.py'

## Upstream

- Mark-LVI source: https://github.com/FatihMakes/Mark-LVI
- The upstream README identifies its license as Creative Commons BY-NC 4.0.
  Review the current license and applicable permissions before redistributing or
  using that assistant outside personal, non-commercial use.
- Abacus agent-team implementation: https://github.com/dragonballls/abacusai-omni/pull/21
