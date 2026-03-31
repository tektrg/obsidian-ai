import { App, MarkdownView, TFile } from "obsidian";

function isUsableMarkdownView(view: MarkdownView | null | undefined): view is MarkdownView {
	if (!view) {
		return false;
	}
	const file = view.file;
	if (!file || !(file instanceof TFile) || file.extension !== "md") {
		return false;
	}
	return true;
}

export function resolveMarkdownView(app: App): MarkdownView | null {
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	if (isUsableMarkdownView(activeView)) {
		return activeView;
	}

	const markdownLeaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of markdownLeaves) {
		const view = leaf.view;
		if (view instanceof MarkdownView && isUsableMarkdownView(view)) {
			return view;
		}
	}

	return null;
}
