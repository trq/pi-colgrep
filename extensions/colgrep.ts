import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdtempSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const REINDEX_DEBOUNCE_MS = 4000;
const STATUS_KEY = "colgrep";
const WATCH_IGNORE = [".git", "node_modules", ".pi", ".idea", ".vscode", "dist", "build"];

const colgrepSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Semantic search query (natural language intent)" })),
	regex: Type.Optional(Type.String({ description: "Optional regex pre-filter applied before semantic ranking" })),
	pattern: Type.Optional(Type.String({ description: "Legacy alias for grep-style calls; maps to query or regex automatically" })),
	path: Type.Optional(Type.String({ description: "Directory or file to search" })),
	glob: Type.Optional(Type.String({ description: "File glob pattern (e.g. '*.ts')" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching for regex pre-filter" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat regex pre-filter as fixed string" })),
	context: Type.Optional(Type.Number({ description: "Number of context lines to show" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results" })),
});

function looksLikeRegex(pattern: string): boolean {
	return /[.*+?^${}()|[\]\\]/.test(pattern);
}

function shouldIgnorePath(filename?: string | null): boolean {
	if (!filename) return false;
	const normalized = filename.replaceAll("\\", "/");
	return WATCH_IGNORE.some((part) => normalized.includes(`/${part}/`) || normalized.startsWith(`${part}/`));
}

function formatJsonResults(raw: string, cwd: string): { text: string; hitCount: number } {
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.length === 0) return { text: "No matches found.", hitCount: 0 };

	const lines: string[] = [];
	for (const hit of parsed) {
		const unit = hit?.unit ?? {};
		const absFile: string = unit.file ?? "(unknown file)";
		const shownFile = absFile.startsWith(cwd) ? relative(cwd, absFile) : absFile;
		const line = unit.line ?? 1;
		const endLine = unit.end_line ?? line;
		const score = typeof hit?.score === "number" ? hit.score.toFixed(3) : "?";
		lines.push(`${shownFile}:${line}-${endLine} [score=${score}]`);
	}

	return { text: lines.join("\n"), hitCount: parsed.length };
}

export default function colgrepExtension(pi: ExtensionAPI) {
	let colgrepAvailable = false;
	let watcher: FSWatcher | null = null;
	let reindexTimer: ReturnType<typeof setTimeout> | null = null;
	let reindexInFlight = false;
	let pendingReindex = false;
	let setFooterStatus: (text: string) => void = () => {};
	let clearFooterStatus: () => void = () => {};

	async function runReindex(cwd: string, reason: string) {
		if (!colgrepAvailable) return;
		if (reindexInFlight) {
			pendingReindex = true;
			setFooterStatus("indexing… (queued updates)");
			return;
		}

		reindexInFlight = true;
		setFooterStatus(`indexing… (${reason})`);
		const result = await pi.exec("colgrep", ["init", "-y", "."], {
			cwd,
			timeout: 5 * 60 * 1000,
		});
		reindexInFlight = false;

		if (pendingReindex) {
			pendingReindex = false;
			void runReindex(cwd, "pending");
			return;
		}

		if (result.code !== 0) {
			setFooterStatus("indexing failed");
			console.error(`[colgrep-extension] reindex failed (${reason}): ${result.stderr || result.stdout}`);
			return;
		}

		clearFooterStatus();
	}

	function scheduleReindex(cwd: string, reason: string) {
		if (!colgrepAvailable) return;
		setFooterStatus("index queued…");
		if (reindexTimer) clearTimeout(reindexTimer);
		reindexTimer = setTimeout(() => {
			reindexTimer = null;
			void runReindex(cwd, reason);
		}, REINDEX_DEBOUNCE_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		setFooterStatus = (text: string) => ctx.ui.setStatus(STATUS_KEY, `colgrep: ${text}`);
		clearFooterStatus = () => ctx.ui.setStatus(STATUS_KEY, "");

		const check = await pi.exec("colgrep", ["--version"], { cwd: ctx.cwd, timeout: 10_000 });
		colgrepAvailable = check.code === 0;

		if (!colgrepAvailable) {
			clearFooterStatus();
			ctx.ui.notify("colgrep not found in PATH. colgrep tool is inactive.", "warning");
			return;
		}

		const activeTools = pi.getActiveTools();
		const nextTools = activeTools.filter((name) => name !== "grep");
		if (!nextTools.includes("colgrep")) nextTools.push("colgrep");
		pi.setActiveTools(nextTools);

		// Warm index once per session.
		scheduleReindex(ctx.cwd, "session_start");

		try {
			watcher = watch(ctx.cwd, { recursive: true }, (_eventType, filename) => {
				if (shouldIgnorePath(filename)) return;
				scheduleReindex(ctx.cwd, "fs_watch");
			});
		} catch {
			// recursive watch isn't available on all platforms/filesystems.
		}
	});

	pi.on("session_shutdown", async () => {
		if (reindexTimer) clearTimeout(reindexTimer);
		reindexTimer = null;
		if (watcher) watcher.close();
		watcher = null;
		clearFooterStatus();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!colgrepAvailable || event.isError) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			scheduleReindex(ctx.cwd, `tool:${event.toolName}`);
		}
	});

	pi.registerCommand("colgrep-reindex", {
		description: "Force a ColGrep index refresh for the current project",
		handler: async (_args, ctx) => {
			if (!colgrepAvailable) {
				ctx.ui.notify("colgrep is not available.", "error");
				return;
			}
			await runReindex(ctx.cwd, "manual_command");
			ctx.ui.notify("ColGrep index refreshed.", "success");
		},
	});

	pi.registerTool({
		name: "colgrep",
		label: "colgrep",
		description: `Semantic/hybrid code search with ColGrep. Use natural-language intent in query, optionally add a regex pre-filter. Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Semantic + hybrid code search (prefer this over grep).",
		promptGuidelines: [
			"Prefer colgrep instead of grep/glob for code discovery.",
			"Use query for semantic intent, and regex only when you need lexical constraints.",
		],
		parameters: colgrepSchema,

		renderCall(args: any, theme) {
			const query = typeof args.query === "string" ? args.query.trim() : "";
			const regex = typeof args.regex === "string" ? args.regex.trim() : "";
			const legacyPattern = !query && !regex && typeof args.pattern === "string" ? args.pattern.trim() : "";
			const shownPattern = regex || legacyPattern || query;
			const shownPath = args.path || ".";
			const shownLimit = args.limit ?? "default";

			let text = theme.fg("toolTitle", theme.bold("colgrep"));
			if (shownPattern) text += ` ${theme.fg("accent", `/${shownPattern}/`)}`;
			text += theme.fg("muted", ` in ${shownPath} limit ${shownLimit}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const details: any = result.details ?? {};
			const hitCount = typeof details.hitCount === "number" ? details.hitCount : undefined;
			const headline = hitCount === 0 ? "No matches found" : hitCount ? `${hitCount} matches` : "colgrep complete";
			if (!expanded) {
				return new Text(`${theme.fg(hitCount && hitCount > 0 ? "success" : "muted", headline)} ${theme.fg("dim", "(ctrl+o to expand)")}`, 0, 0);
			}

			let text = theme.fg(hitCount && hitCount > 0 ? "success" : "muted", headline);
			if (details.commandLine) text += `\n${theme.fg("dim", details.commandLine)}`;
			if (result.content?.[0]?.type === "text") text += `\n${theme.fg("muted", result.content[0].text)}`;
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
			if (!colgrepAvailable) {
				throw new Error("colgrep is not available in PATH. Install it first: https://github.com/lightonai/next-plaid/tree/main/colgrep");
			}

			const searchPath = params.path ? (isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path)) : ctx.cwd;
			const args: string[] = ["--json"];

			if (params.limit && params.limit > 0) args.push("-k", String(params.limit));
			if (params.context && params.context >= 0) args.push("-n", String(params.context));
			if (params.glob) args.push("--include", params.glob);

			let query = (params.query ?? "").trim();
			let regex = (params.regex ?? "").trim();

			if (!query && typeof params.pattern === "string") {
				const p = params.pattern.trim();
				if (params.literal || params.ignoreCase || looksLikeRegex(p)) regex = p;
				else query = p;
			}

			if (!query && !regex) {
				throw new Error("colgrep requires at least one of: query, regex, or pattern");
			}

			if (regex && params.ignoreCase && !params.literal) {
				regex = `(?i:${regex})`;
			}

			if (regex) {
				args.push("-e", regex);
				if (params.literal) args.push("-F");
			}
			if (query) args.push(query);

			args.push(searchPath);

			const commandLine = `colgrep ${args.map((a: string) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;

			const result = await pi.exec("colgrep", args, {
				signal,
				cwd: ctx.cwd,
				timeout: 2 * 60 * 1000,
			});

			if (result.code !== 0) {
				throw new Error(result.stderr || result.stdout || "colgrep command failed");
			}

			let outputText: string;
			let hitCount = 0;
			try {
				const formatted = formatJsonResults(result.stdout, ctx.cwd);
				outputText = formatted.text;
				hitCount = formatted.hitCount;
			} catch {
				outputText = result.stdout.trim() || "No matches found.";
			}

			const truncation = truncateHead(outputText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let text = truncation.content;
			let fullOutputPath: string | undefined;

			if (truncation.truncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-colgrep-"));
				fullOutputPath = join(tempDir, "colgrep-output.txt");
				writeFileSync(fullOutputPath, outputText, "utf-8");
				text += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					truncation,
					fullOutputPath,
					backend: "colgrep",
					hitCount,
					commandLine,
					path: searchPath,
					query,
					regex,
				},
			};
		},
	});
}
