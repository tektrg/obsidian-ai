#!/usr/bin/env node
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEBUG_LOG_ENABLED = process.env.OBSIDIAN_AI_DEBUG_BRIDGE === "1";
const CLAUDE_CODE_EXECUTABLE = process.env.OBSIDIAN_AI_CLAUDE_CODE_PATH || "claude";
function debugLog(...parts) {
	if (!DEBUG_LOG_ENABLED) return;
	const stamp = new Date().toISOString();
	process.stderr.write(`${stamp} ${parts.join(" ")}\n`);
}

function respond(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitEvent(id, event) {
	respond({ id, ok: true, event });
}

function extractTextFromSdkMessages(sdkMessages) {
	for (let i = sdkMessages.length - 1; i >= 0; i -= 1) {
		const message = sdkMessages[i];
		if (!message || typeof message !== "object") continue;
		if (message.type === "result" && typeof message.result === "string" && message.result.trim()) {
			return message.result.trim();
		}
	}

	for (let i = sdkMessages.length - 1; i >= 0; i -= 1) {
		const message = sdkMessages[i];
		if (!message || typeof message !== "object") continue;
		if (message.type !== "assistant") continue;
		const content = Array.isArray(message.message?.content) ? message.message.content : [];
		const parts = content
			.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.filter(Boolean);
		if (parts.length) {
			return parts.join("\n\n").trim();
		}
	}

	return "";
}

function extractActiveFilePath(prompt) {
	if (!prompt) return "";
	const markerStart = "ACTIVE_FILE_CONTEXT_START";
	const markerEnd = "ACTIVE_FILE_CONTEXT_END";
	const start = prompt.indexOf(markerStart);
	const end = prompt.indexOf(markerEnd);
	const scope = start >= 0 && end > start ? prompt.slice(start, end) : prompt;
	const match = scope.match(/File path:\s*(.+)/i);
	if (!match?.[1]) return "";
	return String(match[1]).trim();
}

function resolveTargetFile(payload, prompt, cwd) {
	const fromPayload = typeof payload?.activeFilePath === "string" ? payload.activeFilePath.trim() : "";
	const fromPrompt = extractActiveFilePath(prompt);
	const relativePath = fromPayload || fromPrompt;
	if (!relativePath) return { relativePath: "", absolutePath: "" };
	return {
		relativePath,
		absolutePath: path.resolve(cwd, relativePath),
	};
}

function readFileSafe(filePath) {
	if (!filePath) return null;
	try {
		if (!fs.existsSync(filePath)) return null;
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function isEditIntent(text) {
	if (!text) return false;
	return /(update|edit|rewrite|modify|change|fix|patch|mark\s+.*todo|apply\s+changes)/i.test(text);
}

function buildSystemPrompt(systemPrompt, prompt, targetFile) {
	const segments = [];
	if (systemPrompt?.trim()) {
		segments.push(systemPrompt.trim());
	}

	const shouldForceEditTool = isEditIntent(prompt);
	if (shouldForceEditTool && targetFile?.relativePath) {
		segments.push([
			"When the user asks to update/edit/modify the page, you must perform an actual file edit using Claude Code tools (Edit/Write).",
			"Do not return only a summary when an update was requested.",
			`Target note path: ${targetFile.relativePath}`,
			"Apply changes directly to that file unless user explicitly asks for a preview only.",
			"After editing, give a concise confirmation of what was changed.",
		].join("\n"));
	}

	return segments.join("\n\n").trim() || undefined;
}

function summarizeToolInput(input) {
	if (input == null) return "";
	if (typeof input === "string") return input.slice(0, 220);
	try {
		return JSON.stringify(input).slice(0, 220);
	} catch {
		return "";
	}
}

function parseStreamEvent(id, event, state) {
	if (!event || typeof event !== "object") return;

	if (event.type === "content_block_start") {
		const block = event.content_block;
		if (!block || typeof block !== "object") return;

		if (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") {
			const stepId = typeof block.id === "string" ? block.id : `tool-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
			const toolName = typeof block.name === "string" ? block.name : "Tool";
			state.toolByIndex.set(event.index, { stepId, toolName });
			emitEvent(id, {
				type: "tool_started",
				toolName,
				stepId,
				detail: summarizeToolInput(block.input),
			});
		}
		return;
	}

	if (event.type === "content_block_delta") {
		const delta = event.delta;
		if (!delta || typeof delta !== "object") return;

		if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
			state.seenAssistantDelta = true;
			emitEvent(id, { type: "assistant_delta", text: delta.text });
			return;
		}

		if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
			emitEvent(id, { type: "thinking_delta", text: delta.thinking });
			return;
		}

		if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
			const info = state.toolByIndex.get(event.index);
			if (info) {
				emitEvent(id, {
					type: "tool_started",
					toolName: info.toolName,
					stepId: info.stepId,
					detail: `input: ${delta.partial_json.slice(0, 180)}`,
				});
			}
		}
		return;
	}

	if (event.type === "content_block_stop") {
		const info = state.toolByIndex.get(event.index);
		if (info) {
			emitEvent(id, {
				type: "tool_finished",
				toolName: info.toolName,
				stepId: info.stepId,
				ok: true,
			});
			state.toolByIndex.delete(event.index);
		}
	}
}

function emitMessageEvents(id, message, state) {
	if (!message || typeof message !== "object") return;

	if (message.type === "stream_event") {
		parseStreamEvent(id, message.event, state);
		return;
	}

	if (message.type === "tool_progress") {
		emitEvent(id, {
			type: "tool_started",
			toolName: typeof message.tool_name === "string" ? message.tool_name : "Tool",
			stepId: typeof message.tool_use_id === "string" ? message.tool_use_id : undefined,
			detail: typeof message.elapsed_time_seconds === "number"
				? `running ${message.elapsed_time_seconds.toFixed(1)}s`
				: "running",
		});
		return;
	}

	if (message.type === "tool_use_summary" && typeof message.summary === "string" && message.summary.trim()) {
		emitEvent(id, { type: "status", text: message.summary.trim() });
		return;
	}

	if (message.type === "assistant") {
		if (state.seenAssistantDelta) {
			return;
		}
		const content = Array.isArray(message.message?.content) ? message.message.content : [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if (part.type === "text" && typeof part.text === "string" && part.text) {
				emitEvent(id, { type: "assistant_delta", text: part.text });
			}
			if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
				emitEvent(id, { type: "thinking_delta", text: part.thinking });
			}
		}
		return;
	}

	if (message.type === "system" && message.subtype === "status" && message.status) {
		emitEvent(id, { type: "status", text: String(message.status) });
	}
}

async function runChat(id, payload) {
	const prompt = String(payload?.prompt ?? "").trim();
	if (!prompt) {
		throw new Error("Missing prompt");
	}

	const model = String(payload?.model ?? "claude-sonnet-4-5").trim();
	const systemPrompt = typeof payload?.systemPrompt === "string" ? payload.systemPrompt : "";
	const cwd = typeof payload?.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
	const resumeSessionId = typeof payload?.resumeSessionId === "string" && payload.resumeSessionId.trim()
		? payload.resumeSessionId.trim()
		: undefined;
	const targetFile = resolveTargetFile(payload, prompt, cwd);
	const before = readFileSafe(targetFile.absolutePath);

	debugLog("runChat:start", `id=${id}`, `cwd=${cwd}`, `resumeSessionId=${resumeSessionId ?? "(none)"}`, `payloadHasResume=${typeof payload?.resumeSessionId}`, `promptLength=${prompt.length}`);

	const sdkMessages = [];
	const state = {
		toolByIndex: new Map(),
		seenAssistantDelta: false,
	};
	let sessionId = resumeSessionId;

	const buildQueryOptions = (sessionToResume) => {
		const options = {
				model,
				cwd,
				executable: process.env.OBSIDIAN_AI_NODE_PATH || "node",
				pathToClaudeCodeExecutable: CLAUDE_CODE_EXECUTABLE,
				maxTurns: 8,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			includePartialMessages: true,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: buildSystemPrompt(systemPrompt, prompt, targetFile),
			},
		};
		if (sessionToResume) {
			options.resume = sessionToResume;
		}
		return options;
	};

	const consumeQuery = async (sessionToResume) => {
		for await (const msg of query({ prompt, options: buildQueryOptions(sessionToResume) })) {
			sdkMessages.push(msg);
			if (msg && typeof msg === "object" && typeof msg.session_id === "string" && msg.session_id) {
				sessionId = msg.session_id;
			}
			emitMessageEvents(id, msg, state);
		}
	};

	try {
		debugLog("runChat:query", `id=${id}`, resumeSessionId ? `RESUMING ${resumeSessionId}` : "FRESH (no resume)");
		await consumeQuery(resumeSessionId);
		debugLog("runChat:done", `id=${id}`, `finalSessionId=${sessionId ?? "(none)"}`);
	} catch (error) {
		// A stale/invalid resume id (e.g. transcript pruned or moved machines) must not
		// break chat. As long as no user-visible output has streamed yet, discard the
		// failed attempt and retry with a fresh session. We gate on seenAssistantDelta
		// (not message count) because the SDK may emit an init/system message — which
		// carries a session_id — before rejecting an invalid resume id.
		if (resumeSessionId && !state.seenAssistantDelta) {
			// Make the context loss visible instead of silently dropping it.
			const reason = error instanceof Error ? error.message : String(error);
			debugLog("runChat:resumeFAILED", `id=${id}`, `resumeSessionId=${resumeSessionId}`, `reason=${reason}`);
			emitEvent(id, { type: "status", text: "Previous conversation could not be resumed — starting a fresh session." });
			process.stderr.write(`[claude-chat-bridge] resume ${resumeSessionId} failed, starting fresh: ${reason}\n`);
			sdkMessages.length = 0;
			state.toolByIndex.clear();
			sessionId = undefined;
			await consumeQuery(undefined);
		} else {
			throw error;
		}
	}

	const text = extractTextFromSdkMessages(sdkMessages);
	if (!text) {
		const seenTypes = sdkMessages
			.map((message) => (message && typeof message === "object" ? String(message.type ?? "unknown") : "non-object"))
			.join(", ");
		throw new Error(`Claude SDK returned no text output (seen message types: ${seenTypes || "none"})`);
	}

	const after = readFileSafe(targetFile.absolutePath);
	const fileChanged = before !== null && after !== null && before !== after;

	return {
		text,
		fileChanged,
		editedFilePath: fileChanged ? targetFile.relativePath : undefined,
		sessionId,
	};
}

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
			respond({ id, ok: true, result: { pong: true } });
			return;
		}

		if (method === "chat") {
			const result = await runChat(id, req.payload ?? {});
			respond({ id, ok: true, result });
			return;
		}

		respond({ id, ok: false, error: `Unknown method: ${String(method)}` });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		respond({ id, ok: false, error: message });
	}
}

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
