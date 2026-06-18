# Claude Chat plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Plugin ID: `claude-chat`
- Purpose: standalone Claude chat panel for Obsidian with:
  - Claude Max OAuth flow
  - Anthropic API key fallback
  - Claude SDK bridge process for Claude Max chat execution
- This plugin was extracted from the older reader plugin and now owns **all chat/auth functionality**.
- Reference implementation/model for product direction:
  - Use [craft-agents-oss](https://github.com/lukilabs/craft-agents-oss) as the model for:
    - Claude Max account auth usage
    - chat interface UX and interaction patterns
    - multi-session, agent-native chat experience where applicable to Obsidian constraints

## Related project split

This workspace now has two separate plugins:

1. `claude-chat`
   - owns Claude chat UI
   - owns Claude auth state
   - owns Claude SDK bridge integration

2. `obsidian-markdown-reader/obsidian-reader-plugin`
   - owns reader mode
   - owns highlights
   - owns reading progress
   - should not contain Claude chat/auth code anymore

When debugging chat/auth issues, work in **`claude-chat`**, not the reader plugin.

## Active local dev target

The active local Obsidian vault for development is:
- `<DEV_VAULT_PATH>`

The plugin is exposed to Obsidian via symlink here:
- `<DEV_VAULT_PATH>/.obsidian/plugins/claude-chat`

That symlink points to the source project here:
- `<PLUGIN_SOURCE_PATH>`

The reader plugin is also symlinked separately:
- `<DEV_VAULT_PATH>/.obsidian/plugins/obsidian-reader-plugin`

## Build and dev workflow

Use npm and esbuild.

### Install
```bash
npm install
```

### Dev/watch
```bash
npm run dev
```

### Production build
```bash
npm run build
```

## Hot reload development setup

For the best development experience, use **Hot-Reload** plugin + symlink setup.

### Symlink structure
The plugin folder in the test vault is symlinked to the source project:
```
<DEV_VAULT_PATH>/.obsidian/plugins/claude-chat
    → <PLUGIN_SOURCE_PATH>
```

This means:
- `npm run dev` builds to `main.js` in the source project
- Obsidian sees changes immediately through the symlink
- No file copying needed

### Hot-Reload plugin
**Install:** [pjeby/hot-reload](https://github.com/pjeby/hot-reload)
- Watches `main.js`, `styles.css`, `manifest.json` for changes
- Auto-reloads the plugin ~750ms after changes stop
- Detects dev plugins by `.git` directory or `.hotreload` file

**Status:** Already installed in test vault at:
- `<DEV_VAULT_PATH>/.obsidian/plugins/hot-reload/`

### Dev server in tmux
Run the dev server in a detached tmux session:
```bash
tmux new-session -d -s claude-chat-dev "npm run dev"
```

**Manage session:**
```bash
# View output
tmux attach -t claude-chat-dev

# Detach (Ctrl+B, then D)

# Stop server
tmux kill-session -t claude-chat-dev
```

### Panel persistence fix
**Problem:** The chat panel would close on every hot reload.

**Solution:** Removed `detachLeavesOfType()` from `onunload()` in `main.ts`:
```typescript
async onunload() {
    // Don't detach leaves here - let the workspace layout persist across reloads
    // The views will be reconnected when the plugin reloads
}
```

Now the chat panel **stays open** when the plugin hot-reloads.

## Important deployment note

This project uses a **symlink-based deployment** for development:

**Symlink:**
```
<DEV_VAULT_PATH>/.obsidian/plugins/claude-chat
    → <PLUGIN_SOURCE_PATH>
```

Because the vault plugin directory is a **symlink to this source project**, build output lands in the source project and is visible to Obsidian through the symlink. No file copying is performed during development.

**Legacy note:** The `.env` file with `OBSIDIAN_PLUGIN_DIR` is no longer used since we removed the file copy plugin from esbuild. The symlink handles everything.

## Runtime artifacts expected

The plugin must have these runtime files available at the project root:
- `main.js`
- `manifest.json`
- `styles.css`

Claude Max bridge file must exist at:
- `scripts/claude-chat-bridge.mjs`

The bridge resolver in `src/chat/ClaudeSdkBridge.ts` expects the installed plugin path:
- `<vault>/.obsidian/plugins/claude-chat/scripts/claude-chat-bridge.mjs`

## Important source files

### Entry and settings
- `src/main.ts`
- `src/settings.ts`

### Auth
- `src/auth/types.ts`
- `src/auth/AuthController.ts`
- `src/auth/AnthropicApiKeyProvider.ts`
- `src/auth/ClaudeMaxProvider.ts`

### Chat
- `src/chat/ClaudeChatView.ts`
- `src/chat/ClaudeSdkBridge.ts`

### Bridge script
- `scripts/claude-chat-bridge.mjs`

## Memory links

- Context/snapshot architecture update + future multi-file context/diff roadmap:
  - [[202604021849-obsidianaicontextsnapshotunificationandmultifilediffroadmap]]

## Settings and persisted state

Obsidian stores plugin data under the plugin ID namespace.

For the active local vault, plugin state is here:
- `<DEV_VAULT_PATH>/.obsidian/plugins/claude-chat/data.json`

This may contain:
- `authMode`
- `anthropicApiKey`
- `defaultClaudeModel`
- `chatSystemPrompt`
- Claude OAuth access/refresh token fields

Because this plugin ID is different from `obsidian-reader-plugin`, it does **not** automatically reuse the old reader plugin auth state.

## Logging and debugging

### Primary places to inspect
1. Obsidian developer console
2. plugin `data.json`
3. bridge script path and existence
4. chat panel output inside Obsidian

### Current logging caveat
This plugin currently does **not** yet have a dedicated debug log command/file like the reader plugin.

So for now, debugging should focus on:
- Obsidian UI error messages
- DevTools console
- bridge script presence/path
- auth state in `data.json`

## tmux usage

Project convention: use **tmux** for terminal commands.

### Build in tmux
```bash
tmux new-session -d -s ai-build 'cd <PLUGIN_SOURCE_PATH> && npm run build'
tmux capture-pane -pt ai-build:0 -S -200
```

### Inspect plugin state in tmux
```bash
tmux new-session -d -s ai-state 'cat <DEV_VAULT_PATH>/.obsidian/plugins/claude-chat/data.json'
tmux capture-pane -pt ai-state:0 -S -200
```

### Verify bridge script exists in installed path
```bash
tmux new-session -d -s ai-bridge 'ls -la <DEV_VAULT_PATH>/.obsidian/plugins/claude-chat/scripts'
tmux capture-pane -pt ai-bridge:0 -S -200
```

### Inspect symlink target
```bash
tmux new-session -d -s ai-link 'ls -ld <DEV_VAULT_PATH>/.obsidian/plugins/claude-chat'
tmux capture-pane -pt ai-link:0 -S -50
```

## How to debug common problems

### 1. Plugin does not load
Check:
- `manifest.json` exists
- `main.js` exists
- plugin folder/symlink path is correct
- Obsidian community plugin is enabled

Useful checks:
```bash
ls -la <DEV_VAULT_PATH>/.obsidian/plugins/claude-chat
ls -la <PLUGIN_SOURCE_PATH>
```

### 2. Commands do not appear
Check:
- plugin actually loaded
- `main.js` rebuilt after source changes
- no startup exception in DevTools console

Then reload Obsidian and re-open command palette.

### 3. Claude Max shows signed in but chat fails
Check in this order:
1. `data.json` contains OAuth token fields
2. bridge file exists at installed path
3. `ClaudeSdkBridge.ts` path matches plugin ID `claude-chat`
4. model name is valid
5. Obsidian runtime can spawn `child_process`

Relevant files:
- `src/chat/ClaudeSdkBridge.ts`
- `scripts/claude-chat-bridge.mjs`
- `<DEV_VAULT_PATH>/.obsidian/plugins/claude-chat/data.json`

### 4. Claude Max sign-in does not complete
Check:
- pasted callback URL/code is present in settings
- token exchange did not fail
- refresh token and expiry values were persisted

Relevant file:
- `src/auth/ClaudeMaxProvider.ts`

### 5. API key mode fails
Check:
- `anthropicApiKey` is set in plugin settings
- bridge script receives `ANTHROPIC_API_KEY` via environment (see `AnthropicApiKeyProvider.getRuntimeEnv()`)
- request/response errors appear in Obsidian notices or console

Relevant files:
- `src/auth/AnthropicApiKeyProvider.ts`

### 6. Bridge script not found
This usually means one of these:
- wrong plugin ID/path in `ClaudeSdkBridge.ts`
- missing script file
- plugin installed in a different vault than expected
- broken symlink

Check:
```bash
ls -ld <DEV_VAULT_PATH>/.obsidian/plugins/claude-chat
ls -la <DEV_VAULT_PATH>/.obsidian/plugins/claude-chat/scripts
```

### 7. esbuild platform mismatch
This workspace has previously hit darwin x64 vs arm64 esbuild mismatch.

Fix with:
```bash
npm rebuild esbuild
```

Then rerun:
```bash
npm run build
```

## Testing checklist

After changes, verify:
1. `npm run build`
2. enable/reload plugin in Obsidian
3. run `Claude chat: Open panel`
4. sign in if needed
5. run `Claude chat: Test connection`
6. send `hi`

## Coding expectations

- Keep `src/main.ts` focused on plugin lifecycle and command/view wiring.
- Keep auth logic in `src/auth/`.
- Keep chat UI/transport logic in `src/chat/`.
- Do not reintroduce reader functionality into this plugin.
- Keep command IDs stable.
- Preserve desktop-only assumptions unless intentionally changed.

## Future improvements

Likely next improvements:
- add dedicated debug log file and command for `claude-chat`
- add import/migration from old reader plugin auth state
- add better bridge stderr/stdout surfacing in UI
- remove stale files if any old bridge/script filenames remain
