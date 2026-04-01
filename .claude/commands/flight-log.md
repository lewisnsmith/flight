Run `flight log audit` to display a full audit of all tool calls from the current session.

Read the output carefully. Present a concise summary to the user:

1. **Overview** — total calls, duration, error count
2. **Tool breakdown** — which tools were used most, any with errors
3. **Issues found** — list each error with what went wrong and why (if obvious from the output)
4. **Patterns** — anything notable: repeated failures, retries, unusual sequences

If there are errors or suspicious patterns, offer to investigate the specific tool calls or help fix the underlying issues.

If the user asks about a specific tool call, you can run `flight log tools` with `--tool <name>` to filter, or read the session's `_tools.jsonl` file directly from `~/.flight/logs/` for full details.
