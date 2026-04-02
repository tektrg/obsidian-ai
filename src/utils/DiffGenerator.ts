/**
 * Diff generator using Google's diff-match-patch library
 * Produces optimal minimal diffs using Myer's diff algorithm
 */

import DiffMatchPatch from "diff-match-patch";

export type DiffLineType = 'unchanged' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNum: number;
}

/**
 * Generate an inline diff between original and modified content
 * Uses Google's diff-match-patch library for optimal results
 */
export function generateInlineDiff(original: string, modified: string): DiffLine[] {
  const dmp = new DiffMatchPatch();

  // Handle empty cases
  if (original === "" && modified === "") {
    return [];
  }

  if (original === "") {
    const lines = modified.split("\n");
    return lines.map((line, idx) => ({
      type: "added" as DiffLineType,
      content: line,
      lineNum: idx + 1,
    }));
  }

  if (modified === "") {
    const lines = original.split("\n");
    return lines.map((line, idx) => ({
      type: "removed" as DiffLineType,
      content: line,
      lineNum: idx + 1,
    }));
  }

  // Split into lines, preserving empty lines
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  // Create unique line hashes to handle duplicate lines correctly
  // Use a sentinel that is unlikely to appear in real content
  const lineMap = new Map<string, number>();
  const originalHashes: number[] = [];
  const modifiedHashes: number[] = [];
  let nextHash = 1;

  for (const line of originalLines) {
    if (!lineMap.has(line)) {
      lineMap.set(line, nextHash++);
    }
    originalHashes.push(lineMap.get(line)!);
  }

  for (const line of modifiedLines) {
    if (!lineMap.has(line)) {
      lineMap.set(line, nextHash++);
    }
    modifiedHashes.push(lineMap.get(line)!);
  }

  // Convert hashes to characters for diff-match-patch
  // Use high Unicode private use area characters to avoid conflicts
  const charBase = 0xE000;
  const originalChars = originalHashes.map(h => String.fromCharCode(charBase + h)).join("");
  const modifiedChars = modifiedHashes.map(h => String.fromCharCode(charBase + h)).join("");

  // Run the diff algorithm
  const diffs = dmp.diff_main(originalChars, modifiedChars);
  dmp.diff_cleanupSemantic(diffs);

  // Convert back to line-based diff
  const result: DiffLine[] = [];
  let originalIndex = 0;
  let modifiedIndex = 0;

  for (const [op, text] of diffs) {
    const lineCount = text.length;

    if (op === DiffMatchPatch.DIFF_EQUAL) {
      // Unchanged lines
      for (let i = 0; i < lineCount; i++) {
        const lineContent = originalLines[originalIndex + i];
        if (lineContent !== undefined) {
          result.push({
            type: "unchanged",
            content: lineContent,
            lineNum: originalIndex + i + 1,
          });
        }
      }
      originalIndex += lineCount;
      modifiedIndex += lineCount;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      // Removed lines
      for (let i = 0; i < lineCount; i++) {
        const lineContent = originalLines[originalIndex + i];
        if (lineContent !== undefined) {
          result.push({
            type: "removed",
            content: lineContent,
            lineNum: originalIndex + i + 1,
          });
        }
      }
      originalIndex += lineCount;
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      // Added lines
      for (let i = 0; i < lineCount; i++) {
        const lineContent = modifiedLines[modifiedIndex + i];
        if (lineContent !== undefined) {
          result.push({
            type: "added",
            content: lineContent,
            lineNum: modifiedIndex + i + 1,
          });
        }
      }
      modifiedIndex += lineCount;
    }
  }

  return result;
}

/**
 * Generate diff statistics
 */
export function getDiffStats(diff: DiffLine[]): { added: number; removed: number; unchanged: number } {
  return {
    added: diff.filter(l => l.type === "added").length,
    removed: diff.filter(l => l.type === "removed").length,
    unchanged: diff.filter(l => l.type === "unchanged").length,
  };
}
