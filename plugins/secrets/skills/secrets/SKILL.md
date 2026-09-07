---
name: secrets
description: "Request user-supplied credentials securely into a dotenv file without exposing their values to the agent."
---

# Request secrets securely

Use `bb secret request` when the user needs to supply a credential. Do not ask the user to paste a secret into chat.

Batch every currently known variable into one request. Inspect documentation or `.env.example` to identify variable names, but do not read or print an existing secret-bearing env file.

```bash
bb secret request OPENAI_API_KEY RESEND_API_KEY \
  --purpose "Configure application credentials" \
  --describe OPENAI_API_KEY "OpenAI API key used by the server" \
  --describe RESEND_API_KEY "Resend API key used for transactional email" \
  --write-env .env.local
```

Always provide the exact `--write-env` destination, a concise purpose, and one short plain-language description per variable. Relative destinations resolve from the CLI working directory; absolute destinations may point anywhere on the thread's host. Never place secret values in argv, prompts, comments, logs, or follow-up messages.

After success, trust the command's path and added/updated/unchanged counts. Never verify by running `cat`, `sed`, `env`, or another command that would reveal the completed file.

If the command reports duplicate dotenv assignments, fix the file structure without reading values and rerun the request. If it reports repeated write conflicts, rerun the same request; do not ask the user to paste values. Under the workspace sandbox (Accept Edits / Approve for me), Claude's macOS sandbox permits the loopback access plugin CLI commands need; Linux and other provider sandboxes may still require escalation approval.
