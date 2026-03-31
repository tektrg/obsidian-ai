import { App } from "obsidian";
import { resolveMarkdownView } from "./MarkdownViewResolver";

export type ContextScope = "selection" | "note";

export interface ActiveFileContextSnapshot {
	filePath: string;
	fileName: string;
	scopeUsed: ContextScope;
	hasSelection: boolean;
	selectionText: string;
	content: string;
	totalChars: number;
	wasTruncated: boolean;
}

interface GetActiveContextOptions {
	scope: ContextScope;
	maxChars?: number;
}

const DEFAULT_MAX_CHARS = 12000;

export class ActiveFileContextService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	getActiveContext(options: GetActiveContextOptions): ActiveFileContextSnapshot | null {
		const view = resolveMarkdownView(this.app);
		if (!view) {
			return null;
		}

		const file = view.file;
		if (!file) {
			return null;
		}

		const editor = view.editor;
		const selectionText = editor.getSelection();
		const hasSelection = selectionText.trim().length > 0;
		const fullContent = editor.getValue();
		const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

		const preferredContent = options.scope === "selection" && hasSelection
			? selectionText
			: fullContent;
		const scopeUsed: ContextScope = options.scope === "selection" && hasSelection
			? "selection"
			: "note";

		const { text, wasTruncated } = truncateText(preferredContent, maxChars);

		return {
			filePath: file.path,
			fileName: file.basename,
			scopeUsed,
			hasSelection,
			selectionText,
			content: text,
			totalChars: preferredContent.length,
			wasTruncated,
		};
	}
}

export function formatPromptWithActiveContext(
	userPrompt: string,
	context: ActiveFileContextSnapshot
): string {
	const truncationNote = context.wasTruncated
		? `Yes (original chars: ${context.totalChars}, sent chars: ${context.content.length})`
		: "No";

	return [
		"You are helping with an Obsidian note.",
		"",
		"ACTIVE_FILE_CONTEXT_START",
		`File path: ${context.filePath}`,
		`File name: ${context.fileName}`,
		`Context scope used: ${context.scopeUsed}`,
		`Has selection: ${context.hasSelection ? "yes" : "no"}`,
		`Content truncated: ${truncationNote}`,
		"",
		"Context content:",
		context.content,
		"ACTIVE_FILE_CONTEXT_END",
		"",
		"USER_REQUEST:",
		userPrompt,
	].join("\n");
}

function truncateText(text: string, maxChars: number): { text: string; wasTruncated: boolean } {
	if (text.length <= maxChars) {
		return { text, wasTruncated: false };
	}
	return {
		text: text.slice(0, maxChars),
		wasTruncated: true,
	};
}
