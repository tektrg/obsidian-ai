import { Plugin } from "obsidian";

interface BridgeRequest {
	id: string;
	method: "ping" | "chat";
	payload?: Record<string, unknown>;
}

interface BridgeResponse {
	id: string | null;
	ok: boolean;
	result?: Record<string, unknown>;
	error?: string;
}

interface ChatParams {
	prompt: string;
	model: string;
	systemPrompt?: string;
	cwd: string;
	env: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 45000;

export class ClaudeSdkBridge {
	private plugin: Plugin;
	private seq = 0;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async ping(env: Record<string, string>): Promise<void> {
		await this.callBridge("ping", {}, env);
	}

	async chat(params: ChatParams): Promise<string> {
		const result = await this.callBridge("chat", {
			prompt: params.prompt,
			model: params.model,
			systemPrompt: params.systemPrompt,
			cwd: params.cwd,
		}, params.env);

		const text = result?.text;
		if (typeof text !== "string" || !text.trim()) {
			throw new Error("Claude bridge returned empty response.");
		}
		return text;
	}

	private async callBridge(
		method: "ping" | "chat",
		payload: Record<string, unknown>,
		envVars: Record<string, string>
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

		return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;

			const timeout = window.setTimeout(() => {
				if (settled) return;
				settled = true;
				spawned.kill();
				reject(new Error(`Claude bridge timeout after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);

			spawned.stdout.on("data", (chunk: string) => {
				stdout += String(chunk);
			});

			spawned.stderr.on("data", (chunk: string) => {
				stderr += String(chunk);
			});

			spawned.on("error", (err: Error) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				reject(err);
			});

			spawned.on("close", () => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
				const finalLine = lines[lines.length - 1];
				if (!finalLine) {
					reject(new Error(`Claude bridge returned no output.${stderr ? ` stderr: ${stderr.trim()}` : ""}`));
					return;
				}

				let parsed: BridgeResponse;
				try {
					parsed = JSON.parse(finalLine) as BridgeResponse;
				} catch {
					reject(new Error(`Claude bridge invalid JSON output: ${finalLine}`));
					return;
				}

				if (!parsed.ok) {
					reject(new Error(parsed.error || "Claude bridge request failed"));
					return;
				}
				resolve(parsed.result);
			});

			spawned.stdin.write(`${JSON.stringify(request)}\n`);
			spawned.stdin.end();
		});
	}
}
