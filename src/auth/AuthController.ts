import { AnthropicApiKeyProvider } from "./AnthropicApiKeyProvider";
import { ClaudeMaxProvider } from "./ClaudeMaxProvider";
import { ChatGptProvider, type ChatGptTokenStore } from "./ChatGptProvider";
import { AuthMode, AuthProvider, AuthSession } from "./types";
import type { PiAuth } from "../chat/types";
import { BridgeType } from "../chat/BridgeFactory";

interface AuthControllerStore {
	authMode: AuthMode;
	anthropicApiKey: string;

	// Claude Max OAuth
	claudeOauthAccessToken: string;
	claudeOauthRefreshToken: string;
	claudeOauthExpiresAt: number;
	claudeOauthScopes: string[];
	claudeOauthAuthorizationCode: string;

	// ChatGPT Plus OAuth
	chatgptAccessToken: string;
	chatgptRefreshToken: string;
	chatgptIdToken: string;
	chatgptExpiresAt: number;
}

export class AuthController {
	private readonly store: AuthControllerStore;
	private readonly apiKeyProvider: AnthropicApiKeyProvider;
	private readonly claudeMaxProvider: ClaudeMaxProvider;
	private readonly chatGptProvider: ChatGptProvider;

	constructor(store: AuthControllerStore) {
		this.store = store;
		this.apiKeyProvider = new AnthropicApiKeyProvider(store);
		this.claudeMaxProvider = new ClaudeMaxProvider(store);
		this.chatGptProvider = new ChatGptProvider(store as ChatGptTokenStore);
	}

	setMode(mode: AuthMode): void {
		this.store.authMode = mode;
	}

	getMode(): AuthMode {
		return this.store.authMode;
	}

	getSession(): AuthSession {
		return this.currentProvider().getSession();
	}

	async startLogin(): Promise<AuthSession> {
		return this.currentProvider().startLogin();
	}

	async logout(): Promise<AuthSession> {
		return this.currentProvider().logout();
	}

	async getAuthHeaders(): Promise<Record<string, string> | null> {
		return this.currentProvider().getAuthHeaders();
	}

	async getRuntimeEnv(): Promise<Record<string, string> | null> {
		return this.currentProvider().getRuntimeEnv();
	}

	/**
	 * Get the bridge type for the current auth mode
	 */
	getBridgeType(): BridgeType {
		switch (this.store.authMode) {
			case "anthropic-api-key":
			case "claude-max":
				return "claude";
			case "chatgpt-plus":
				return "pi";
			default:
				return "claude";
		}
	}

	/**
	 * Get PiAuth credentials for Pi SDK bridge
	 * Returns null for non-Pi auth modes
	 */
	async getPiAuth(): Promise<PiAuth | null> {
		if (this.store.authMode === "chatgpt-plus") {
			return this.chatGptProvider.getPiAuth();
		}
		return null;
	}

	/**
	 * Get the appropriate model for the current provider
	 */
	getDefaultModel(): string {
		switch (this.store.authMode) {
			case "anthropic-api-key":
			case "claude-max":
				return "claude-sonnet-4-5";
			case "chatgpt-plus":
				return "auto"; // Pi SDK selects based on task
			default:
				return "claude-sonnet-4-5";
		}
	}

	private currentProvider(): AuthProvider {
		switch (this.store.authMode) {
			case "claude-max":
				return this.claudeMaxProvider;
			case "chatgpt-plus":
				return this.chatGptProvider;
			case "anthropic-api-key":
			default:
				return this.apiKeyProvider;
		}
	}
}
