#!/usr/bin/env node
/**
 * Pi Agent Bridge
 * 
 * Subprocess bridge for the Pi SDK (@mariozechner/pi-coding-agent).
 * Communicates with the main Obsidian plugin via JSONL over stdin/stdout.
 *
 * Supported providers via piAuth:
 * - openai-codex: ChatGPT Plus (Codex) via OAuth
 * - copilot: GitHub Copilot via OAuth
 * 
 * Usage:
 *   node pi-agent-bridge.mjs
 * 
 * Protocol:
 *   Input (stdin):  { id, method: "chat", payload: {...}, piAuth: {...} }
 *   Output (stdout): { id, ok: true, event: {...} }  (streaming)
 *                    { id, ok: true, result: {...} } (final)
 *                    { id, ok: false, error: "..." } (error)
 */

import process from "node:process";

// Try to import Pi SDK - gracefully handle if not installed
let PiSdk = null;
try {
	const { createAgentSession, AuthStorage } = await import("@mariozechner/pi-coding-agent");
	const { getModel } = await import("@mariozechner/pi-ai");
	PiSdk = { createAgentSession, AuthStorage, getModel };
} catch (err) {
	console.error("[Pi Bridge] Pi SDK not installed. Run: npm install @mariozechner/pi-coding-agent @mariozechner/pi-agent-core");
}

const REQUEST_TIMEOUT_MS = 300000; // 5 minutes

function respond(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitEvent(id, event) {
	respond({ id, ok: true, event });
}

/**
 * Run a chat session with the Pi SDK
 */
async function runChat(id, payload, piAuth) {
	if (!PiSdk) {
		throw new Error("Pi SDK not available. Please install the required dependencies.");
	}

	const { createAgentSession, AuthStorage, getModel } = PiSdk;

	const prompt = String(payload?.prompt ?? "").trim();
	if (!prompt) {
		throw new Error("Missing prompt");
	}

	const modelId = String(payload?.model ?? "auto").trim();
	const systemPrompt = typeof payload?.systemPrompt === "string" ? payload.systemPrompt : "";
	const cwd = typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
	const thinkingLevel = payload?.thinkingLevel || "medium";

	// Set up auth storage with credentials from main process
	const authStorage = AuthStorage.inMemory();
	if (piAuth?.provider && piAuth?.credential) {
		authStorage.set(piAuth.provider, piAuth.credential);
	}

	// Create agent session
	const model = resolveModel(modelId, getModel);
	const { session } = await createAgentSession({
		model,
		cwd,
		authStorage,
		thinkingLevel,
	});

	// Track state during streaming
	const state = {
		toolById: new Map(),
		finalText: "",
		usage: null,
		hasStarted: false,
	};

	emitEvent(id, { type: "status", text: "Starting..." });

	// Run the session
	const unsubscribe = session.subscribe((event) => {
		mapSessionEvent(id, event, state);
	});
	try {
		await session.prompt(formatPrompt(prompt, systemPrompt));
	} catch (error) {
		// Check for auth errors
		const errorMsg = error instanceof Error ? error.message : String(error);
		if (errorMsg.includes("401") || errorMsg.includes("unauthorized") || errorMsg.includes("token")) {
			emitEvent(id, {
				type: "typed_error",
				error: {
					code: "auth_error",
					message: "Authentication failed. Please sign in again.",
					retryable: true,
				},
			});
		}
		throw error;
	} finally {
		unsubscribe();
		session.dispose();
	}

	return {
		text: state.finalText,
		usage: state.usage ? {
			inputTokens: state.usage.input,
			outputTokens: state.usage.output,
			cacheReadTokens: state.usage.cacheRead || 0,
			cacheCreationTokens: state.usage.cacheWrite || 0,
		} : undefined,
	};
}

function resolveModel(modelId, getModel) {
	if (!modelId || modelId === "auto") {
		return getModel("openai-codex", "gpt-5.5");
	}

	const slashIndex = modelId.indexOf("/");
	if (slashIndex > 0) {
		const provider = modelId.slice(0, slashIndex);
		const providerModelId = modelId.slice(slashIndex + 1);
		return getModel(provider, providerModelId);
	}

	return getModel("openai-codex", modelId);
}

function formatPrompt(prompt, systemPrompt) {
	if (!systemPrompt.trim()) {
		return prompt;
	}
	return `${systemPrompt.trim()}\n\n${prompt}`;
}

function mapSessionEvent(id, event, state) {
	switch (event.type) {
		case "agent_start":
			state.hasStarted = true;
			emitEvent(id, { type: "status", text: "Thinking..." });
			break;

		case "message_update": {
			const ame = event.assistantMessageEvent;
			if (ame?.type === "text_delta" && ame.delta) {
				state.finalText += ame.delta;
				emitEvent(id, { type: "assistant_delta", text: ame.delta });
			}
			if (ame?.type === "thinking_delta" && ame.delta) {
				emitEvent(id, { type: "thinking_delta", text: ame.delta });
			}
			break;
		}

		case "tool_execution_start": {
			const stepId = event.toolCallId || `tool-${Date.now()}`;
			state.toolById.set(stepId, {
				name: event.toolName,
				input: event.args,
			});
			emitEvent(id, {
				type: "tool_started",
				toolName: event.toolName,
				stepId,
				detail: JSON.stringify(event.args).slice(0, 200),
			});
			break;
		}

		case "tool_execution_update": {
			const text = extractTextContent(event.partialResult?.content);
			if (text) {
				emitEvent(id, {
					type: "tool_started",
					toolName: state.toolById.get(event.toolCallId)?.name || event.toolName || "Tool",
					stepId: event.toolCallId,
					detail: text.slice(0, 200),
				});
			}
			break;
		}

		case "tool_execution_end": {
			const toolInfo = state.toolById.get(event.toolCallId);
			emitEvent(id, {
				type: "tool_finished",
				toolName: toolInfo?.name || event.toolName,
				stepId: event.toolCallId,
				ok: !event.isError,
			});
			state.toolById.delete(event.toolCallId);
			break;
		}

		case "message_end": {
			if (event.message?.usage) {
				state.usage = event.message.usage;
				emitEvent(id, {
					type: "usage_update",
					inputTokens: event.message.usage.input,
					outputTokens: event.message.usage.output,
					cacheReadTokens: event.message.usage.cacheRead || 0,
					cacheCreationTokens: event.message.usage.cacheWrite || 0,
				});
			}
			break;
		}

		case "compaction_start":
			emitEvent(id, { type: "status", text: "Compacting context..." });
			break;

		case "compaction_end":
			if (event.result && !event.aborted) {
				emitEvent(id, { type: "status", text: "Compacted context to fit within limits" });
			}
			break;

		case "auto_retry_start":
			emitEvent(id, {
				type: "status",
				text: `Retrying (attempt ${event.attempt}/${event.maxAttempts})...`,
			});
			break;

		case "agent_end":
		case "turn_start":
		case "turn_end":
		case "message_start":
			break;

		default:
			if (process.env.CRAFT_DEBUG) {
				console.error(`[Pi Bridge] Unknown event type: ${event.type}`);
			}
			break;
	}
}

function extractTextContent(content) {
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}

/**
 * Handle a single JSONL request
 */
async function handleLine(rawLine) {
	const line = rawLine.trim();
	if (!line) return;

	let req;
	try {
		req = JSON.parse(line);
	} catch {
		respond({ id: null, ok: false, error: "Invalid JSON input" });
		return;
	}

	const id = req?.id ?? null;
	const method = req?.method;

	try {
		if (method === "ping") {
			respond({ id, ok: true, result: { 
				pong: true, 
				piSdkAvailable: !!PiSdk,
				version: "1.0.0" 
			} });
			return;
		}

		if (method === "chat") {
			const result = await runChat(id, req.payload ?? {}, req.piAuth);
			respond({ id, ok: true, result });
			return;
		}

		respond({ id, ok: false, error: `Unknown method: ${String(method)}` });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		respond({ id, ok: false, error: message });
	}
}

// ============================================================================
// Main Loop
// ============================================================================

let buffer = "";
let stdinEnded = false;
const inFlight = new Set();

function maybeExit() {
	if (stdinEnded && inFlight.size === 0) {
		process.exit(0);
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let idx = buffer.indexOf("\n");
	while (idx >= 0) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		const task = handleLine(line)
			.catch((error) => {
				respond({ id: null, ok: false, error: error instanceof Error ? error.message : String(error) });
			})
			.finally(() => {
				inFlight.delete(task);
				maybeExit();
			});
		inFlight.add(task);
		idx = buffer.indexOf("\n");
	}
});

process.stdin.on("end", () => {
	stdinEnded = true;
	maybeExit();
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
	console.error("[Pi Bridge] Uncaught exception:", err);
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	console.error("[Pi Bridge] Unhandled rejection:", reason);
});
