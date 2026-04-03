import { App, TFile } from "obsidian";
import { resolveMarkdownView, resolveMarkdownViewForFile } from "./MarkdownViewResolver";

export interface ContextFileSnapshot {
	filePath: string;
	fileName: string;
	source: "editor" | "vault";
	hasSelection: boolean;
	fullContent: string;
	selectionContent: string;
}

export interface PromptContextSnapshot {
	files: ContextFileSnapshot[];
	primaryFilePath?: string;
}

export class ActiveFileContextService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async getCurrentFileContent(filePath: string): Promise<ContextFileSnapshot | null> {
		const editorView = resolveMarkdownViewForFile(this.app, filePath);
		if (editorView?.file) {
			const selectionText = editorView.editor.getSelection();
			const hasSelection = selectionText.trim().length > 0;
			return {
				filePath: editorView.file.path,
				fileName: editorView.file.basename,
				source: "editor",
				hasSelection,
				fullContent: editorView.editor.getValue(),
				selectionContent: hasSelection ? selectionText : "",
			};
		}

		const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
		if (!(abstractFile instanceof TFile)) {
			return null;
		}

		const fileContent = await this.app.vault.cachedRead(abstractFile);
		return {
			filePath: abstractFile.path,
			fileName: abstractFile.basename,
			source: "vault",
			hasSelection: false,
			fullContent: fileContent,
			selectionContent: "",
		};
	}

	captureContextSnapshot(): PromptContextSnapshot | null {
		const view = resolveMarkdownView(this.app);
		if (!view || !view.file) {
			return null;
		}

		const editor = view.editor;
		const selectionText = editor.getSelection();
		const hasSelection = selectionText.trim().length > 0;
		const fullContent = editor.getValue();

		const fileSnapshot: ContextFileSnapshot = {
			filePath: view.file.path,
			fileName: view.file.basename,
			source: "editor",
			hasSelection,
			fullContent,
			selectionContent: hasSelection ? selectionText : "",
		};

		return {
			files: [fileSnapshot],
			primaryFilePath: fileSnapshot.filePath,
		};
	}
}

export function formatPromptWithContext(
	userPrompt: string,
	context: PromptContextSnapshot
): string {
	const primary = context.primaryFilePath
		? context.files.find((f) => f.filePath === context.primaryFilePath) ?? context.files[0]
		: context.files[0];

	if (!primary) {
		return userPrompt;
	}

	const lines: string[] = [
		"You are helping with an Obsidian note.",
		"",
		"ACTIVE_FILE_CONTEXT_START",
		`File path: ${primary.filePath}`,
		`File name: ${primary.fileName}`,
		`Has selection: ${primary.hasSelection ? "yes" : "no"}`,
		"",
		"Full file content:",
		primary.fullContent,
	];

	if (primary.hasSelection) {
		lines.push(
			"",
			"Selected text:",
			primary.selectionContent
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
