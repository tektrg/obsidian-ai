/**
 * Unified types for chat streaming across all providers
 * 
 * These types work with both Claude SDK and Pi SDK backends,
 * providing a consistent interface for the UI layer.
 */

// ============================================================================
// Stream Events
// ============================================================================

export type BridgeStreamEvent =
	| { type: "assistant_delta"; text: string }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_started"; toolName: string; detail?: string; stepId?: string; intent?: string; displayName?: string }
	| { type: "tool_finished"; toolName: string; detail?: string; stepId?: string; ok?: boolean }
	| { type: "status"; text: string }
	| { type: "usage_update"; inputTokens: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }
	| { type: "complete"; usage?: TokenUsage }
	| { type: "error"; message: string; code?: string }
	| { type: "typed_error"; error: { code: string; message: string; retryable?: boolean } };

// ============================================================================
// Token Usage
// ============================================================================

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	costUsd?: number;
	contextWindow?: number;
}

// ============================================================================
// Chat Parameters
// ============================================================================

export interface ChatParams {
	prompt: string;
	model: string;
	systemPrompt?: string;
	cwd: string;
	env: Record<string, string>;
	activeFilePath?: string;
	maxTurns?: number;
	thinkingLevel?: "none" | "low" | "medium" | "high";
	/** SDK session id to resume so the model retains prior conversation context. */
	resumeSessionId?: string;
}

// ============================================================================
// Chat Result
// ============================================================================

export interface ChatResult {
	text: string;
	fileChanged?: boolean;
	editedFilePath?: string;
	usage?: TokenUsage;
	/** SDK session id for this turn; persist it to resume the conversation later. */
	sessionId?: string;
}

// ============================================================================
// Bridge Capabilities
// ============================================================================

export interface BridgeCapabilities {
	supportsStreaming: boolean;
	supportsToolExecution: boolean;
	supportsThinkingLevels: boolean;
	authType: "api-key" | "oauth" | "iam";
	availableModels: string[];
}

export interface ChatModelOption {
	id: string;
	label: string;
	description?: string;
}

// ============================================================================
// Pi Auth (for Pi SDK backends)
// ============================================================================

export interface PiAuth {
	provider: string;
	credential: 
		| { type: "api_key"; key: string }
		| { type: "oauth"; access: string; refresh: string; expires: number }
		| { type: "iam"; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };
}

// ============================================================================
// Stream Handlers
// ============================================================================

export interface BridgeStreamHandlers {
	onEvent?: (event: BridgeStreamEvent) => void;
}

// ============================================================================
// Bridge Request/Response (JSONL Protocol)
// ============================================================================

export interface BridgeRequest {
	id: string;
	method: "ping" | "chat";
	payload?: Record<string, unknown>;
	piAuth?: PiAuth;
}

export interface BridgeResponseLine {
	id: string | null;
	ok: boolean;
	event?: BridgeStreamEvent;
	result?: Record<string, unknown>;
	error?: string;
}
