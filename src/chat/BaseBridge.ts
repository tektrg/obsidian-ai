import { Plugin } from "obsidian";
import { EventQueue } from "./EventQueue";
import {
	BridgeStreamEvent,
	BridgeStreamHandlers,
	ChatParams,
	ChatResult,
	PiAuth,
	BridgeCapabilities,
} from "./types";

/**
 * BaseBridge - Abstract base class for all LLM backend bridges
 * 
 * Provides common functionality for:
 * - Subprocess lifecycle management
 * - Event streaming via EventQueue
 * - Request cancellation
 * - JSONL protocol handling
 * 
 * Subclasses must implement:
 * - getBridgePath(): Path to the bridge script
 * - getProviderType(): Identifier for the provider
 * - getCapabilities(): Feature flags for this bridge
 * - buildRequest(): Construct the bridge-specific request
 */

const REQUEST_TIMEOUT_MS = 300000; // 5 minutes for complex tasks

let cachedNodePath: string | undefined;

function resolveNodePath(childProcessModule: unknown): string {
	if (cachedNodePath) return cachedNodePath;

	const cp = childProcessModule as {
		execSync?: (command: string, options: { encoding: string; shell?: boolean }) => Buffer | string;
	};

	// Try user's login shell first (picks up nvm, brew, etc.)
	const shells = ["/bin/zsh", "/bin/bash"];
	for (const shell of shells) {
		try {
			const result = cp.execSync?.(`${shell} -ilc 'which node'`, { encoding: "utf8", shell: false });
			const path = result?.toString().trim();
			if (path) {
				cachedNodePath = path;
				return path;
			}
		} catch {
			// continue to next shell
		}
	}

	// Fallback: common absolute paths
	const commonPaths = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"];
	for (const p of commonPaths) {
		try {
			cp.execSync?.(`test -x "${p}"`, { encoding: "utf8", shell: true });
			cachedNodePath = p;
			return p;
		} catch {
			// continue
		}
	}

	cachedNodePath = "node";
	return cachedNodePath;
}

export abstract class BaseBridge {
	protected plugin: Plugin;
	protected seq = 0;
	protected activeProcess: {
		kill: () => void;
		reqId: string;
	} | null = null;
	protected eventQueue = new EventQueue<BridgeStreamEvent>();

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	/**
	 * Get the filesystem path to the bridge script
	 */
	abstract getBridgePath(basePath: string): string;

	/**
	 * Get the provider type identifier (e.g., "claude", "chatgpt", "copilot")
	 */
	abstract getProviderType(): string;

	/**
	 * Get capabilities of this bridge
	 */
	abstract getCapabilities(): BridgeCapabilities;

	/**
	 * Stop the active generation if any.
	 * Returns true if a process was killed, false if no active generation.
	 */
	stop(): boolean {
		if (this.activeProcess) {
			console.log(`[${this.constructor.name}] Stopping request ${this.activeProcess.reqId}`);
			this.activeProcess.kill();
			return true;
		}
		return false;
	}

	/**
	 * Check if there's an active process running
	 */
	isActive(): boolean {
		return this.activeProcess !== null;
	}

	/**
	 * Ping the bridge to verify it's working
	 */
	async ping(env: Record<string, string>, cwd: string): Promise<void> {
		await this.callBridge("ping", { prompt: "", model: "", cwd, env });
	}

	/**
	 * Send a chat request and get the complete result (non-streaming)
	 */
	async chat(params: ChatParams, piAuth?: PiAuth): Promise<ChatResult> {
		let streamedText = "";
		const result = await this.chatStream(params, piAuth, {
			onEvent: (event) => {
				if (event.type === "assistant_delta") {
					streamedText += event.text;
				}
			},
		});

		if (!result.text && streamedText.trim()) {
			return {
				...result,
				text: streamedText.trim(),
			};
		}
		return result;
	}

	/**
	 * Send a chat request with streaming events via callback
	 */
	async chatStream(
		params: ChatParams,
		piAuth?: PiAuth,
		handlers: BridgeStreamHandlers = {}
	): Promise<ChatResult> {
		const result = await this.callBridge("chat", params, piAuth, handlers);

		const text = result?.text;
		if (typeof text !== "string" || !text.trim()) {
			throw new Error(`${this.constructor.name} returned empty response.`);
		}

		return {
			text,
			fileChanged: result?.fileChanged === true,
			editedFilePath: typeof result?.editedFilePath === "string" ? result.editedFilePath : undefined,
			usage: result?.usage as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } | undefined,
			sessionId: typeof result?.sessionId === "string" ? result.sessionId : undefined,
		};
	}

	/**
	 * Stream events as an async generator
	 * This is the preferred interface for UI components
	 */
	async *streamEvents(params: ChatParams, piAuth?: PiAuth): AsyncGenerator<BridgeStreamEvent> {
		// Reset queue for new stream
		this.eventQueue.reset();

		// Start bridge process in background
		const processPromise = this.callBridge("chat", params, piAuth, {
			onEvent: (event) => this.eventQueue.enqueue(event),
		});

		// Yield events from queue
		try {
			yield* this.eventQueue.events();
		} finally {
			// Ensure process is cleaned up
			this.stop();
			// Wait for process to fully complete
			try {
				await processPromise;
			} catch {
				// Errors are already emitted via events
			}
		}
	}

	/**
	 * Build the request payload for the bridge
	 * Subclasses can override to add provider-specific fields
	 */
	protected buildRequest(
		method: "ping" | "chat",
		params: ChatParams,
		piAuth?: PiAuth
	): Record<string, unknown> {
		const reqId = `${this.getProviderType()}-${Date.now()}-${++this.seq}`;
		
		const request: Record<string, unknown> = {
			id: reqId,
			method,
			payload: {
				prompt: params.prompt,
				model: params.model,
				systemPrompt: params.systemPrompt,
				cwd: params.cwd,
				activeFilePath: params.activeFilePath,
				maxTurns: params.maxTurns,
				thinkingLevel: params.thinkingLevel,
				resumeSessionId: params.resumeSessionId,
			},
		};

		if (piAuth) {
			request.piAuth = piAuth;
		}

		return request;
	}

	/**
	 * Internal method to spawn bridge process and handle JSONL protocol
	 */
	protected async callBridge(
		method: "ping" | "chat",
		params: ChatParams,
		piAuth?: PiAuth,
		handlers: BridgeStreamHandlers = {}
	): Promise<Record<string, unknown> | undefined> {
		const adapterWithBasePath = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
		const basePath = adapterWithBasePath.getBasePath?.();
		if (!basePath) {
			throw new Error("Cannot resolve local vault base path for bridge.");
		}

		const bridgePath = this.getBridgePath(basePath);

		// Get child_process via window.require (Obsidian Electron context)
		const win = window as unknown as {
			require?: (name: string) => unknown;
			process?: { env?: Record<string, string | undefined> };
		};

		const childProcessModule = win.require?.("child_process") as
			| {
				execSync?: (command: string, options: { encoding: string; shell?: boolean }) => Buffer | string;
				spawn?: (
					command: string,
					args: string[],
					options: {
						shell: boolean;
						cwd?: string;
						env: Record<string, string>;
						stdio: ["pipe", "pipe", "pipe"];
					}
				) => {
					stdout: { on: (event: "data", cb: (chunk: string) => void) => void };
					stderr: { on: (event: "data", cb: (chunk: string) => void) => void };
					stdin: { write: (data: string) => void; end: () => void };
					on: (event: string, cb: (...args: unknown[]) => void) => void;
					kill: () => void;
				};
			}
		| undefined;

		if (!childProcessModule?.spawn) {
			throw new Error("child_process.spawn is unavailable in this Obsidian runtime.");
		}

		const nodePath = resolveNodePath(childProcessModule);

		const request = this.buildRequest(method, params, piAuth);
		const reqId = request.id as string;

		// Merge environment variables
		const mergedEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(win.process?.env || {})) {
			if (typeof v === "string") {
				mergedEnv[k] = v;
			}
		}
		for (const [k, v] of Object.entries(params.env)) {
			mergedEnv[k] = v;
		}
		mergedEnv["OBSIDIAN_AI_NODE_PATH"] = nodePath;

		const spawned = childProcessModule.spawn(nodePath, [bridgePath], {
			shell: false,
			cwd: params.cwd,
			env: mergedEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Store reference for potential cancellation
		this.activeProcess = {
			kill: () => spawned.kill(),
			reqId,
		};

		return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
			let stdoutBuffer = "";
			let stderr = "";
			let settled = false;
			let finalResult: Record<string, unknown> | undefined;

			const cleanup = () => {
				if (this.activeProcess?.reqId === reqId) {
					this.activeProcess = null;
				}
			};

			const timeout = window.setTimeout(() => {
				if (settled) return;
				settled = true;
				spawned.kill();
				cleanup();
				reject(new Error(`Bridge timeout after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);

			const handleLine = (lineRaw: string) => {
				const line = lineRaw.trim();
				if (!line) return;

				let parsed: { id: string | null; ok: boolean; event?: BridgeStreamEvent; result?: Record<string, unknown>; error?: string };
				try {
					parsed = JSON.parse(line);
				} catch {
					throw new Error(`Bridge invalid JSON output: ${line.slice(0, 200)}`);
				}

				if (!parsed.ok) {
					throw new Error(parsed.error || "Bridge request failed");
				}

				if (parsed.event) {
					handlers.onEvent?.(parsed.event);
				}
				if (parsed.result) {
					finalResult = parsed.result;
				}
			};

			spawned.stdout.on("data", (chunk: string) => {
				stdoutBuffer += String(chunk);
				let idx = stdoutBuffer.indexOf("\n");
				while (idx >= 0) {
					const line = stdoutBuffer.slice(0, idx);
					stdoutBuffer = stdoutBuffer.slice(idx + 1);
					try {
						handleLine(line);
					} catch (error) {
						if (!settled) {
							settled = true;
							window.clearTimeout(timeout);
							spawned.kill();
							cleanup();
							reject(error instanceof Error ? error : new Error(String(error)));
						}
						return;
					}
					idx = stdoutBuffer.indexOf("\n");
				}
			});

			spawned.stderr.on("data", (chunk: string) => {
				stderr += String(chunk);
			});

			spawned.on("error", (err: Error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				cleanup();
				reject(err);
			});

			spawned.on("close", (code: number | null) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				cleanup();

				// Check if process was killed (user cancelled)
				if (code === null || code === 143 || code === 1) {
					reject(new Error("GENERATION_CANCELLED"));
					return;
				}

				if (stdoutBuffer.trim()) {
					try {
						handleLine(stdoutBuffer);
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
						return;
					}
				}

				if (!finalResult) {
					reject(new Error(`Bridge returned no result.${stderr ? ` stderr: ${stderr.trim()}` : ""}`));
					return;
				}

				resolve(finalResult);
			});

			spawned.stdin.write(`${JSON.stringify(request)}\n`);
			spawned.stdin.end();
		});
	}
}
