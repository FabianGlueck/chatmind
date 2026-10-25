# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Instead, report them privately via [GitHub's private vulnerability reporting](https://github.com/FabianGlueck/chatmind/security/advisories/new) or by email to hallo@fabian-glueck.de. You will get an answer within a week.

## Scope and threat model

chatmind is a single-user, local application:

- The server binds to `127.0.0.1` and has **no authentication**. Do not expose it to a network (port forwarding, `0.0.0.0` proxies, tunnels) — anyone who can reach it can read and change your vault and spend your API credits.
- API keys are read from the environment or `~/.config/chatmind/env` and are never written to the data folder.
- Messages, images and notes in a context are sent to the model provider you select (Anthropic, OpenAI or OpenRouter). With the indexer on, card texts are also sent to OpenRouter for summaries, embeddings and topic names.

Reports about anything that breaks these assumptions — e.g. a way for a web page to reach the local server, path traversal out of the data folder, or keys ending up on disk — are very welcome.
