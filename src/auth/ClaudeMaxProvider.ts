import { Notice, requestUrl } from "obsidian";
import { AuthProvider, AuthSession } from "./types";

interface ClaudeOauthStore {
	claudeOauthAccessToken: string;
	claudeOauthRefreshToken: string;
	claudeOauthExpiresAt: number;
	claudeOauthScopes: string[];
	claudeOauthAuthorizationCode: string;
}

interface PendingPkceState {
	state: string;
	codeVerifier: string;
	expiresAt: number;
}

interface OAuthTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
}

const CLAUDE_OAUTH_CONFIG = {
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	authUrl: "https://claude.ai/oauth/authorize",
	tokenUrl: "https://platform.claude.com/v1/oauth/token",
	redirectUri: "https://console.anthropic.com/oauth/code/callback",
	scopes: "org:create_api_key user:profile user:inference"
} as const;

const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class ClaudeMaxProvider implements AuthProvider {
	private readonly store: ClaudeOauthStore;
	private pending: PendingPkceState | null = null;

	constructor(store: ClaudeOauthStore) {
		this.store = store;
	}

	getSession(): AuthSession {
		if (!this.store.claudeOauthAccessToken.trim()) {
			return {
				mode: "claude-max",
				status: this.pending ? "pending" : "signed-out"
			};
		}

		return {
			mode: "claude-max",
			status: "signed-in",
			accountLabel: "Claude Max OAuth",
			expiresAt: this.store.claudeOauthExpiresAt || undefined,
			scopes: this.store.claudeOauthScopes
		};
	}

	async startLogin(): Promise<AuthSession> {
		if (!this.pending) {
			this.pending = this.createPendingState();
			const loginUrl = await this.buildAuthorizationUrl(this.pending);
			window.open(loginUrl, "_blank");
			new Notice("Opened Claude login. Paste callback URL/code into settings field, then click Test connection (or Sign in again).");
			return this.getSession();
		}

		const code = this.extractCode(this.store.claudeOauthAuthorizationCode?.trim() || "");
		if (!code) {
			throw new Error("No Claude OAuth code found. Paste callback URL/code in settings, then click Sign in again.");
		}

		const tokens = await this.exchangeCodeForTokens(code, this.pending);
		this.pending = null;
		this.persistTokens(tokens);
		this.store.claudeOauthAuthorizationCode = "";
		return this.getSession();
	}

	async logout(): Promise<AuthSession> {
		this.pending = null;
		this.store.claudeOauthAccessToken = "";
		this.store.claudeOauthRefreshToken = "";
		this.store.claudeOauthExpiresAt = 0;
		this.store.claudeOauthScopes = [];
		this.store.claudeOauthAuthorizationCode = "";
		return this.getSession();
	}

	async getAuthHeaders(): Promise<Record<string, string> | null> {
		const env = await this.getRuntimeEnv();
		if (!env?.CLAUDE_CODE_OAUTH_TOKEN) {
			return null;
		}
		return {
			Authorization: `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`
		};
	}

	async getRuntimeEnv(): Promise<Record<string, string> | null> {
		if (!this.store.claudeOauthAccessToken.trim()) {
			if (this.pending) {
				const code = this.extractCode(this.store.claudeOauthAuthorizationCode?.trim() || "");
				if (code) {
					const tokens = await this.exchangeCodeForTokens(code, this.pending);
					this.pending = null;
					this.persistTokens(tokens);
					this.store.claudeOauthAuthorizationCode = "";
				} else {
					return null;
				}
			} else {
				return null;
			}
		}

		if (this.shouldRefresh()) {
			await this.refreshAccessToken();
		}

		if (!this.store.claudeOauthAccessToken.trim()) {
			return null;
		}

		return {
			CLAUDE_CODE_OAUTH_TOKEN: this.store.claudeOauthAccessToken
		};
	}

	private createPendingState(): PendingPkceState {
		const state = this.randomHex(32);
		const codeVerifier = this.randomBase64Url(32);
		return {
			state,
			codeVerifier,
			expiresAt: Date.now() + STATE_TTL_MS
		};
	}

	private async buildAuthorizationUrl(pending: PendingPkceState): Promise<string> {
		const challenge = await this.sha256Base64Url(pending.codeVerifier);

		const params = new URLSearchParams({
			code: "true",
			client_id: CLAUDE_OAUTH_CONFIG.clientId,
			response_type: "code",
			redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
			scope: CLAUDE_OAUTH_CONFIG.scopes,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: pending.state
		});

		return `${CLAUDE_OAUTH_CONFIG.authUrl}?${params.toString()}`;
	}

	private extractCode(input: string): string {
		if (!input.trim()) {
			return "";
		}
		if (!input.includes("code=")) {
			return input;
		}

		try {
			const asUrl = new URL(input);
			return asUrl.searchParams.get("code") || input;
		} catch {
			const match = input.match(/[?&]code=([^&#]+)/);
			if (match && match[1]) {
				return decodeURIComponent(match[1]);
			}
			return input;
		}
	}

	private async exchangeCodeForTokens(code: string, pending: PendingPkceState): Promise<OAuthTokenResponse> {
		if (Date.now() > pending.expiresAt) {
			throw new Error("Claude login expired after 10 minutes. Please retry.");
		}

		const response = await requestUrl({
			url: CLAUDE_OAUTH_CONFIG.tokenUrl,
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": "ObsidianAI/1.0.0"
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: CLAUDE_OAUTH_CONFIG.clientId,
				code,
				redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
				code_verifier: pending.codeVerifier,
				state: pending.state
			})
		});

		if (response.status < 200 || response.status >= 300) {
			const msg = this.extractErrorMessage(response.json);
			throw new Error(`Claude token exchange failed (${response.status}): ${msg}`);
		}

		return response.json as OAuthTokenResponse;
	}

	private async refreshAccessToken(): Promise<void> {
		const refreshToken = this.store.claudeOauthRefreshToken?.trim();
		if (!refreshToken) {
			throw new Error("Claude session expired and no refresh token is available. Sign in again.");
		}

		const response = await requestUrl({
			url: CLAUDE_OAUTH_CONFIG.tokenUrl,
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": "ObsidianAI/1.0.0"
			},
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLAUDE_OAUTH_CONFIG.clientId
			})
		});

		if (response.status < 200 || response.status >= 300) {
			const msg = this.extractErrorMessage(response.json);
			throw new Error(`Claude token refresh failed (${response.status}): ${msg}`);
		}

		this.persistTokens(response.json as OAuthTokenResponse);
	}

	private persistTokens(tokens: OAuthTokenResponse): void {
		this.store.claudeOauthAccessToken = tokens.access_token;
		this.store.claudeOauthRefreshToken = tokens.refresh_token || this.store.claudeOauthRefreshToken;
		this.store.claudeOauthExpiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : 0;
		this.store.claudeOauthScopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : this.store.claudeOauthScopes;
	}

	private shouldRefresh(): boolean {
		const expiresAt = this.store.claudeOauthExpiresAt;
		if (!expiresAt) {
			return false;
		}
		return Date.now() + REFRESH_BUFFER_MS >= expiresAt;
	}

	private randomHex(bytes: number): string {
		const arr = new Uint8Array(bytes);
		crypto.getRandomValues(arr);
		return Array.from(arr)
			.map((v) => v.toString(16).padStart(2, "0"))
			.join("");
	}

	private randomBase64Url(bytes: number): string {
		const arr = new Uint8Array(bytes);
		crypto.getRandomValues(arr);
		return this.toBase64Url(arr);
	}

	private async sha256Base64Url(value: string): Promise<string> {
		const data = new TextEncoder().encode(value);
		const digest = await crypto.subtle.digest("SHA-256", data);
		return this.toBase64Url(new Uint8Array(digest));
	}

	private toBase64Url(bytes: Uint8Array): string {
		let binary = "";
		bytes.forEach((byte) => {
			binary += String.fromCharCode(byte);
		});
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	}

	private extractErrorMessage(payload: unknown): string {
		if (!payload || typeof payload !== "object") {
			return "Unknown error";
		}

		const root = payload as Record<string, unknown>;
		if (typeof root.error_description === "string" && root.error_description.trim()) {
			return root.error_description;
		}
		if (typeof root.error === "string" && root.error.trim()) {
			return root.error;
		}

		const nestedError = root.error;
		if (nestedError && typeof nestedError === "object") {
			const nested = nestedError as Record<string, unknown>;
			if (typeof nested.message === "string" && nested.message.trim()) {
				return nested.message;
			}
		}

		return "Unknown error";
	}
}
