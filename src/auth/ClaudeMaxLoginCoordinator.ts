import type ObsidianAiPlugin from "../main";
import { CLAUDE_OAUTH_CONFIG } from "./ClaudeOAuthConfig";
import type { AuthSession } from "./types";

export interface ClaudeMaxLoginCallbacks {
	onBrowserOpened(): void;
	onError(msg: string): void;
}

export class ClaudeMaxLoginCoordinator {
	private plugin: ObsidianAiPlugin;

	constructor(plugin: ObsidianAiPlugin) {
		this.plugin = plugin;
	}

	// Phase 1: open browser, persist pending PKCE state.
	// Calls onBrowserOpened when the browser window has been opened.
	async beginLogin(callbacks: ClaudeMaxLoginCallbacks): Promise<void> {
		try {
			// startChatLogin with no pending state opens the browser (phase 1)
			await this.plugin.startChatLogin();
			callbacks.onBrowserOpened();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			callbacks.onError(msg);
		}
	}

	// Phase 2: write the pasted URL/code into settings, then exchange for tokens.
	async confirmWithUrl(rawUrl: string): Promise<AuthSession> {
		this.plugin.settings.claudeOauthAuthorizationCode = rawUrl.trim();
		await this.plugin.saveSettings();
		// startChatLogin with pending state + code set performs the exchange
		return await this.plugin.startChatLogin();
	}

	// Re-open the authorization URL without resetting PKCE state.
	// Reads the pending state that was already saved to disk and re-opens the URL.
	async reopenBrowser(): Promise<void> {
		const { settings } = this.plugin;
		const state = settings.claudeOauthPendingState?.trim();
		const verifier = settings.claudeOauthPendingCodeVerifier?.trim();
		if (!state || !verifier) return;

		// Rebuild auth URL from persisted PKCE state
		const codeChallenge = await this.sha256Base64Url(verifier);
		const params = new URLSearchParams({
			code: "true",
			client_id: CLAUDE_OAUTH_CONFIG.clientId,
			response_type: "code",
			redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
			scope: CLAUDE_OAUTH_CONFIG.scopes,
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			state,
		});
		window.open(`${CLAUDE_OAUTH_CONFIG.authUrl}?${params.toString()}`, "_blank");
	}

	cancel(): void {
		// Clear the pending state so a fresh flow can start
		this.plugin.settings.claudeOauthAuthorizationCode = "";
		void this.plugin.saveSettings();
	}

	private async sha256Base64Url(plain: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(plain);
		const digest = await window.crypto.subtle.digest("SHA-256", data);
		return btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	}
}
