import { Notice, requestUrl } from "obsidian";
import { AuthProvider, AuthSession } from "./types";

interface ClaudeOauthStore {
	claudeOauthAccessToken: string;
	claudeOauthRefreshToken: string;
	claudeOauthExpiresAt: number;
	claudeOauthScopes: string[];
	claudeOauthAuthorizationCode: string;
	claudeOauthPendingState: string;
	claudeOauthPendingCodeVerifier: string;
	claudeOauthPendingExpiresAt: number;
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
	error?: string;
	error_description?: string;
}

class OAuthTokenRequestError extends Error {
	readonly status: number;
	readonly payload: unknown;
	readonly oauthError?: string;
	readonly oauthErrorDescription?: string;

	constructor(status: number, payload: unknown, message: string) {
		super(message);
		this.name = "OAuthTokenRequestError";
		this.status = status;
		this.payload = payload;

		if (payload && typeof payload === "object") {
			const root = payload as Record<string, unknown>;
			this.oauthError = typeof root.error === "string" ? root.error : undefined;
			this.oauthErrorDescription = typeof root.error_description === "string"
				? root.error_description
				: undefined;
		}
	}
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
	private refreshInFlight: Promise<void> | null = null;

	constructor(store: ClaudeOauthStore) {
		this.store = store;
	}

	getSession(): AuthSession {
		if (!this.store.claudeOauthAccessToken.trim()) {
			return {
				mode: "claude-max",
				status: this.getPendingState() ? "pending" : "signed-out"
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
		const pending = this.getPendingState();
		if (!pending) {
			const nextPending = this.createPendingState();
			this.setPendingState(nextPending);
			this.store.claudeOauthAuthorizationCode = "";
			const loginUrl = await this.buildAuthorizationUrl(nextPending);
			window.open(loginUrl, "_blank");
			new Notice("Opened Claude login. Paste callback URL/code into settings field, then click Test connection (or Sign in again).");
			return this.getSession();
		}

		const code = this.extractCode(this.store.claudeOauthAuthorizationCode?.trim() || "");
		if (!code) {
			throw new Error("No Claude OAuth code found. Paste callback URL/code in settings, then click Sign in again.");
		}

		const tokens = await this.exchangeCodeForTokens(code, pending);
		this.clearPendingState();
		this.persistTokens(tokens);
		this.store.claudeOauthAuthorizationCode = "";
		return this.getSession();
	}

	async logout(): Promise<AuthSession> {
		this.clearPendingState();
		this.clearStoredSession();
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
			const pending = this.getPendingState();
			if (pending) {
				const code = this.extractCode(this.store.claudeOauthAuthorizationCode?.trim() || "");
				if (code) {
					const tokens = await this.exchangeCodeForTokens(code, pending);
					this.clearPendingState();
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
			try {
				await this.refreshAccessTokenWithMutex();
			} catch (error) {
				if (this.shouldClearSessionAfterRefreshFailure(error)) {
					this.clearStoredSession();
					throw new Error("Claude session expired or was revoked. Sign in again.");
				}
				throw error;
			}
		}

		if (!this.store.claudeOauthAccessToken.trim()) {
			return null;
		}

		return {
			CLAUDE_CODE_OAUTH_TOKEN: this.store.claudeOauthAccessToken
		};
	}

	private getPendingState(): PendingPkceState | null {
		if (this.pending && Date.now() <= this.pending.expiresAt) {
			return this.pending;
		}

		const pendingState = this.store.claudeOauthPendingState?.trim();
		const codeVerifier = this.store.claudeOauthPendingCodeVerifier?.trim();
		const expiresAt = this.store.claudeOauthPendingExpiresAt || 0;
		if (!pendingState || !codeVerifier || Date.now() > expiresAt) {
			this.clearPendingState();
			return null;
		}

		this.pending = {
			state: pendingState,
			codeVerifier,
			expiresAt
		};
		return this.pending;
	}

	private setPendingState(pending: PendingPkceState): void {
		this.pending = pending;
		this.store.claudeOauthPendingState = pending.state;
		this.store.claudeOauthPendingCodeVerifier = pending.codeVerifier;
		this.store.claudeOauthPendingExpiresAt = pending.expiresAt;
	}

	private clearPendingState(): void {
		this.pending = null;
		this.store.claudeOauthPendingState = "";
		this.store.claudeOauthPendingCodeVerifier = "";
		this.store.claudeOauthPendingExpiresAt = 0;
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
		const trimmed = input.trim();
		if (!trimmed) {
			return "";
		}

		if (trimmed.includes("code=")) {
			try {
				const asUrl = new URL(trimmed);
				const urlCode = asUrl.searchParams.get("code");
				if (urlCode?.trim()) {
					return urlCode.trim();
				}
			} catch {
				const match = trimmed.match(/[?&]code=([^&#]+)/);
				if (match?.[1]) {
					return decodeURIComponent(match[1]).trim();
				}
			}
		}

		const rawCode = trimmed.split("#", 1)[0]?.trim() ?? "";
		return rawCode;
	}

	private async exchangeCodeForTokens(code: string, pending: PendingPkceState): Promise<OAuthTokenResponse> {
		if (Date.now() > pending.expiresAt) {
			throw new Error("Claude login expired after 10 minutes. Please retry.");
		}

		return await this.postOAuthTokenRequest({
			grant_type: "authorization_code",
			client_id: CLAUDE_OAUTH_CONFIG.clientId,
			code,
			redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
			code_verifier: pending.codeVerifier,
			state: pending.state
		});
	}

	private async refreshAccessTokenWithMutex(): Promise<void> {
		if (this.refreshInFlight) {
			await this.refreshInFlight;
			return;
		}

		this.refreshInFlight = this.refreshAccessToken().finally(() => {
			this.refreshInFlight = null;
		});

		await this.refreshInFlight;
	}

	private async refreshAccessToken(): Promise<void> {
		const refreshToken = this.store.claudeOauthRefreshToken?.trim();
		if (!refreshToken) {
			throw new Error("Claude session expired and no refresh token is available. Sign in again.");
		}

		const tokens = await this.postOAuthTokenRequest({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLAUDE_OAUTH_CONFIG.clientId
		});

		this.persistTokens(tokens);
	}

	private async postOAuthTokenRequest(body: Record<string, unknown>): Promise<OAuthTokenResponse> {
		const response = await requestUrl({
			url: CLAUDE_OAUTH_CONFIG.tokenUrl,
			method: "POST",
			contentType: "application/json",
			headers: {
				accept: "application/json",
				"user-agent": "ObsidianAI/1.0.0"
			},
			body: JSON.stringify(body),
			throw: false
		});

		const raw = response.text;
		const payload = this.parsePayload(raw);
		if (response.status < 200 || response.status >= 300) {
			throw this.createOAuthTokenRequestError(response.status, payload);
		}

		if (!payload || typeof payload !== "object") {
			throw new Error("Claude OAuth token endpoint returned an invalid response payload.");
		}

		return payload as OAuthTokenResponse;
	}

	private createOAuthTokenRequestError(status: number, payload: unknown): OAuthTokenRequestError {
		const msg = this.extractErrorMessage(payload);
		const detail = this.stringifyErrorPayload(payload);
		const text = `Claude OAuth request failed (${status}): ${msg}${detail ? ` | payload: ${detail}` : ""}`;
		return new OAuthTokenRequestError(status, payload, text);
	}

	private shouldClearSessionAfterRefreshFailure(error: unknown): boolean {
		if (error instanceof OAuthTokenRequestError) {
			const normalizedError = error.oauthError?.toLowerCase() ?? "";
			const normalizedDescription = error.oauthErrorDescription?.toLowerCase() ?? "";
			if (normalizedError.includes("invalid_grant") || normalizedError.includes("invalid_refresh")) {
				return true;
			}
			if (normalizedDescription.includes("refresh token") || normalizedDescription.includes("revoked") || normalizedDescription.includes("expired")) {
				return true;
			}
		}

		const message = error instanceof Error ? error.message.toLowerCase() : "";
		return message.includes("invalid_grant")
			|| message.includes("invalid refresh")
			|| message.includes("refresh token not found")
			|| message.includes("revoked");
	}

	private clearStoredSession(): void {
		this.store.claudeOauthAccessToken = "";
		this.store.claudeOauthRefreshToken = "";
		this.store.claudeOauthExpiresAt = 0;
		this.store.claudeOauthScopes = [];
		this.store.claudeOauthAuthorizationCode = "";
		this.clearPendingState();
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

	private parsePayload(raw: string): unknown {
		const trimmed = raw.trim();
		if (!trimmed) {
			return {};
		}
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed;
		}
	}

	private extractErrorMessage(payload: unknown): string {
		if (!payload || typeof payload !== "object") {
			return typeof payload === "string" && payload.trim() ? payload.trim() : "Unknown error";
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

	private stringifyErrorPayload(payload: unknown): string {
		if (payload == null) {
			return "";
		}

		if (typeof payload === "string") {
			return payload.trim();
		}

		try {
			return JSON.stringify(payload);
		} catch {
			return "";
		}
	}
}
