/**
 * 工具输出预览行数
 *
 * Pi 未展开工具结果时只显示固定行数，这些行数硬编码在渲染器里，没有对应设置项，
 * 而且每次升级 pi 都会重装 node_modules。本扩展在运行时接管 bash / grep / ls / find /
 * write / edit 的结果渲染，把预览行数改成可配置值，升级后依然生效。
 *
 * 配置（可选，未配置的项使用 DEFAULTS，当前均为 0，即折叠时不显示结果内容）。
 * 示例：~/.pi/agent/tool-preview-lines.json
 * {
 *   "bash": 2,
 *   "grep": 2,
 *   "ls": 2,
 *   "find": 2,
 *   "write": 3,
 *   "edit": 3,
 *   "commandChars": 80
 * }
 *
 * 修改配置后需要重启会话或执行 /reload。
 * read 未展开时本来就不显示内容（只显示调用行），因此不在这里覆盖。
 * edit 内置行为是不管折叠与否都展示完整 diff，这里统一改成折叠时只显示前几行或行数提示。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	Text,
	stripTerminalSequences,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

/** 支持覆盖的工具及其默认预览行数，0 表示不显示结果内容 */
const DEFAULTS = {
	bash: 0,
	grep: 0,
	ls: 0,
	find: 0,
	write: 0,
	edit: 0,
} as const;

/** bash 调用行里命令的默认最大字符数，超出用省略号截断 */
const DEFAULT_COMMAND_CHARS = 80;

type ToolName = keyof typeof DEFAULTS;

const CONFIG_PATH = join(homedir(), ".pi", "agent", "tool-preview-lines.json");

interface TextBlock {
	type: string;
	text?: string;
}

interface ToolResultLike {
	content: TextBlock[];
	details?: unknown;
}

interface TruncationInfo {
	truncated?: boolean;
	truncatedBy?: string;
	outputLines?: number;
	totalLines?: number;
	maxBytes?: number;
	maxLines?: number;
}

interface ShellDetails {
	truncation?: TruncationInfo;
	fullOutputPath?: string;
}

interface RenderContextLike {
	lastComponent?: Component;
	cwd?: string;
	isError?: boolean;
	executionStarted?: boolean;
	durationMs?: number;
	expanded?: boolean;
	invalidate?: () => void;
	state?: Record<string, unknown>;
}

interface RenderOptionsLike {
	expanded: boolean;
	isPartial: boolean;
}

/** theme 结构按使用到的接口收窄；组件只需要 fg/bold */
interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface PreviewConfig {
	lines: Record<ToolName, number>;
	commandChars: number;
}

/** 一次读取并解析配置，避免启动时重复读同一文件 */
function loadConfig(): PreviewConfig {
	const lines = { ...DEFAULTS } as Record<ToolName, number>;
	let commandChars = DEFAULT_COMMAND_CHARS;
	if (!existsSync(CONFIG_PATH)) {
		return { lines, commandChars };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return { lines, commandChars };
		}
		const record = parsed as Record<string, unknown>;
		for (const name of Object.keys(DEFAULTS) as ToolName[]) {
			const value = record[name];
			if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
				lines[name] = value;
			}
		}
		const chars = record.commandChars;
		if (typeof chars === "number" && Number.isInteger(chars) && chars > 0) {
			commandChars = chars;
		}
	} catch {
		// 配置写错时退回默认值，不阻塞扩展加载
	}
	return { lines, commandChars };
}

const { lines: LINES, commandChars: COMMAND_CHARS } = loadConfig();

/** 只数换行符，避免为行数拆出整个数组 */
function countLines(text: string): number {
	let total = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		total++;
	}
	return total;
}

/** 取前 lineCount 行，不复制完整内容 */
function headText(text: string, lineCount: number): string {
	if (lineCount <= 0) {
		return "";
	}
	let index = -1;
	for (let line = 0; line < lineCount; line++) {
		index = text.indexOf("\n", index + 1);
		if (index === -1) {
			return text;
		}
	}
	return text.slice(0, index);
}

/**
 * 工具输出和文件内容都属于不可信数据：先去掉 ESC/OSC/APC 序列，再清掉残留的 C0/C1
 * 控制字符和不可见格式字符。stripTerminalSequences 在没有 ESC 时会原样返回，也不处理 C1。
 */
const UNSAFE_CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F-\x9F\uFFF9-\uFFFB]/g;

function sanitizeDisplayText(text: string): string {
	const withoutCarriageReturns = text.includes("\r") ? text.replace(/\r/g, "") : text;
	return stripTerminalSequences(withoutCarriageReturns).replace(UNSAFE_CONTROL_CHARS, "");
}

/** 整段处理比逐行处理少一轮拆分/拼接 */
function textOutput(result: ToolResultLike): string {
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	return sanitizeDisplayText(text);
}

interface OutputView {
	readonly result: ToolResultLike;
	/** 原始文本，用于保留 toolResult 自带的输出文件 footer */
	readonly rawText: string;
	readonly text: string;
	readonly lines: string[];
}

/**
 * 复用同一 result 的解析结果。
 * 工具流式更新会换新的 result 对象；而计时器每秒触发的重绘拿到的是同一个对象，
 * 缓存命中后不必再拆行、去 ANSI。
 * 缓存依赖 pi 每次更新都传入新的 result 对象（当前事件流如此）；若以后改为原地修改，需要换用内容指纹。
 */
function readOutput(context: RenderContextLike, result: ToolResultLike): OutputView {
	const state = (context.state ??= {});
	const cached = state.outputView as OutputView | undefined;
	if (cached !== undefined && cached.result === result) {
		return cached;
	}
	const rawText = textOutput(result);
	const text = rawText.trim();
	const view: OutputView = { result, rawText, text, lines: text ? text.split("\n") : [] };
	state.outputView = view;
	return view;
}

function shortenPath(path: string): string {
	const home = homedir();
	if (path === home) {
		return "~";
	}
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function pathDisplay(rawPath: string, theme: ThemeLike): string {
	if (!rawPath) {
		return theme.fg("toolOutput", "...");
	}
	return theme.fg("accent", sanitizeDisplayText(shortenPath(rawPath)));
}

/** 复用上一次的 Text 组件，避免每帧新建组件 */
function setResultText(context: RenderContextLike, text: string): Text {
	const component =
		context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function expandHint(): string {
	return keyHint("app.tools.expand", "to expand");
}

/**
 * 按「逻辑行」截断的通用结果渲染。
 * keep = "end" 时保留尾部（适合日志），"start" 时保留头部（适合列表）。
 */
function renderLineList(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike,
	context: RenderContextLike,
	maxLines: number,
	keep: "start" | "end",
	warnings: string[] = [],
): Text {
	const { lines } = readOutput(context, result);
	const shown = options.expanded
		? lines
		: maxLines === 0
			? []
			: keep === "end"
				? lines.slice(-maxLines)
				: lines.slice(0, maxLines);
	const hidden = lines.length - shown.length;

	let text = "";
	if (shown.length > 0) {
		text = `\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	}
	if (hidden > 0) {
		const label =
			shown.length === 0 ? `${hidden} lines` : keep === "end" ? `${hidden} earlier lines` : `${hidden} more lines`;
		text += `\n${theme.fg("muted", `... (${label},`)} ${expandHint()}${theme.fg("muted", ")")}`;
	}
	for (const warning of warnings) {
		text += `\n${theme.fg("warning", `[${warning}]`)}`;
	}
	return setResultText(context, text);
}

/** 按可见宽度截断纯文本，不插入 ANSI reset，避免破坏外层背景色 */
function clipPlainText(text: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	if (visibleWidth(text) <= maxWidth) {
		return text;
	}
	let result = "";
	for (const char of text) {
		if (visibleWidth(result + char) > maxWidth) {
			break;
		}
		result += char;
	}
	return result;
}

interface LinePart {
	text: string;
	color: string;
	bold?: boolean;
}

/** 单行调用行：按终端宽度截断，避免长命令折行占满多行 */
class SingleLineText implements Component {
	private parts: LinePart[] = [];

	constructor(private readonly theme: ThemeLike) {}

	setParts(parts: LinePart[]): void {
		this.parts = parts;
	}

	/** 无缓存可清理；但必须实现，TUI 的 MouseRegion 会直接调用 invalidate() */
	invalidate(): void {}

	render(width: number): string[] {
		const totalWidth = visibleWidth(this.parts.map((part) => part.text).join(""));
		if (totalWidth <= width) {
			return [this.parts.map((part) => this.style(part, part.text)).join("")];
		}

		// 留一列给省略号；截断在着色前完成，行内不出现 reset
		let remaining = Math.max(0, width - 1);
		let result = "";
		for (const part of this.parts) {
			const partWidth = visibleWidth(part.text);
			if (partWidth <= remaining) {
				result += this.style(part, part.text);
				remaining -= partWidth;
				continue;
			}
			result += this.style(part, clipPlainText(part.text, remaining));
			break;
		}
		return [`${result}…`];
	}

	private style(part: LinePart, text: string): string {
		const colored = this.theme.fg(part.color, text);
		return part.bold ? this.theme.bold(colored) : colored;
	}
}

/** 与内置 bash 渲染一致的视觉行预览：按终端宽度折行后保留尾部 */
class VisualLinePreview implements Component {
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly options: {
			text: string;
			maxVisualLines: number;
			keep: "start" | "end";
			formatHint: (hidden: number) => string;
		},
	) {}

	/** 主题变化时清缓存，避免继续输出旧配色 */
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const { text, maxVisualLines, keep, formatHint } = this.options;
		const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
		if (preview.skippedCount > 0) {
			const hint = formatHint(preview.skippedCount);
			this.cachedLines = keep === "start" ? [...preview.visualLines, hint] : [hint, ...preview.visualLines];
		} else {
			this.cachedLines = preview.visualLines;
		}
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

function startTimer(context: RenderContextLike): void {
	const state = (context.state ??= {});
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const total = Math.floor(seconds);
	const minutes = Math.floor(total / 60);
	const remainder = total % 60;
	if (minutes < 60) {
		return `${minutes}m ${remainder}s`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type TimerHandle = ReturnType<typeof setInterval>;

/** 记录活动计时器，便于在会话切换、reload 或退出时统一清理，避免旧工具行继续 tick */
const activeTimers = new Map<TimerHandle, Record<string, unknown>>();

function stopTimer(state: Record<string, unknown>): void {
	const timer = state.interval as TimerHandle | undefined;
	if (timer !== undefined) {
		clearInterval(timer);
		activeTimers.delete(timer);
		state.interval = undefined;
	}
}

function stopAllTimers(): void {
	for (const [timer, state] of activeTimers) {
		clearInterval(timer);
		state.interval = undefined;
	}
	activeTimers.clear();
}

function timerText(context: RenderContextLike, isPartial: boolean): string | undefined {
	const state = (context.state ??= {});
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		const timer = setInterval(() => {
			try {
				context.invalidate?.();
			} catch {
				// 防御：会话切换或退出后旧工具行可能已被销毁，继续 tick 只会重复抛错并终止进程
				stopTimer(state);
			}
		}, 1000);
		// 计时器只负责刷新界面，不应阻止进程退出
		timer.unref?.();
		state.interval = timer;
		activeTimers.set(timer, state);
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= Date.now();
		stopTimer(state);
	}
	if (!isPartial && context.durationMs !== undefined) {
		return `Took ${formatDuration(context.durationMs)}`;
	}
	if (state.startedAt === undefined) {
		return undefined;
	}
	const end = (state.endedAt as number | undefined) ?? Date.now();
	return `${isPartial ? "Elapsed" : "Took"} ${formatDuration(end - (state.startedAt as number))}`;
}

function listWarnings(name: ToolName, details: unknown): string[] {
	const data = (details ?? {}) as Record<string, unknown>;
	const truncation = data.truncation as TruncationInfo | undefined;
	const warnings: string[] = [];

	if (name === "grep") {
		const matchLimit = data.matchLimit;
		if (typeof matchLimit === "number") {
			warnings.push(`${matchLimit} matches limit`);
		}
	} else if (name === "ls") {
		const entryLimit = data.entryLimitReached;
		if (typeof entryLimit === "number") {
			warnings.push(`${entryLimit} entries limit`);
		}
	} else if (name === "find") {
		const resultLimit = data.resultLimitReached;
		if (typeof resultLimit === "number") {
			warnings.push(`${resultLimit} results limit`);
		}
	}

	if (truncation?.truncated) {
		warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	}
	if (name === "grep" && data.linesTruncated) {
		warnings.push("some lines truncated");
	}

	return warnings.length > 0 ? [`Truncated: ${warnings.join(", ")}`] : [];
}

function shellWarnings(details: ShellDetails): string[] {
	const warnings: string[] = [];
	if (details.fullOutputPath) {
		warnings.push(`Full output: ${details.fullOutputPath}`);
	}
	const truncation = details.truncation;
	if (truncation?.truncated) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			warnings.push(
				`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
			);
		}
	}
	return warnings;
}

export default function (pi: ExtensionAPI) {
	// session_shutdown 覆盖 quit、reload、new、resume、fork，统一清理可能残留的计时器
	pi.on("session_shutdown", () => {
		stopAllTimers();
	});

	pi.registerToolRenderer((toolName, next) => {
		if (!(toolName in DEFAULTS)) {
			return next();
		}

		const name = toolName as ToolName;

		if (name === "bash") {
			const renderers: ToolRenderers = {
				renderCall(args, theme, context) {
					startTimer(context);
					const record = (args ?? {}) as Record<string, unknown>;
					const rawCommand = typeof record.command === "string" ? record.command : "";
					const timeout = record.timeout;
					const timeoutText = typeof timeout === "number" ? ` (timeout ${timeout}s)` : "";

					if (context.expanded) {
						const body = sanitizeDisplayText(rawCommand) || "...";
						const text = `${theme.fg("toolTitle", theme.bold(`$ ${body}`))}${theme.fg("muted", timeoutText)}`;
						const component =
							context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
						component.setText(text);
						return component;
					}

					const command = sanitizeDisplayText(rawCommand.replace(/\s+/g, " ").trim());
					const body = command
						? visibleWidth(command) > COMMAND_CHARS
							? `${clipPlainText(command, COMMAND_CHARS)}…`
							: command
						: "...";
					const parts: LinePart[] = [{ text: `$ ${body}`, color: "toolTitle", bold: true }];
					if (timeoutText) {
						parts.push({ text: timeoutText, color: "muted" });
					}
					const component =
						context.lastComponent instanceof SingleLineText
							? context.lastComponent
							: new SingleLineText(theme);
					component.setParts(parts);
					return component;
				},
				renderResult(result, options, theme, context) {
					const component =
						context.lastComponent instanceof Container ? context.lastComponent : new Container();
					component.clear();

					const details = (result.details ?? {}) as ShellDetails;
					const view = readOutput(context, result);
					let output = view.text;
					const fullOutputPath = details.fullOutputPath;

					// 内置渲染会剥离结果里附带的输出文件footer，避免与警告重复
					if (!options.isPartial && details.truncation?.truncated && fullOutputPath && output.endsWith("]")) {
						const footerStart = output.lastIndexOf("\n\n[");
						if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
							output = output.slice(0, footerStart).trimEnd();
						}
					}

					const lines = output === view.text ? view.lines : output ? output.split("\n") : [];
					const compact = !options.expanded && LINES.bash === 0;

					if (output && options.expanded) {
						const styled = lines
							.map((line) => theme.fg("toolOutput", line))
							.join("\n");
						component.addChild(new Text(`\n${styled}`, 0, 0));
					} else if (output && !compact) {
						const styled = lines
							.map((line) => theme.fg("toolOutput", line))
							.join("\n");
						component.addChild(new Spacer(1));
						component.addChild(
							new VisualLinePreview({
								text: styled,
								maxVisualLines: LINES.bash,
								keep: "end",
								formatHint: (hidden) =>
									`${theme.fg("muted", `... (${hidden} earlier lines,`)} ${expandHint()}${theme.fg("muted", ")")}`,
							}),
						);
					}

					const warnings = shellWarnings(details);
					if (warnings.length > 0) {
						component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
					}

					const timer = timerText(context, options.isPartial);
					if (compact) {
						const parts: string[] = [];
						if (output) {
							parts.push(
								`${theme.fg("muted", `... (${lines.length} lines,`)} ${expandHint()}${theme.fg("muted", ")")}`,
							);
						}
						if (timer) {
							parts.push(theme.fg("muted", timer));
						}
						if (parts.length > 0) {
							component.addChild(new Text(`\n${parts.join(" · ")}`, 0, 0));
						}
					} else if (timer) {
						component.addChild(new Text(`\n${theme.fg("muted", timer)}`, 0, 0));
					}
					return component;
				},
			};
			return renderers;
		}

		if (name === "write") {
			const renderers: ToolRenderers = {
				renderCall(args, theme, context) {
					const record = (args ?? {}) as Record<string, unknown>;
					const rawPath = typeof record.file_path === "string" ? record.file_path : typeof record.path === "string" ? record.path : "";
					const content = typeof record.content === "string" ? record.content : null;
					let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay(rawPath, theme)}`;

					if (content === null) {
						text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
					} else if (content) {
						const total = countLines(content);
						const maxLines = context.expanded ? total : Math.min(LINES.write, total);
						let shown: string[] = [];
						if (maxLines > 0) {
							// 折叠时只解析预览需要的头部：write 参数会流式增长，每次都对整个文件高亮是 O(n²)
							const source = maxLines < total ? headText(content, maxLines) : content;
							const normalized = sanitizeDisplayText(source).replace(/\t/g, "   ");
							const lang = getLanguageFromPath(rawPath);
							let highlighted = false;
							let lines: string[];
							if (lang && normalized.length <= 200_000) {
								lines = highlightCode(normalized, lang);
								highlighted = true;
							} else {
								lines = normalized.split("\n");
							}
							shown = maxLines < lines.length ? lines.slice(0, maxLines) : lines;
							if (shown.length > 0) {
								text += `\n\n${shown
									.map((line) => (highlighted ? line : theme.fg("toolOutput", line)))
									.join("\n")}`;
							}
						}
						const hidden = total - shown.length;
						if (hidden > 0) {
							text += `\n${theme.fg("muted", `... (${hidden} more lines, ${total} total,`)} ${expandHint()}${theme.fg("muted", ")")}`;
						}
					}
					return setResultText(context, text);
				},
				renderResult(result, _options, theme, context) {
					if (!context.isError) {
						return setResultText(context, "");
					}
					const output = readOutput(context, result).rawText;
					return setResultText(context, output ? `\n${theme.fg("error", output)}` : "");
				},
			};
			return renderers;
		}

		if (name === "edit") {
			// 内置 edit 用 renderShell: "self" 并在调用行里提前预览 diff；这里改走默认 shell，
			// diff 放到结果区，折叠时只渲染头部和行数提示，展开时才渲染完整 diff。
			const renderers: ToolRenderers = {
				renderCall(args, theme, context) {
					const record = (args ?? {}) as Record<string, unknown>;
					const rawPath =
						typeof record.file_path === "string"
							? record.file_path
							: typeof record.path === "string"
								? record.path
								: "";
					return setResultText(
						context,
						`${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay(rawPath, theme)}`,
					);
				},
				renderResult(result, options, theme, context) {
					const component =
						context.lastComponent instanceof Container ? context.lastComponent : new Container();
					component.clear();

					if (context.isError) {
						const output = readOutput(context, result).rawText;
						if (output) {
							component.addChild(new Text(`\n${theme.fg("error", output)}`, 0, 0));
						}
						return component;
					}

					const diff = (result.details as { diff?: unknown } | undefined)?.diff;
					if (typeof diff !== "string" || diff.length === 0) {
						return component;
					}

					const lines = sanitizeDisplayText(diff).split("\n");
					const maxLines = options.expanded ? lines.length : Math.min(LINES.edit, lines.length);
					let text = "";
					if (maxLines > 0) {
						// 折叠预览从第一行改动附近开始，避免前面全是上下文、看不到真正改了什么
						let start = 0;
						if (maxLines < lines.length) {
							const firstChange = lines.findIndex((line) => line.startsWith("+") || line.startsWith("-"));
							if (firstChange !== -1) {
								const contextBefore = Math.min(1, maxLines - 1);
								start = Math.max(0, Math.min(firstChange - contextBefore, lines.length - maxLines));
							}
						}
						text = `\n${renderDiff(lines.slice(start, start + maxLines).join("\n"))}`;
					}
					const hidden = lines.length - maxLines;
					if (hidden > 0) {
						const label = maxLines === 0 ? `${hidden} lines` : `${hidden} more lines`;
						text += `\n${theme.fg("muted", `... (${label},`)} ${expandHint()}${theme.fg("muted", ")")}`;
					}
					if (text) {
						component.addChild(new Text(text, 0, 0));
					}
					return component;
				},
			};
			return renderers;
		}

		const base = next();
		const renderers: ToolRenderers = {
			...base,
			renderResult(result, options, theme, context) {
				const warnings = listWarnings(name, result.details);
				return renderLineList(result, options, theme, context, LINES[name], "start", warnings);
			},
		};
		return renderers;
	});
}
