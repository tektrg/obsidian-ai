import claudeBridgeSource from "virtual:claude-chat-bridge-source";
import piBridgeSource from "virtual:pi-agent-bridge-source";

export function getClaudeBridgeSource(): string {
	return claudeBridgeSource;
}

export function getPiBridgeSource(): string {
	return piBridgeSource;
}
