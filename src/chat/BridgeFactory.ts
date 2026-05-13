import { Plugin } from "obsidian";
import { BaseBridge } from "./BaseBridge";
import { ClaudeSdkBridge } from "./ClaudeSdkBridge";
import { PiSdkBridge } from "./PiSdkBridge";

/**
 * Bridge Type
 * - "claude": Uses @anthropic-ai/claude-agent-sdk
 * - "pi": Uses @mariozechner/pi-coding-agent (supports ChatGPT, Copilot, etc.)
 */
export type BridgeType = "claude" | "pi";

/**
 * Factory for creating and caching bridge instances
 * 
 * Bridges are cached per type to avoid recreating subprocess handlers.
 * Call clearCache() when the plugin unloads to clean up resources.
 */
export class BridgeFactory {
	private static bridges: Map<BridgeType, BaseBridge> = new Map();

	/**
	 * Get a bridge instance for the given type
	 * Creates and caches the bridge if it doesn't exist
	 */
	static getBridge(type: BridgeType, plugin: Plugin): BaseBridge {
		if (!this.bridges.has(type)) {
			const bridge = this.createBridge(type, plugin);
			this.bridges.set(type, bridge);
		}
		return this.bridges.get(type)!;
	}

	/**
	 * Create a new bridge instance (without caching)
	 */
	static createBridge(type: BridgeType, plugin: Plugin): BaseBridge {
		switch (type) {
			case "claude":
				return new ClaudeSdkBridge(plugin);
			case "pi":
				return new PiSdkBridge(plugin);
			default:
				throw new Error(`Unknown bridge type: ${type}`);
		}
	}

	/**
	 * Check if a bridge type is supported
	 */
	static isSupported(type: string): type is BridgeType {
		return type === "claude" || type === "pi";
	}

	/**
	 * Get the bridge type for an auth mode
	 */
	static getBridgeTypeForAuthMode(authMode: string): BridgeType {
		switch (authMode) {
			case "anthropic-api-key":
			case "claude-max":
				return "claude";
			case "chatgpt-plus":
			case "github-copilot":
				return "pi";
			default:
				return "claude";
		}
	}

	/**
	 * Clear the bridge cache
	 * Call this when the plugin unloads to stop any active processes
	 */
	static clearCache(): void {
		// Stop any active processes before clearing
		for (const bridge of this.bridges.values()) {
			bridge.stop();
		}
		this.bridges.clear();
	}

	/**
	 * Stop all active bridges
	 */
	static stopAll(): void {
		for (const bridge of this.bridges.values()) {
			bridge.stop();
		}
	}
}
