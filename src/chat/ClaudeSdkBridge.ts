import { Plugin } from "obsidian";
import { BaseBridge } from "./BaseBridge";
import { BridgeCapabilities, ChatParams } from "./types";

/**
 * Claude SDK Bridge - Subprocess client for @anthropic-ai/claude-agent-sdk
 *
 * Uses the claude-chat-bridge.mjs script to communicate with the Claude SDK
 * via JSONL protocol over stdin/stdout.
 *
 * Supports:
 * - Claude Max OAuth (via CLAUDE_CODE_OAUTH_TOKEN)
 * - Anthropic API Key (via ANTHROPIC_API_KEY)
 */

export class ClaudeSdkBridge extends BaseBridge {
	constructor(plugin: Plugin) {
		super(plugin);
	}

	getBridgePath(basePath: string): string {
		return `${basePath}/.obsidian/plugins/obsidian-ai/scripts/claude-chat-bridge.mjs`;
	}

	getProviderType(): string {
		return "claude";
	}

	getCapabilities(): BridgeCapabilities {
		return {
			supportsStreaming: true,
			supportsToolExecution: true,
			supportsThinkingLevels: false,
			authType: "oauth",
			availableModels: [
				"claude-sonnet-4-5-20250929",
				"claude-opus-4-6-20251014",
				"claude-haiku-4-5-20250929",
			],
		};
	}

	/**
	 * Override buildRequest to filter out Pi-specific fields
	 * that Claude SDK doesn't understand
	 */
	protected buildRequest(
		method: "ping" | "chat",
		params: ChatParams
	): Record<string, unknown> {
		// Claude SDK doesn't use piAuth, so we don't pass it
		return {
			id: `claude-${Date.now()}-${++this.seq}`,
			method,
			payload: {
				prompt: params.prompt,
				model: params.model,
				systemPrompt: params.systemPrompt,
				cwd: params.cwd,
				activeFilePath: params.activeFilePath,
				// Claude SDK doesn't support maxTurns or thinkingLevel
			},
		};
	}
}
