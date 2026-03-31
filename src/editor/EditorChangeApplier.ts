import { App, MarkdownView, TFile } from "obsidian";

export interface ApplyResult {
	filePath: string;
	action: "replace-selection" | "append-note" | "replace-note";
}

export class EditorChangeApplier {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	replaceSelection(content: string): ApplyResult {
		const view = this.getActiveMarkdownView();
		const filePath = view.file?.path;
		if (!filePath) {
			throw new Error("Cannot resolve active markdown file path.");
		}
		const editor = view.editor;
		if (!editor.somethingSelected()) {
			throw new Error("No selection found in active note.");
		}

		editor.replaceSelection(content);
		return {
			filePath,
			action: "replace-selection",
		};
	}

	appendToNote(content: string): ApplyResult {
		const view = this.getActiveMarkdownView();
		const filePath = view.file?.path;
		if (!filePath) {
			throw new Error("Cannot resolve active markdown file path.");
		}
		const editor = view.editor;
		const current = editor.getValue();
		const separator = current.trim().length > 0 ? "\n\n" : "";
		editor.setValue(`${current}${separator}${content}`);
		return {
			filePath,
			action: "append-note",
		};
	}

	replaceWholeNote(content: string): ApplyResult {
		const view = this.getActiveMarkdownView();
		const filePath = view.file?.path;
		if (!filePath) {
			throw new Error("Cannot resolve active markdown file path.");
		}
		view.editor.setValue(content);
		return {
			filePath,
			action: "replace-note",
		};
	}

	getActiveMarkdownState(): { hasActiveMarkdown: boolean; filePath?: string; hasSelection: boolean } {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file || !(view.file instanceof TFile) || view.file.extension !== "md") {
			return { hasActiveMarkdown: false, hasSelection: false };
		}
		return {
			hasActiveMarkdown: true,
			filePath: view.file.path,
			hasSelection: view.editor.somethingSelected(),
		};
	}

	private getActiveMarkdownView(): MarkdownView {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file || !(view.file instanceof TFile) || view.file.extension !== "md") {
			throw new Error("No active editable markdown note.");
		}
		return view;
	}
}
