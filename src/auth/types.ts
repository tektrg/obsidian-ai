export type AuthMode = "anthropic-api-key" | "claude-max";

export type AuthStatus = "signed-out" | "pending" | "signed-in" | "unsupported";

export interface AuthSession {
	mode: AuthMode;
	status: AuthStatus;
	accountLabel?: string;
	expiresAt?: number;
	scopes?: string[];
}

export interface AuthProvider {
	getSession(): AuthSession;
	startLogin(): Promise<AuthSession>;
	logout(): Promise<AuthSession>;
	getAuthHeaders(): Promise<Record<string, string> | null>;
	getRuntimeEnv(): Promise<Record<string, string> | null>;
}
