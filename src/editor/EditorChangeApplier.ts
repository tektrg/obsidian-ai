import { App, MarkdownView } from "obsidian";
import { resolveMarkdownView } from "./MarkdownViewResolver";

export class EditorChangeApplier {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	getActiveMarkdownState(): { hasActiveMarkdown: boolean; filePath?: string; hasSelection: boolean } {
		const view = resolveMarkdownView(this.app);
		if (!view || !view.file) {
			return { hasActiveMarkdown: false, hasSelection: false };
		}
		return {
			hasActiveMarkdown: true,
			filePath: view.file.path,
			hasSelection: view.editor.somethingSelected(),
		};
	}

	private getActiveMarkdownView(): MarkdownView {
		const view = resolveMarkdownView(this.app);
		if (!view || !view.file) {
			throw new Error("No active editable markdown note.");
		}
		return view;
	}
}
