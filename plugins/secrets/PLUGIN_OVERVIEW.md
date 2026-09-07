Give an agent the API keys it needs without pasting them into chat. The agent asks, you type the values into a masked form, and bb writes them to a dotenv file on the thread's host.

## What you get

- A secure form in the thread for each requested variable, with a show or hide control per field.
- Values written directly to the dotenv file you chose, with file mode `0600`.
- Existing assignments updated in place and new ones appended. Other lines stay unchanged.
- A result for the agent that lists the path and the added, updated, and unchanged names. Values never appear in the transcript.

## How it works

The agent runs one command from inside a thread:

```
bb secret request OPENAI_API_KEY --purpose "Configure the server" --describe OPENAI_API_KEY "OpenAI key" --write-env .env.local
```

The form shows the purpose, the destination path, and one field per name. Submit to write the file, or cancel to stop the command. Each value must be a single non-empty line of at most 16 KiB. The write is checked against the file version the plugin read, so an edit made at the same time does not get lost.

The bundled `secrets` skill tells agents to batch known variables into one request and to never read the completed file back.

## Requirements

The command must run from a bb thread with a live host.
