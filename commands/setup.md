---
name: setup
description: Configure the Prism plugin with your Prism API key
user-invocable: true
disable-model-invocation: true
model: haiku
allowed-tools:
  - Agent(prism:prism-setup)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/setup.js" apply * --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}")
---

Use the `prism:prism-setup` Agent exactly once in the foreground. Delegate the
complete execution contract and fully expanded argument string below.

**Usage:** `/prism:setup KEY`

No API key? Get one at: https://dashboard.optra-prism.com/setup

The fully expanded argument string is `$ARGUMENTS`. Parse it as exactly one
non-empty key. Scope flags are not supported. Treat the key as opaque: do not
validate its prefix, rewrite it, log it, or include it in the final response;
the backend response determines whether it is accepted. When no key was given,
return exactly `Usage: /prism:setup KEY` and do not run Bash.

For a valid key, run exactly one Bash command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/setup.js" apply "$KEY" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}"
```

Pass the key only as the positional argument shown above. Do not run any
validation, inspection, or retry command. The script detects the installed
plugin scope and writes only its corresponding settings file. Do not read or
write Prism configuration files yourself.

Do not call Bash or any other tool yourself. After the Agent returns, make your
final response exactly the first text content block in the Agent result. Ignore
the continuation `agentId` and usage metadata that Claude Code appends. Do not
summarize, explain, label, wrap, or add commentary.
