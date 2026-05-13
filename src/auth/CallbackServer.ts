/**
 * OAuth Callback Server
 * 
 * Creates a local HTTP server to receive OAuth callbacks.
 * Used for ChatGPT Plus and other OAuth flows that redirect to localhost.
 * 
 * Based on Craft Agents callback-server.ts pattern.
 */

import { CHATGPT_OAUTH_CONFIG } from "./ChatGptOAuthConfig";

export interface CallbackResult {
	code: string;
	state?: string;
}

export interface CallbackServer {
	/** Promise that resolves when callback is received */
	promise: Promise<CallbackResult>;
	/** URL to redirect to (e.g., http://localhost:1455) */
	url: string;
	/** Close the callback server */
	close: () => void;
}

interface CreateCallbackServerOptions {
	/** Specific port to bind to (defaults to CHATGPT_OAUTH_CONFIG.CALLBACK_PORT) */
	port?: number;
	/** Timeout in milliseconds (defaults to 5 minutes) */
	timeoutMs?: number;
}

/**
 * Create an OAuth callback server
 * 
 * Binds to localhost and waits for the OAuth provider to redirect back
 * with an authorization code.
 */
export async function createCallbackServer(
	options: CreateCallbackServerOptions = {}
): Promise<CallbackServer> {
	const port = options.port ?? CHATGPT_OAUTH_CONFIG.CALLBACK_PORT;
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000; // 5 minutes

	// Dynamically import http module (Node.js only)
	const http = window.require("http") as typeof import("http");

	let server: import("http").Server | null = null;
	let resolveCallback: ((result: CallbackResult) => void) | null = null;
	let rejectCallback: ((error: Error) => void) | null = null;

	const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});

	// Create HTTP server
	server = http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "/", `http://localhost:${port}`);

			// Only handle callback paths
			if (url.pathname !== "/auth/callback" && url.pathname !== "/callback") {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end("<h1>Not Found</h1>");
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") || undefined;
			const error = url.searchParams.get("error");
			const errorDescription = url.searchParams.get("error_description");

			// Handle OAuth error
			if (error) {
				const errorMsg = errorDescription || error;
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`
					<html>
						<head><title>Authentication Failed</title></head>
						<body style="font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px;">
							<h1 style="color: #dc2626;">❌ Authentication Failed</h1>
							<p>${errorMsg}</p>
							<p>You can close this window and return to Obsidian.</p>
						</body>
					</html>
				`);
				server?.close();
				rejectCallback?.(new Error(`OAuth error: ${errorMsg}`));
				return;
			}

			// Handle successful authentication
			if (code) {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(`
					<html>
						<head><title>Authentication Complete</title></head>
						<body style="font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px;">
							<h1 style="color: #16a34a;">✅ Authentication Complete</h1>
							<p>You have successfully signed in. You can close this window and return to Obsidian.</p>
						</body>
					</html>
				`);
				server?.close();
				resolveCallback?.({ code, state });
				return;
			}

			// Missing code
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`
				<html>
					<head><title>Authentication Failed</title></head>
					<body style="font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px;">
						<h1 style="color: #dc2626;">❌ Authentication Failed</h1>
						<p>No authorization code received. Please try again.</p>
					</body>
				</html>
			`);
			server?.close();
			rejectCallback?.(new Error("No authorization code received"));
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`
				<html>
					<head><title>Error</title></head>
					<body>
						<h1>Error</h1>
						<p>${errorMsg}</p>
					</body>
				</html>
			`);
			server?.close();
			rejectCallback?.(err instanceof Error ? err : new Error(errorMsg));
		}
	});

	// Start server
	await new Promise<void>((resolve, reject) => {
		server?.listen(port, "localhost", () => {
			console.log(`[CallbackServer] Listening on http://localhost:${port}`);
			resolve();
		});
		server?.on("error", (err) => {
			reject(err);
		});
	});

	// Set up timeout
	const timeoutId = window.setTimeout(() => {
		server?.close();
		rejectCallback?.(new Error("OAuth callback timeout - please try again"));
	}, timeoutMs);

	return {
		promise: callbackPromise.finally(() => {
			window.clearTimeout(timeoutId);
		}),
		url: `http://localhost:${port}`,
		close: () => {
			window.clearTimeout(timeoutId);
			server?.close();
		},
	};
}
