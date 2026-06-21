export const CLAUDE_OAUTH_CONFIG = {
	clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
	authUrl: "https://platform.claude.com/oauth/authorize",
	tokenUrl: "https://platform.claude.com/v1/oauth/token",
	redirectUri: "https://platform.claude.com/oauth/code/callback",
	scopes: "org:create_api_key user:profile user:inference"
} as const;
