import { AnthropicApiKeyProvider } from "./AnthropicApiKeyProvider";
import { ClaudeMaxProvider } from "./ClaudeMaxProvider";
import { AuthMode, AuthProvider, AuthSession } from "./types";

interface AuthControllerStore {
	authMode: AuthMode;
	anthropicApiKey: string;
	claudeOauthAccessToken: string;
	claudeOauthRefreshToken: string;
	claudeOauthExpiresAt: number;
	claudeOauthScopes: string[];
	claudeOauthAuthorizationCode: string;
}

export class AuthController {
	private readonly store: AuthControllerStore;
	private readonly claudeMaxProvider: ClaudeMaxProvider;
	private readonly apiKeyProvider: AnthropicApiKeyProvider;

	constructor(store: AuthControllerStore) {
		this.store = store;
		this.claudeMaxProvider = new ClaudeMaxProvider(store);
		this.apiKeyProvider = new AnthropicApiKeyProvider(store);
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

	private currentProvider(): AuthProvider {
		return this.store.authMode === "claude-max" ? this.claudeMaxProvider : this.apiKeyProvider;
	}
}
