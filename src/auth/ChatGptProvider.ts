import { Notice, requestUrl } from "obsidian";
import { AuthProvider, AuthSession } from "./types";
import { CHATGPT_OAUTH_CONFIG } from "./ChatGptOAuthConfig";
import { createCallbackServer } from "./CallbackServer";
import type { PiAuth } from "../chat/types";

/**
 * ChatGPT Token Store Interface
 */
export interface ChatGptTokenStore {
	chatgptAccessToken: string;
	chatgptRefreshToken: string;
	chatgptIdToken: string;
	chatgptExpiresAt: number;
}

/**
 * OAuth Token Response from OpenAI
 */
interface OAuthTokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
}

/**
 * Pending PKCE State
 */
interface PendingPkceState {
	state: string;
	codeVerifier: string;
	expiresAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

/**
 * ChatGPT OAuth Provider
 * 
 * Implements PKCE-based OAuth for authenticating with ChatGPT Plus accounts.
 * 
 * Flow:
 * 1. Generate PKCE code verifier and challenge
 * 2. Open browser to OpenAI auth URL
 * 3. Start local callback server on localhost:1455
 * 4. Exchange authorization code for tokens
 * 5. Auto-refresh tokens when near expiry
 */
export class ChatGptProvider implements AuthProvider {
	private pending: PendingPkceState | null = null;
	private refreshInFlight: Promise<void> | null = null;

	constructor(private store: ChatGptTokenStore) {}

	/**
	 * Get current auth session status
	 */
	getSession(): AuthSession {
		if (!this.store.chatgptAccessToken?.trim()) {
			return {
				mode: "chatgpt-plus",
				status: this.pending ? "pending" : "signed-out",
			};
		}

		return {
			mode: "chatgpt-plus",
			status: "signed-in",
			accountLabel: "ChatGPT Plus",
			expiresAt: this.store.chatgptExpiresAt || undefined,
		};
	}

	/**
	 * Start OAuth login flow
	 * 
   * Opens browser to OpenAI auth and starts callback server
	 */
	async startLogin(): Promise<AuthSession> {
		// Generate PKCE state
		this.pending = this.createPkceState();

		// Start callback server
		const callbackServer = await createCallbackServer({
			port: CHATGPT_OAUTH_CONFIG.CALLBACK_PORT,
			timeoutMs: 5 * 60 * 1000, // 5 minute timeout
		});

		// Build authorization URL
		const authUrl = await this.buildAuthUrl(this.pending);

		// Open browser
		window.open(authUrl, "_blank");
		new Notice("ChatGPT login opened in browser. Complete authentication in the browser window...");

			try {
				// Wait for callback
				const result = await callbackServer.promise;
				if (!result.state || result.state !== this.pending.state) {
					throw new Error("OAuth state mismatch. Please retry ChatGPT sign-in.");
				}
				
				// Exchange code for tokens
				const tokens = await this.exchangeCode(result.code, this.pending);
			
			// Persist tokens
			this.persistTokens(tokens);
			this.pending = null;
			
			new Notice("Successfully signed in to ChatGPT Plus!");
			return this.getSession();
		} catch (error) {
			this.pending = null;
			callbackServer.close();
			throw error;
		}
	}

	/**
	 * Logout - clear all tokens
	 */
	async logout(): Promise<AuthSession> {
		this.pending = null;
		this.clearStoredSession();
		return this.getSession();
	}

	/**
	 * Get auth headers (not used for Pi SDK - tokens passed via piAuth)
	 */
	async getAuthHeaders(): Promise<Record<string, string> | null> {
		return null;
	}

	/**
	 * Get runtime environment variables
	 * Auto-refreshes tokens if needed
	 */
	async getRuntimeEnv(): Promise<Record<string, string> | null> {
		if (!this.store.chatgptAccessToken?.trim()) {
			return null;
		}

		// Auto-refresh if needed
		if (this.shouldRefresh()) {
			try {
				await this.refreshAccessTokenWithMutex();
			} catch (error) {
				this.clearStoredSession();
				throw new Error("ChatGPT session expired. Please sign in again.");
			}
		}

		return {
			CHATGPT_ACCESS_TOKEN: this.store.chatgptAccessToken,
			CHATGPT_REFRESH_TOKEN: this.store.chatgptRefreshToken,
		};
	}

	/**
	 * Get PiAuth credentials for Pi SDK bridge
	 */
	async getPiAuth(): Promise<PiAuth | null> {
		// Ensure tokens are fresh
		await this.getRuntimeEnv();

		if (!this.store.chatgptAccessToken) {
			return null;
		}

		return {
			provider: "openai-codex",
			credential: {
				type: "oauth",
				access: this.store.chatgptAccessToken,
				refresh: this.store.chatgptRefreshToken,
				expires: this.store.chatgptExpiresAt,
			},
		};
	}

	/**
	 * Create PKCE state with code verifier
	 */
	private createPkceState(): PendingPkceState {
		const state = this.randomHex(32);
		const codeVerifier = this.randomBase64Url(32);
		return {
			state,
			codeVerifier,
			expiresAt: Date.now() + STATE_TTL_MS,
		};
	}

	/**
	 * Build the OAuth authorization URL
	 */
	private async buildAuthUrl(pending: PendingPkceState): Promise<string> {
		const codeChallenge = await this.sha256Base64Url(pending.codeVerifier);

		const params = new URLSearchParams({
			client_id: CHATGPT_OAUTH_CONFIG.CLIENT_ID,
			response_type: "code",
			redirect_uri: CHATGPT_OAUTH_CONFIG.REDIRECT_URI,
			scope: CHATGPT_OAUTH_CONFIG.SCOPES,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			state: pending.state,
			codex_cli_simplified_flow: "true",
			id_token_add_organizations: "true",
		});

		return `${CHATGPT_OAUTH_CONFIG.AUTH_URL}?${params.toString()}`;
	}

	/**
	 * Exchange authorization code for tokens
	 */
	private async exchangeCode(code: string, pending: PendingPkceState): Promise<OAuthTokenResponse> {
		if (Date.now() > pending.expiresAt) {
			throw new Error("Login session expired after 10 minutes. Please try again.");
		}

		const params = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CHATGPT_OAUTH_CONFIG.CLIENT_ID,
			code,
			redirect_uri: CHATGPT_OAUTH_CONFIG.REDIRECT_URI,
			code_verifier: pending.codeVerifier,
		});

		const response = await requestUrl({
			url: CHATGPT_OAUTH_CONFIG.TOKEN_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: params.toString(),
		});

		if (response.status < 200 || response.status >= 300) {
			const errorText = response.text;
			throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
		}

		return response.json as OAuthTokenResponse;
	}

	/**
	 * Refresh access token with mutex to prevent concurrent refreshes
	 */
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

	/**
	 * Refresh the access token using the refresh token
	 */
	private async refreshAccessToken(): Promise<void> {
		const refreshToken = this.store.chatgptRefreshToken?.trim();
		if (!refreshToken) {
			throw new Error("No refresh token available");
		}

		const params = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CHATGPT_OAUTH_CONFIG.CLIENT_ID,
			refresh_token: refreshToken,
		});

		const response = await requestUrl({
			url: CHATGPT_OAUTH_CONFIG.TOKEN_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: params.toString(),
		});

		if (response.status < 200 || response.status >= 300) {
			const errorText = response.text;
			// Check if refresh token is invalid
			if (response.status === 400 || response.status === 401) {
				throw new Error("Refresh token invalid or revoked");
			}
			throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
		}

		const data = response.json as OAuthTokenResponse;
		this.persistTokens({
			access_token: data.access_token,
			refresh_token: data.refresh_token || refreshToken,
			id_token: data.id_token,
			expires_in: data.expires_in || 3600, // Default 1 hour if not provided
			token_type: data.token_type,
		});
	}

	/**
	 * Check if token should be refreshed
	 */
	private shouldRefresh(): boolean {
		const expiresAt = this.store.chatgptExpiresAt;
		if (!expiresAt) return false;
		return Date.now() + REFRESH_BUFFER_MS >= expiresAt;
	}

	/**
	 * Persist tokens to store
	 */
	private persistTokens(tokens: OAuthTokenResponse): void {
		this.store.chatgptAccessToken = tokens.access_token;
		this.store.chatgptRefreshToken = tokens.refresh_token || this.store.chatgptRefreshToken;
		this.store.chatgptIdToken = tokens.id_token || this.store.chatgptIdToken;
		// Default to 1 hour expiry if not provided
		const expiresIn = tokens.expires_in || 3600;
		this.store.chatgptExpiresAt = Date.now() + expiresIn * 1000;
	}

	/**
	 * Clear all stored session data
	 */
	private clearStoredSession(): void {
		this.store.chatgptAccessToken = "";
		this.store.chatgptRefreshToken = "";
		this.store.chatgptIdToken = "";
		this.store.chatgptExpiresAt = 0;
	}

	// ============================================================================
	// Crypto Helpers
	// ============================================================================

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
		return this.arrayBufferToBase64Url(arr);
	}

	private async sha256Base64Url(value: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(value);
		const hash = await crypto.subtle.digest("SHA-256", data);
		return this.arrayBufferToBase64Url(new Uint8Array(hash));
	}

	private arrayBufferToBase64Url(buffer: Uint8Array): string {
		let binary = "";
		for (let i = 0; i < buffer.byteLength; i++) {
			const byte = buffer[i];
			if (byte !== undefined) {
				binary += String.fromCharCode(byte);
			}
		}
		return btoa(binary)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
	}
}
