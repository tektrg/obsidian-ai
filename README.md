# Claude Chat

Claude Chat is a desktop-only Obsidian plugin that adds a Claude chat panel with Claude Max OAuth support and an Anthropic API key fallback.

## Features

- Claude chat panel inside Obsidian
- Claude Max OAuth sign-in
- Anthropic API key fallback
- Streaming responses
- Active note context and file mentions
- Multi-file diff review UI

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

The Marketplace release artifact is the bundled Obsidian plugin surface:

- `main.js`
- `manifest.json`
- `styles.css`

The Claude bridge and its SDK CLI runtime are bundled into `main.js` and
materialized at runtime under the installed plugin folder. Do not attach files
from `scripts/` as Marketplace release assets.

Do not commit local plugin state files such as `.env`, `data.json`, or generated logs.
