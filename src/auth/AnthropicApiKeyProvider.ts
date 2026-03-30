import { AuthProvider, AuthSession } from "./types";

interface ApiKeyStore {
	anthropicApiKey: string;
}

export class AnthropicApiKeyProvider implements AuthProvider {
	private readonly store: ApiKeyStore;

	constructor(store: ApiKeyStore) {
		this.store = store;
	}

	getSession(): AuthSession {
		const hasKey = Boolean(this.store.anthropicApiKey?.trim());
		return {
			mode: "anthropic-api-key",
			status: hasKey ? "signed-in" : "signed-out",
			accountLabel: hasKey ? "Anthropic API key" : undefined
		};
	}

	async startLogin(): Promise<AuthSession> {
		return this.getSession();
	}

	async logout(): Promise<AuthSession> {
		this.store.anthropicApiKey = "";
		return this.getSession();
	}

	async getAuthHeaders(): Promise<Record<string, string> | null> {
		const key = this.store.anthropicApiKey?.trim();
		if (!key) {
			return null;
		}

		return {
			"x-api-key": key
		};
	}

	async getRuntimeEnv(): Promise<Record<string, string> | null> {
		const key = this.store.anthropicApiKey?.trim();
		if (!key) {
			return null;
		}
		return {
			ANTHROPIC_API_KEY: key
		};
	}
}
