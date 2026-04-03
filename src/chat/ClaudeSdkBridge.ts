import { Plugin } from "obsidian";

interface BridgeRequest {
	id: string;
	method: "ping" | "chat";
	payload?: Record<string, unknown>;
}

interface BridgeResponseLine {
	id: string | null;
	ok: boolean;
	event?: BridgeStreamEvent;
	result?: Record<string, unknown>;
	error?: string;
}

export interface ChatParams {
	prompt: string;
	model: string;
	systemPrompt?: string;
	cwd: string;
	env: Record<string, string>;
	activeFilePath?: string;
}

export interface ChatResult {
	text: string;
	fileChanged?: boolean;
	editedFilePath?: string;
}

export type BridgeStreamEvent =
	| { type: "assistant_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_started"; toolName: string; detail?: string; stepId?: string }
	| { type: "tool_finished"; toolName: string; detail?: string; stepId?: string; ok?: boolean }
	| { type: "status"; text: string };

export interface ChatStreamHandlers {
	onEvent?: (event: BridgeStreamEvent) => void;
}

const REQUEST_TIMEOUT_MS = 120000;

export class ClaudeSdkBridge {
	private plugin: Plugin;
	private seq = 0;
	private activeProcess: {
		kill: () => void;
		reqId: string;
	} | null = null;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	/**
	 * Stop the active generation if any.
	 * Returns true if a process was killed, false if no active generation.
	 */
	stop(): boolean {
		if (this.activeProcess) {
			console.log(`[ClaudeSdkBridge] Stopping request ${this.activeProcess.reqId}`);
			this.activeProcess.kill();
			return true;
		}
		return false;
	}

	async ping(env: Record<string, string>): Promise<void> {
		await this.callBridge("ping", {}, env);
	}

	async chat(params: ChatParams): Promise<ChatResult> {
		let streamedText = "";
		const result = await this.chatStream(params, {
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

	async chatStream(params: ChatParams, handlers: ChatStreamHandlers = {}): Promise<ChatResult> {
		const result = await this.callBridge("chat", {
			prompt: params.prompt,
			model: params.model,
			systemPrompt: params.systemPrompt,
			cwd: params.cwd,
			activeFilePath: params.activeFilePath,
		}, params.env, handlers);

		const text = result?.text;
		if (typeof text !== "string" || !text.trim()) {
			throw new Error("Claude bridge returned empty response.");
		}

		return {
			text,
			fileChanged: result?.fileChanged === true,
			editedFilePath: typeof result?.editedFilePath === "string" ? result.editedFilePath : undefined,
		};
	}

	private async callBridge(
		method: "ping" | "chat",
		payload: Record<string, unknown>,
		envVars: Record<string, string>,
		handlers: ChatStreamHandlers = {}
	): Promise<Record<string, unknown> | undefined> {
		const adapterWithBasePath = this.plugin.app.vault.adapter as unknown as { getBasePath?: () => string };
		const basePath = adapterWithBasePath.getBasePath?.();
		if (!basePath) {
			throw new Error("Cannot resolve local vault base path for Claude bridge.");
		}
		const bridgePath = `${basePath}/.obsidian/plugins/obsidian-ai/scripts/claude-chat-bridge.mjs`;

		const command = `node \"${bridgePath}\"`;
		const reqId = `bridge-${Date.now()}-${++this.seq}`;
		const request: BridgeRequest = { id: reqId, method, payload };

		const win = window as unknown as {
			require?: (name: string) => unknown;
			process?: { env?: Record<string, string | undefined> };
		};
		const childProcessModule = win.require?.("child_process") as
			| {
				spawn?: (
					command: string,
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

		const mergedEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(win.process?.env || {})) {
			if (typeof v === "string") {
				mergedEnv[k] = v;
			}
		}
		for (const [k, v] of Object.entries(envVars)) {
			mergedEnv[k] = v;
		}

		const cwdValue = typeof payload.cwd === "string" ? payload.cwd : undefined;
		const spawned = childProcessModule.spawn(command, {
			shell: true,
			cwd: cwdValue,
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
			let killed = false;
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
				reject(new Error(`Claude bridge timeout after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);

			const handleLine = (lineRaw: string) => {
				const line = lineRaw.trim();
				if (!line) return;

				let parsed: BridgeResponseLine;
				try {
					parsed = JSON.parse(line) as BridgeResponseLine;
				} catch {
					throw new Error(`Claude bridge invalid JSON output: ${line}`);
				}

				if (!parsed.ok) {
					throw new Error(parsed.error || "Claude bridge request failed");
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
					// Code null = killed by signal, 143 = SIGTERM (128 + 15), 1 = general error after kill
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
					reject(new Error(`Claude bridge returned no result.${stderr ? ` stderr: ${stderr.trim()}` : ""}`));
					return;
				}

				resolve(finalResult);
			});

			spawned.stdin.write(`${JSON.stringify(request)}\n`);
			spawned.stdin.end();
		});
	}
}
