import { Plugin } from "obsidian";
import { BaseBridge } from "./BaseBridge";
import { BridgeCapabilities, ChatParams, PiAuth, BridgeStreamHandlers, ChatResult, BridgeStreamEvent } from "./types";

/**
 * Pi SDK Bridge - Subprocess client for @mariozechner/pi-coding-agent
 * 
 * Uses the pi-agent-bridge.mjs script to communicate with the Pi SDK
 * via JSONL protocol over stdin/stdout.
 * 
 * Supports multiple providers:
 * - ChatGPT Plus (via OAuth)
 * - GitHub Copilot (via OAuth)
 * - Anthropic Claude (via API key or OAuth)
 * - AWS Bedrock (via IAM credentials)
 * - Google AI Studio (via API key)
 * 
 * This bridge passes piAuth credentials to the subprocess, which then
 * handles provider-specific authentication internally.
 * 
 * NOTE: This requires the Pi SDK to be installed:
 *   npm install @mariozechner/pi-agent-core @mariozechner/pi-coding-agent
 */

export class PiSdkBridge extends BaseBridge {
	private static isPiSdkAvailable(): boolean {
		try {
			// Check if Pi SDK is available
			require("@mariozechner/pi-coding-agent");
			return true;
		} catch {
			return false;
		}
	}

	constructor(plugin: Plugin) {
		super(plugin);
	}

	getBridgePath(basePath: string): string {
		return `${basePath}/${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/scripts/pi-agent-bridge.mjs`;
	}

	getProviderType(): string {
		return "pi";
	}

	getCapabilities(): BridgeCapabilities {
		return {
			supportsStreaming: true,
			supportsToolExecution: true,
			supportsThinkingLevels: true,
			authType: "oauth",
			availableModels: [
				"auto", // Pi SDK selects based on task complexity
				"openai-codex/gpt-5.5",
				"openai-codex/gpt-5.4",
				"openai-codex/gpt-5.3-codex",
			],
		};
	}

	/**
	 * Send a chat request with Pi auth credentials
	 */
	async chat(params: ChatParams, piAuth?: PiAuth): Promise<ChatResult> {
		this.ensurePiSdkAvailable();
		if (!piAuth) {
			throw new Error("Pi SDK bridge requires piAuth credentials");
		}
		return super.chat(params, piAuth);
	}

	/**
	 * Send a chat request with streaming and Pi auth
	 */
	async chatStream(
		params: ChatParams,
		piAuth?: PiAuth,
		handlers: BridgeStreamHandlers = {}
	): Promise<ChatResult> {
		this.ensurePiSdkAvailable();
		if (!piAuth) {
			throw new Error("Pi SDK bridge requires piAuth credentials");
		}
		return super.chatStream(params, piAuth, handlers);
	}

	/**
	 * Stream events with Pi auth
	 */
	async *streamEvents(params: ChatParams, piAuth?: PiAuth): AsyncGenerator<BridgeStreamEvent> {
		this.ensurePiSdkAvailable();
		if (!piAuth) {
			throw new Error("Pi SDK bridge requires piAuth credentials");
		}
		yield* super.streamEvents(params, piAuth);
	}

	private ensurePiSdkAvailable(): void {
		// In the bridge subprocess, the Pi SDK is loaded via the script
		// This check is for any in-process Pi SDK usage
		// For now, the bridge script handles the SDK dependency
	}
}
