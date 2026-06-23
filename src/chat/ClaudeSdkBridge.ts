import { Plugin } from "obsidian";
import { BaseBridge } from "./BaseBridge";
import { getClaudeBridgeSource } from "./BridgeSources";
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

	getBridgeSource(): string {
		return getClaudeBridgeSource();
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
				resumeSessionId: params.resumeSessionId,
				maxTurns: params.maxTurns,
				// Claude SDK doesn't support thinkingLevel
			},
		};
	}
}
