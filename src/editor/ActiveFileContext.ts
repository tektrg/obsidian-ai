import { App } from "obsidian";
import { resolveMarkdownView } from "./MarkdownViewResolver";

export interface ActiveFileContextSnapshot {
	filePath: string;
	fileName: string;
	hasSelection: boolean;
	fullContent: string;
	selectionContent: string;
	fullContentTruncated: boolean;
	selectionContentTruncated: boolean;
}

interface GetActiveContextOptions {
	maxFullContentChars?: number;
	maxSelectionChars?: number;
}

const DEFAULT_MAX_FULL_CHARS = 12000;
const DEFAULT_MAX_SELECTION_CHARS = 4000;

export class ActiveFileContextService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	getActiveContext(options: GetActiveContextOptions = {}): ActiveFileContextSnapshot | null {
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

		const maxFullChars = options.maxFullContentChars ?? DEFAULT_MAX_FULL_CHARS;
		const maxSelectionChars = options.maxSelectionChars ?? DEFAULT_MAX_SELECTION_CHARS;

		const fullTruncated = truncateText(fullContent, maxFullChars);
		const selectionTruncated = hasSelection
			? truncateText(selectionText, maxSelectionChars)
			: { text: "", wasTruncated: false };

		return {
			filePath: file.path,
			fileName: file.basename,
			hasSelection,
			fullContent: fullTruncated.text,
			selectionContent: selectionTruncated.text,
			fullContentTruncated: fullTruncated.wasTruncated,
			selectionContentTruncated: selectionTruncated.wasTruncated,
		};
	}
}

export function formatPromptWithActiveContext(
	userPrompt: string,
	context: ActiveFileContextSnapshot
): string {
	const fullTruncationNote = context.fullContentTruncated
		? ` (truncated from original length)`
		: "";
	const selectionTruncationNote = context.selectionContentTruncated
		? ` (truncated from original length)`
		: "";

	const lines: string[] = [
		"You are helping with an Obsidian note.",
		"",
		"ACTIVE_FILE_CONTEXT_START",
		`File path: ${context.filePath}`,
		`File name: ${context.fileName}`,
		`Has selection: ${context.hasSelection ? "yes" : "no"}`,
		"",
		"Full file content:",
		context.fullContent + fullTruncationNote,
	];

	if (context.hasSelection) {
		lines.push(
			"",
			"Selected text:",
			context.selectionContent + selectionTruncationNote
		);
	}

	lines.push(
		"ACTIVE_FILE_CONTEXT_END",
		"",
		"USER_REQUEST:",
		userPrompt
	);

	return lines.join("\n");
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
