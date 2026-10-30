/**
 * 工具调用紧凑显示
 *
 * Pi 未展开工具结果时只显示固定行数，这些行数硬编码在渲染器里，没有对应设置项，
 * 而且每次升级 pi 都会重装 node_modules。本扩展在运行时接管 bash / grep / ls / find /
 * write / edit 的渲染：
 *
 * - 折叠时结果区不占行，调用行、结果摘要、耗时合并成一行，仍使用 pi 默认的卡片 shell。
 * - 运行时把折叠工具的卡片纵向内边距压到 0，并去掉块前空行，让相邻调用连成一片。
 * - 连续的工具调用会收进一个折叠组，默认只显示一行摘要，点开后是各个工具的卡片。
 * - edit / write 不进组：改动文件的操作需要始终可见，它们各自单独占一行（保留 diff/行数摘要），
 *   连续出现时连成一片、不占块前空行，点这一行展开详情，与组里成员走同一条原生点击路径；
 *   但紧跟折叠组时保留块前空行，让组的摘要行和文件修改行不被读成同一块。
 * - 只有展开（app.tools.expand）时才输出完整命令、输出或 diff。
 *
 * 配置（可选，未配置的项使用 DEFAULTS，当前均为 0，即折叠时不预览结果内容）。
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
 * 配置值大于 0 时，折叠状态下会在调用行下面额外输出这么多行预览。
 * 修改配置后需要重启会话或执行 /reload。
 * read 未展开时本来就不显示内容（只显示调用行），因此不在这里覆盖。
 *
 * 运行时可临时关闭：`/tool-lines off` 卸下两个原型补丁，后续工具调用回到 pi 原生渲染，
 * `/tool-lines on` 再装回来，两者都只影响当前进程。想在每次启动时就关闭，
 * 在同一份配置里写 `"enabled": false`。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	ToolExecutionComponent,
	formatSize,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	renderDiff,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** 支持覆盖的工具及其默认预览行数，0 表示折叠时不预览结果内容 */
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

/** 单行内摘要与耗时的分隔符 */
const SEPARATOR = " · ";

/** 折叠摘要里错误信息的最大字符数 */
const ERROR_SUMMARY_CHARS = 60;

/**
 * 折叠状态下把工具卡片压成一行：
 * - children 第一项是 pi 加的 Spacer(1)，负责块与块之间的空行；折叠时把它压成 0 行。
 * - 卡片外壳是 Box(1, 1)，折叠时把纵向内边距设为 0，展开时还原成 1，交互逻辑保持 pi 原本的实现。
 * 对所有工具生效，包括未接管渲染的 read，折叠组展开后各成员的高度才一致。
 */

/**
 * 连续工具块的成员标记：折叠时把块前空行压到 0。成员可能是折叠组里的工具，
 * 也可能是紧跟工具块、但不进组的 edit / write。
 *
 * 字符串沿用旧名 "pi.tool-group-member"：这个 symbol 会留在组件实例上，/reload 换掉模块
 * 实例后仍要靠同一个 key 认出旧标记，改字符串会让已渲染的成员重新长出空行。
 */
const TOOL_BLOCK_MEMBER = Symbol.for("pi.tool-group-member");

/**
 * 补丁登记表：每个点位记下「装上的包装函数」和「装之前的方法」。
 * 前者用于判断补丁是否还归本扩展，后者用于还原成 pi 的原生渲染。
 *
 * 表挂在 globalThis 上：/reload 换掉的是模块实例，全局槽位不变，新实例才能认出上一个
 * 实例留下的补丁，而不是在原型上再叠一层。两条不变量：
 * - 只有原型上仍是本扩展的包装函数时才还原，不覆盖其他扩展后加的补丁；
 * - 重装或卸下时清理条目，调用链长度不随 reload 次数增长。
 */
const PATCH_TABLE_KEY = Symbol.for("pi.tool-lines.patches");

interface PatchTable {
	compactRows?: {
		wrapper: PatchableExecution["updateDisplay"];
		original: PatchableExecution["updateDisplay"];
	};
	toolGroups?: {
		wrapper: PatchableContainer["addChild"];
		original: PatchableContainer["addChild"];
	};
}

function patchTable(): PatchTable {
	const store = globalThis as unknown as Record<symbol, PatchTable | undefined>;
	const existing = store[PATCH_TABLE_KEY];
	if (existing !== undefined) {
		return existing;
	}
	const created: PatchTable = {};
	store[PATCH_TABLE_KEY] = created;
	return created;
}

interface PatchableSpacer {
	setLines?: (lines: number) => void;
}

interface PatchableExecution {
	toolName?: string;
	expanded?: boolean;
	contentBox?: { paddingY?: number; invalidateCache?: () => void };
	children?: PatchableSpacer[];
	updateDisplay: () => void;
	[TOOL_BLOCK_MEMBER]?: boolean;
}

/**
 * 不进折叠组的工具。折叠组把成员整个藏起来，edit / write 恰恰是必须一眼看到的改动，
 * 所以它们留在 transcript 里逐个渲染，折叠状态由自己的点击控制。
 */
const UNGROUPED_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/** 组件的 toolName 是 pi 的私有字段，运行时可读；读不到时按进组处理，退回原有分组行为 */
function isUngroupedTool(component: ToolExecutionComponent): boolean {
	const { toolName } = component as unknown as PatchableExecution;
	return typeof toolName === "string" && UNGROUPED_TOOLS.has(toolName);
}

/** 标记组件属于连续工具块：紧跟在前一个工具块后面的 edit / write，块前空行压到 0 */
function markToolBlockMember(component: ToolExecutionComponent): void {
	const execution = component as unknown as PatchableExecution;
	execution[TOOL_BLOCK_MEMBER] = true;
	// children[0] 是 pi 加的 Spacer(1)，成为块成员后立即压掉
	execution.children?.[0]?.setLines?.(0);
}

function installCompactRows(): void {
	try {
		const prototype = ToolExecutionComponent.prototype as unknown as PatchableExecution;
		const table = patchTable();

		// /reload 后原型上还挂着上一个实例的包装函数：先剥回它记录的 original，
		// 否则每 reload 一次调用链就多一层。被其他扩展接管过的方法不在此列，原样保留。
		const previous = table.compactRows;
		if (previous !== undefined && prototype.updateDisplay === previous.wrapper) {
			prototype.updateDisplay = previous.original;
		}
		delete table.compactRows;

		const original = prototype.updateDisplay;
		prototype.updateDisplay = function (this: PatchableExecution): void {
			const expanded = this.expanded === true;

			// 展开时保留卡片内边距，折叠时压到 0，让整块只剩调用行
			const box = this.contentBox;
			if (box !== undefined) {
				const desired = expanded ? 1 : 0;
				if (box.paddingY !== desired) {
					box.paddingY = desired;
					box.invalidateCache?.();
				}
			}

			// children[0] 是 pi 固定加在块前的 Spacer(1)。
			// 不能只在渲染结果里删掉那行空行：鼠标坐标按 children 高度换算，布局和坐标必须一起变。
			// 块成员之间不留空行；其余独立工具保留一行，和 thinking 折叠块的间距一致。
			// 展开时恢复那一行，所以展开紧贴的卡片会整体下移一行，这是有意的。
			const spacer = this.children?.[0];
			if (spacer !== undefined && typeof spacer.setLines === "function") {
				spacer.setLines(expanded || this[TOOL_BLOCK_MEMBER] !== true ? 1 : 0);
			}

			original.call(this);
		};

		table.compactRows = { wrapper: prototype.updateDisplay, original };
	} catch {
		// 升级 pi 后内部结构变化时跳过，扩展其余部分仍然生效
	}
}

/** 还原成原生渲染。只撕掉仍归本扩展的方法，其他扩展的补丁原样留着。 */
function uninstallCompactRows(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as PatchableExecution;
	const table = patchTable();
	const entry = table.compactRows;
	if (entry === undefined) {
		return;
	}
	if (prototype.updateDisplay === entry.wrapper) {
		prototype.updateDisplay = entry.original;
	}
	delete table.compactRows;
}

/** 折叠组只依赖工具组件的这几个成员，不绑定具体类 */
interface GroupMember extends Component {
	isPartial?: boolean;
	expanded?: boolean;
	result?: { isError?: boolean };
	setExpanded?: (expanded: boolean) => void;
	ui?: { requestRender?: () => void };
}

/** pi 把主题存在 globalThis 上，用于跨模块加载器共享；这里只读 */
const THEME_KEYS = [
	Symbol.for("@earendil-works/pi-coding-agent:theme"),
	Symbol.for("@mariozechner/pi-coding-agent:theme"),
] as const;

function globalTheme(): ThemeLike | undefined {
	const store = globalThis as unknown as Record<symbol, ThemeLike | undefined>;
	for (const key of THEME_KEYS) {
		const candidate = store[key];
		if (candidate !== undefined && typeof candidate.fg === "function") {
			return candidate;
		}
	}
	return undefined;
}

/**
 * 连续工具调用的折叠组。
 * 折叠时输出一行摘要，展开时先输出同一行（可点回折叠），再按顺序渲染成员。
 * 鼠标坐标按标题行偏移后转发，所以组内单个工具仍用 pi 原生的点击展开看详情。
 */
class ToolGroup implements Component {
	private readonly members: GroupMember[] = [];
	private collapsed = true;

	add(member: GroupMember): void {
		this.members.push(member);
	}

	invalidate(): void {
		for (const member of this.members) {
			member.invalidate?.();
		}
	}

	render(width: number): string[] {
		// 与 thinking 折叠块保持一致：组前面留一行空行，组内成员之间不留
		const lines = ["", this.headerLine(width)];
		if (this.collapsed) {
			return lines;
		}
		for (const member of this.members) {
			lines.push(...member.render(width));
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 第 0 行是空行，第 1 行是摘要，两者都可以切换折叠
		if (event.type === "click" && event.button === "left" && event.y <= 1) {
			this.collapsed = !this.collapsed;
			this.requestRender();
			return { handled: true };
		}
		if (this.collapsed || event.y < 2) {
			return undefined;
		}
		const localY = event.y - 2;
		let offset = 0;
		for (const member of this.members) {
			const height = member.render(event.width).length;
			if (localY >= offset && localY < offset + height) {
				const forwarded = { ...event, y: localY - offset, height };
				const handled = member.handleMouse?.(forwarded);
				if (handled !== undefined) {
					return handled;
				}
				// 只处理左键点击。鼠标移动、滚轮等事件必须原样放弃，否则 hover 也会切换展开状态。
				if (event.type !== "click" || event.button !== "left") {
					return undefined;
				}
				// 成员首行是 Spacer，展开后还有一行内边距，两者都包不到 MouseRegion。
				// 点在这些空白上时直接切换成员自己的展开状态，整张卡片才能点击收起。
				if (typeof member.setExpanded === "function") {
					member.setExpanded(member.expanded !== true);
					member.ui?.requestRender?.();
					return { handled: true };
				}
				return undefined;
			}
			offset += height;
		}
		return undefined;
	}

	private requestRender(): void {
		for (const member of this.members) {
			if (member.ui?.requestRender !== undefined) {
				member.ui.requestRender();
				return;
			}
		}
	}

	private headerLine(width: number): string {
		const theme = globalTheme();
		const count = this.members.length;
		const failed = this.members.filter((member) => member.result?.isError === true).length;
		const running = this.members.some((member) => member.isPartial === true);
		const details = [`${count} tool ${count === 1 ? "call" : "calls"}`];
		if (failed > 0) {
			details.push(`${failed} failed`);
		}
		if (running) {
			details.push("running");
		}
		// 先按纯文本截断，再着色，避免截断 ANSI 序列
		const body = clipPlainText(`⚙ ${details.join(" · ")}`, Math.max(1, width - 2));
		const suffix = ` (${this.collapsed ? "click to expand" : "click to collapse"})`;
		const tail = visibleWidth(body) + visibleWidth(suffix) <= width ? suffix : "";
		if (theme === undefined) {
			return ` ${body}${tail}`;
		}
		const tone = failed > 0 ? "error" : "toolTitle";
		return ` ${theme.bold(theme.fg(tone, body))}${theme.fg("muted", tail)}`;
	}
}

/**
 * 只含 toolCall、没有可见文本的 assistant 组件渲染为空行数，但会占据 children 的位置。
 * 不清掉它，一轮一个的 assistant 组件会把连续的工具调用全部断开。
 */
function isInvisibleAssistant(component: unknown): boolean {
	if (component === null || typeof component !== "object") {
		return false;
	}
	const candidate = component as {
		constructor?: { name?: string };
		lastMessage?: { content?: unknown };
	};
	if (candidate.constructor?.name !== "AssistantMessageComponent") {
		return false;
	}
	const content = candidate.lastMessage?.content;
	// 内容为空说明消息刚开始流式，可能还会出现文本，不能当作不可见
	if (!Array.isArray(content) || content.length === 0) {
		return false;
	}
	return !content.some((block) => {
		if (block === null || typeof block !== "object") {
			return false;
		}
		const item = block as { type?: string; text?: string; thinking?: string };
		if (item.type === "text") {
			return (item.text ?? "").trim() !== "";
		}
		if (item.type === "thinking") {
			return (item.thinking ?? "").trim() !== "";
		}
		return false;
	});
}

/**
 * pi 把每个工具组件直接 addChild 到 transcript 容器，扩展只能拿到单个组件。
 * 这里在容器层把连续的工具组件收进 ToolGroup：
 * - 单个工具也建组，折叠后与多个工具的外观一致。
 * - 中间插入文本、状态行等普通组件会自然断开，下一批工具另开一组。
 * - 只含 toolCall 的 assistant 组件会被先清掉，它们本来就不渲染任何行。
 */
interface PatchableContainer {
	children: unknown[];
	addChild: (component: unknown) => void;
}

function installToolGroups(): void {
	try {
		const prototype = Container.prototype as unknown as PatchableContainer;
		const table = patchTable();

		// 与折叠补丁同理：先剥掉上一个实例留下的包装函数，再以它底下那一层为 original。
		const previous = table.toolGroups;
		if (previous !== undefined && prototype.addChild === previous.wrapper) {
			prototype.addChild = previous.original;
		}
		delete table.toolGroups;

		const original = prototype.addChild;
		prototype.addChild = function (this: PatchableContainer, component: unknown): void {
			if (component instanceof ToolExecutionComponent) {
				// 先清掉末尾不可见的 assistant 组件，连续工具才能归到同一组
				while (this.children.length > 0 && isInvisibleAssistant(this.children[this.children.length - 1])) {
					this.children.pop();
				}
				const last = this.children[this.children.length - 1];
				// 不进组的工具直接进 transcript：它不能进组，后面的工具也不能把它吸收进组
				if (isUngroupedTool(component)) {
					// 连续的 edit / write 连成一片，只占一行；但紧跟折叠组时保留块前空行，
					// 否则组的摘要行和「edit 路径」行贴在一起，会读成同一个折叠块的一部分。
					if (last instanceof ToolExecutionComponent) {
						markToolBlockMember(component);
					}
					original.call(this, component);
					return;
				}
				if (last instanceof ToolGroup) {
					markToolBlockMember(component);
					last.add(component as unknown as GroupMember);
					return;
				}
				// 单个工具也建组，折叠后的外观与多个工具一致
				const group = new ToolGroup();
				if (last instanceof ToolExecutionComponent && !isUngroupedTool(last)) {
					this.children.pop();
					markToolBlockMember(last);
					group.add(last as unknown as GroupMember);
				}
				markToolBlockMember(component);
				group.add(component as unknown as GroupMember);
				this.children.push(group);
				return;
			}
			original.call(this, component);
		};

		table.toolGroups = { wrapper: prototype.addChild, original };
	} catch {
		// 升级 pi 后内部结构变化时跳过，工具退回逐个显示
	}
}

/** 取消分组，后续工具回到 pi 原本的逐个 addChild。 */
function uninstallToolGroups(): void {
	const prototype = Container.prototype as unknown as PatchableContainer;
	const table = patchTable();
	const entry = table.toolGroups;
	if (entry === undefined) {
		return;
	}
	if (prototype.addChild === entry.wrapper) {
		prototype.addChild = entry.original;
	}
	delete table.toolGroups;
}

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
	isPartial?: boolean;
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
	enabled: boolean;
}

/** 挂在 context.state 上的折叠摘要 */
interface RowSummary {
	text: string;
	tone: "muted" | "warning" | "error";
}

/** 一次读取并解析配置，避免启动时重复读同一文件 */
function loadConfig(): PreviewConfig {
	const lines = { ...DEFAULTS } as Record<ToolName, number>;
	let commandChars = DEFAULT_COMMAND_CHARS;
	let enabled = true;
	if (!existsSync(CONFIG_PATH)) {
		return { lines, commandChars, enabled };
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof parsed !== "object" || parsed === null) {
			return { lines, commandChars, enabled };
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
		// 只认布尔值：写成字符串之类就保持默认开启，不替用户猜意图
		if (typeof record.enabled === "boolean") {
			enabled = record.enabled;
		}
	} catch {
		// 配置写错时退回默认值，不阻塞扩展加载
	}
	return { lines, commandChars, enabled };
}

const CONFIG = loadConfig();
const { lines: LINES, commandChars: COMMAND_CHARS } = CONFIG;

/**
 * 当前进程是否启用。配置里的 enabled 只决定初值；/tool-lines on|off 只改内存，不写文件，
 * 避免改写用户手写的配置。
 */
let enabled = CONFIG.enabled;

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
class ToolRow implements Component {
	private parts: LinePart[] = [];
	private readonly theme: ThemeLike;

	constructor(theme: ThemeLike) {
		this.theme = theme;
	}

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

/** 结果区容器；折叠时保持为空，卡片只剩调用行 */
function resultContainer(context: RenderContextLike): Container {
	const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
	container.clear();
	return container;
}

/**
 * 多行内容：按终端宽度折行，逐行不补空格。
 * 不用内置 Text：它在无背景色时也会把每行补齐到整宽，展开的 diff/输出复制出来会带一截行尾空格。
 */
class PlainText implements Component {
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}
		if (!this.text || this.text.trim() === "") {
			this.cachedWidth = width;
			this.cachedLines = [];
			return this.cachedLines;
		}
		const available = width;
		const wrapped = wrapTextWithAnsi(this.text, available);
		this.cachedWidth = width;
		this.cachedLines = wrapped;
		return this.cachedLines;
	}
}

/**
 * 折叠摘要来自 renderResult，但调用行由 renderCall 先渲染，因此摘要变化后需要重排一次。
 * 渲染期间同步调用 invalidate 会重入 updateDisplay，这里推迟到下一轮事件循环并做幂等。
 */
function scheduleRefresh(context: RenderContextLike): void {
	const state = (context.state ??= {});
	if (state.refreshScheduled === true) {
		return;
	}
	state.refreshScheduled = true;
	const handle = setTimeout(() => {
		state.refreshScheduled = false;
		try {
			context.invalidate?.();
		} catch {
			// 会话切换或退出后组件已被销毁，忽略即可
		}
	}, 0);
	handle.unref?.();
}

function publishRowSummary(context: RenderContextLike, summary: RowSummary | undefined): void {
	const state = (context.state ??= {});
	const previous = state.rowSummary as RowSummary | undefined;
	const unchanged =
		(previous === undefined && summary === undefined) ||
		(previous !== undefined && summary !== undefined && previous.text === summary.text && previous.tone === summary.tone);
	if (unchanged) {
		return;
	}
	if (summary === undefined) {
		delete state.rowSummary;
	} else {
		state.rowSummary = summary;
	}
	scheduleRefresh(context);
}

function readRowSummary(context: RenderContextLike): RowSummary | undefined {
	return (context.state ??= {}).rowSummary as RowSummary | undefined;
}

function expandHint(): string {
	return keyHint("app.tools.expand", "to expand");
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

/** 补丁在宿主原型上的现状 */
type PatchState = "absent" | "ours" | "taken";

/**
 * 运行时开关：装上/卸下两个补丁，并决定注册的渲染器是否让位给 pi 原生实现。
 * 关闭时先停计时器再拆补丁，避免拆完还有 interval 在请求重绘。
 */
function setEnabled(next: boolean): void {
	enabled = next;
	if (next) {
		installCompactRows();
		installToolGroups();
		return;
	}
	stopAllTimers();
	uninstallToolGroups();
	uninstallCompactRows();
}

function compactRowsState(): PatchState {
	const entry = patchTable().compactRows;
	if (entry === undefined) {
		return "absent";
	}
	const prototype = ToolExecutionComponent.prototype as unknown as PatchableExecution;
	return prototype.updateDisplay === entry.wrapper ? "ours" : "taken";
}

function toolGroupsState(): PatchState {
	const entry = patchTable().toolGroups;
	if (entry === undefined) {
		return "absent";
	}
	const prototype = Container.prototype as unknown as PatchableContainer;
	return prototype.addChild === entry.wrapper ? "ours" : "taken";
}

function patchStateLabel(state: PatchState): string {
	if (state === "ours") {
		return "本扩展";
	}
	if (state === "taken") {
		return "已被其他扩展接管";
	}
	return "未安装";
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

/** 折叠状态下只保留一句摘要；完整警告留给展开态 */
function compactWarnings(warnings: string[]): string | undefined {
	if (warnings.length === 0) {
		return undefined;
	}
	if (warnings.some((warning) => warning.startsWith("Truncated"))) {
		return "truncated";
	}
	return clipPlainText(warnings[0], ERROR_SUMMARY_CHARS);
}

function makeSummary(parts: (string | undefined)[], tone: RowSummary["tone"] = "muted"): RowSummary | undefined {
	const text = parts.filter((part): part is string => part !== undefined && part !== "").join(SEPARATOR);
	if (!text) {
		return undefined;
	}
	return { text, tone };
}

/** 折叠态的错误摘要：取首行有效内容，过长截断 */
function publishErrorSummary(context: RenderContextLike, lines: string[]): void {
	const firstLine = lines.find((line) => line.trim() !== "") ?? "error";
	publishRowSummary(context, { text: clipPlainText(firstLine, ERROR_SUMMARY_CHARS), tone: "error" });
}

function lineCountSummary(total: number): string {
	return `${total} ${total === 1 ? "line" : "lines"}`;
}

/** 组装单行：调用信息 + 折叠摘要 + 耗时，全部塞进一行由 ToolRow 截断 */
function buildToolRow(
	theme: ThemeLike,
	parts: LinePart[],
	summary: RowSummary | undefined,
	timer: string | undefined,
): ToolRow {
	const all = [...parts];
	if (summary !== undefined) {
		all.push({ text: `${SEPARATOR}${summary.text}`, color: summary.tone });
	}
	if (timer !== undefined) {
		all.push({ text: `${SEPARATOR}${timer}`, color: "muted" });
	}
	const row = new ToolRow(theme);
	row.setParts(all);
	return row;
}

/** 多行内容组件；缩进由卡片外壳的 paddingX 负责，名字保留历史称呼 */
function indentedText(text: string): PlainText {
	return new PlainText(text);
}

function pathPart(rawPath: string): LinePart {
	// 路径来自模型和文件系统，属于不可信数据，先去除控制字符再显示
	const display = rawPath ? shortenPath(sanitizeDisplayText(rawPath)) : "";
	return {
		text: ` ${display || "..."}`,
		color: display ? "accent" : "toolOutput",
	};
}

/** 参数统一按 key/value 展开；非对象参数归入 `args` */
function parseCallEntries(args: unknown): [string, unknown][] {
	if (args == null) {
		return [];
	}
	return typeof args === "object" && !Array.isArray(args)
		? Object.entries(args as Record<string, unknown>)
		: [["args", args]];
}

/** 折叠态的参数预览：key=value 单行，过长截断 */
function formatCallPairs(entries: [string, unknown][]): string {
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	return pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs;
}

/** 复刻内置 fallback 的 key=value 折叠格式，保证 grep/ls/find 的调用行与 pi 一致 */
function callHeaderParts(name: string, args: unknown): LinePart[] {
	const parts: LinePart[] = [{ text: name, color: "toolTitle", bold: true }];
	const entries = parseCallEntries(args);
	if (entries.length > 0) {
		parts.push({ text: ` ${formatCallPairs(entries)}`, color: "muted" });
	}
	return parts;
}

function expandedCallText(name: string, args: unknown, theme: ThemeLike): string {
	const header = theme.fg("toolTitle", theme.bold(name));
	const entries = parseCallEntries(args);
	if (entries.length === 0) {
		return header;
	}
	const lines = entries.map(([key, value]) => {
		const text =
			typeof value === "string"
				? sanitizeDisplayText(value)
				: (JSON.stringify(value, null, 2) ?? String(value));
		return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
	});
	return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
}

function bashCall(args: unknown, theme: ThemeLike, context: RenderContextLike): Component {
	startTimer(context);
	const record = (args ?? {}) as Record<string, unknown>;
	const rawCommand = typeof record.command === "string" ? record.command : "";
	const timeout = record.timeout;
	const timeoutText = typeof timeout === "number" ? ` (timeout ${timeout}s)` : "";

	if (context.expanded) {
		const body = sanitizeDisplayText(rawCommand) || "...";
		const suffix = timeoutText ? theme.fg("muted", timeoutText) : "";
		const timer = timerText(context, context.isPartial === true);
		const tail = timer ? theme.fg("muted", `${SEPARATOR}${timer}`) : "";
		return indentedText(`${theme.fg("toolTitle", theme.bold(`$ ${body}`))}${suffix}${tail}`);
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
	return buildToolRow(theme, parts, readRowSummary(context), timerText(context, context.isPartial === true));
}

function writePath(args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	return typeof record.file_path === "string"
		? record.file_path
		: typeof record.path === "string"
			? record.path
			: "";
}

function writeCall(args: unknown, theme: ThemeLike, context: RenderContextLike): Component {
	const rawPath = writePath(args);
	const record = (args ?? {}) as Record<string, unknown>;
	const content = typeof record.content === "string" ? record.content : null;
	const title: LinePart = { text: "write", color: "toolTitle", bold: true };

	if (content === null) {
		// 参数还在流式写入或调用本身非法：折叠时同样只占一行，展开时才显示原因
		if (!context.expanded) {
			const summary: RowSummary = { text: "invalid content arg - expected string", tone: "error" };
			return buildToolRow(theme, [title, pathPart(rawPath)], summary, timerText(context, context.isPartial === true));
		}
		return indentedText(
			`${theme.fg("toolTitle", theme.bold("write"))} ${rawPath ? shortenPath(sanitizeDisplayText(rawPath)) : "..."}\n${theme.fg("error", "[invalid content arg - expected string]")}`,
		);
	}

	// 文件内容通常以换行结尾，countLines 会把末尾换行算成一行，这里先去掉尾部空行再数
	const trimmedContent = content.replace(/\n+$/, "");
	const total = trimmedContent ? countLines(trimmedContent) : 0;
	const previewLines = context.expanded ? total : Math.min(LINES.write, total);

	if (!context.expanded && (previewLines === 0 || context.isError)) {
		// 折叠态必须只有一行：没有可预览的行，或结果报错。报错时不因为配置了预览行数就输出多行内容
		// 摘要由 renderResult 发布（错误或行数）；错误时把行数拼在后面，避免报错看不到写了多少
		const published = readRowSummary(context);
		const lineCount = total > 0 ? lineCountSummary(total) : undefined;
		const summary =
			published === undefined ? makeSummary([lineCount]) : makeSummary([published.text, lineCount], published.tone);
		return buildToolRow(theme, [title, pathPart(rawPath)], summary, timerText(context, context.isPartial === true));
	}

	// 折叠预览只解析需要的头部：write 参数会流式增长，每次对整个文件高亮是 O(n²)
	const source = previewLines < total ? headText(content, previewLines) : content;
	const normalized = sanitizeDisplayText(source).replace(/\t/g, "   ").replace(/\n+$/, "");
	const lang = getLanguageFromPath(rawPath);
	let highlighted = false;
	let lines: string[];
	if (lang && normalized.length <= 200_000) {
		lines = highlightCode(normalized, lang);
		highlighted = true;
	} else {
		lines = normalized.split("\n");
	}
	const shown = previewLines < lines.length ? lines.slice(0, previewLines) : lines;
	const styled = shown.map((line) => (highlighted ? line : theme.fg("toolOutput", line))).join("\n");
	const hidden = total - shown.length;
	const parts: LinePart[] = [title, pathPart(rawPath)];
	if (hidden > 0) {
		parts.push({ text: `${SEPARATOR}${lineCountSummary(total)}`, color: "muted" });
	}
	const row = buildToolRow(theme, parts, undefined, timerText(context, context.isPartial === true));
	const container = new Container();
	container.addChild(row);
	if (styled) {
		container.addChild(indentedText(`\n${styled}`));
	}
	return container;
}

function editPath(args: unknown): string {
	const record = (args ?? {}) as Record<string, unknown>;
	return typeof record.file_path === "string"
		? record.file_path
		: typeof record.path === "string"
			? record.path
			: "";
}

function editCall(args: unknown, theme: ThemeLike, context: RenderContextLike): Component {
	const rawPath = editPath(args);
	const parts: LinePart[] = [{ text: "edit", color: "toolTitle", bold: true }, pathPart(rawPath)];
	if (context.expanded) {
		const timer = timerText(context, context.isPartial === true);
		const tail = timer ? theme.fg("muted", `${SEPARATOR}${timer}`) : "";
		const display = rawPath ? shortenPath(sanitizeDisplayText(rawPath)) : "...";
		return indentedText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", display)}${tail}`);
	}
	return buildToolRow(theme, parts, readRowSummary(context), timerText(context, context.isPartial === true));
}

function genericCall(name: ToolName, args: unknown, theme: ThemeLike, context: RenderContextLike): Component {
	const timer = timerText(context, context.isPartial === true);
	if (context.expanded) {
		const tail = timer ? theme.fg("muted", `${SEPARATOR}${timer}`) : "";
		return indentedText(`${expandedCallText(name, args, theme)}${tail}`);
	}
	return buildToolRow(theme, callHeaderParts(name, args), readRowSummary(context), timer);
}

function renderCallFor(name: ToolName, args: unknown, theme: ThemeLike, context: RenderContextLike): Component {
	if (name === "bash") {
		return bashCall(args, theme, context);
	}
	if (name === "write") {
		return writeCall(args, theme, context);
	}
	if (name === "edit") {
		return editCall(args, theme, context);
	}
	return genericCall(name, args, theme, context);
}

/** 展开态：调用行下面是空行加完整内容 */
function addExpandedBody(container: Container, styled: string): void {
	if (styled) {
		container.addChild(indentedText(`\n${styled}`));
	}
}

/** 折叠态：预览 N 行（配置大于 0 时），否则什么都不渲染，让调用行独占一行 */
function addCollapsedPreview(
	container: Container,
	lines: string[],
	maxLines: number,
	keep: "start" | "end",
	theme: ThemeLike,
	hiddenLabel: (hidden: number) => string,
): void {
	if (maxLines <= 0 || lines.length === 0) {
		return;
	}
	const shown = keep === "end" ? lines.slice(-maxLines) : lines.slice(0, maxLines);
	if (shown.length > 0) {
		container.addChild(indentedText(`\n${shown.map((line) => theme.fg("toolOutput", line)).join("\n")}`));
	}
	const hidden = lines.length - shown.length;
	if (hidden > 0) {
		container.addChild(indentedText(hiddenLabel(hidden)));
	}
}

function bashResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): Component {
	const container = resultContainer(context);
	const details = (result.details ?? {}) as ShellDetails;
	const view = readOutput(context, result);
	let output = view.text;
	const fullOutputPath = details.fullOutputPath;

	// 内置渲染会剥离结果里附带的输出文件 footer，避免与警告重复
	if (!options.isPartial && details.truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	const lines = output === view.text ? view.lines : output ? output.split("\n") : [];
	const warnings = shellWarnings(details);

	if (options.expanded) {
		publishRowSummary(context, undefined);
		addExpandedBody(container, lines.map((line) => theme.fg("toolOutput", line)).join("\n"));
		if (warnings.length > 0) {
			container.addChild(indentedText(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`));
		}
		return container;
	}

	if (context.isError) {
		publishErrorSummary(context, lines);
		return container;
	}

	const warningText = compactWarnings(warnings);
	const summary = makeSummary(
		[lines.length > 0 ? lineCountSummary(lines.length) : undefined, warningText],
		warningText !== undefined ? "warning" : "muted",
	);
	publishRowSummary(context, summary);
	addCollapsedPreview(container, lines, LINES.bash, "end", theme, (hidden) => `... (${hidden} earlier lines, ${expandHint()})`);
	return container;
}

/**
 * edit / write 的错误结果：折叠时只把首行摘要并进调用行，卡片留空保持一行；
 * 完整错误文本只在展开时输出。展开与否看 renderResult 的 options，与同文件其它结果分支一致。
 */
function renderErrorBody(
	container: Container,
	view: OutputView,
	options: RenderOptionsLike,
	theme: ThemeLike,
	context: RenderContextLike,
): void {
	if (options.expanded) {
		publishRowSummary(context, undefined);
		// 用 trim 过的 text：原始错误常以换行结尾，留在正文里会多出一个空行
		if (view.text) {
			container.addChild(indentedText(`\n${theme.fg("error", view.text)}`));
		}
		return;
	}
	publishErrorSummary(context, view.lines);
}

function writeResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike,
	context: RenderContextLike,
): Component {
	const container = resultContainer(context);
	if (!context.isError) {
		return container;
	}
	renderErrorBody(container, readOutput(context, result), options, theme, context);
	return container;
}

function editResult(result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): Component {
	const container = resultContainer(context);

	if (context.isError) {
		renderErrorBody(container, readOutput(context, result), options, theme, context);
		return container;
	}

	const diff = (result.details as { diff?: unknown } | undefined)?.diff;
	if (typeof diff !== "string" || diff.length === 0) {
		publishRowSummary(context, undefined);
		return container;
	}

	const lines = sanitizeDisplayText(diff).replace(/\n+$/, "").split("\n");
	if (options.expanded) {
		publishRowSummary(context, undefined);
		addExpandedBody(container, renderDiff(lines.join("\n")));
		return container;
	}

	const maxLines = Math.min(LINES.edit, lines.length);
	publishRowSummary(context, makeSummary([`${lines.length} diff ${lines.length === 1 ? "line" : "lines"}`]));
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
		addExpandedBody(container, renderDiff(lines.slice(start, start + maxLines).join("\n")));
		const hidden = lines.length - start - maxLines;
		if (hidden > 0) {
			container.addChild(indentedText(theme.fg("muted", `... (${hidden} more lines, ${expandHint()})`)));
		}
	}
	return container;
}

function genericResult(name: ToolName, result: ToolResultLike, options: RenderOptionsLike, theme: ThemeLike, context: RenderContextLike): Component {
	const container = resultContainer(context);
	const view = readOutput(context, result);
	const lines = view.lines;
	const warnings = listWarnings(name, result.details);

	if (options.expanded) {
		publishRowSummary(context, undefined);
		addExpandedBody(container, lines.map((line) => theme.fg("toolOutput", line)).join("\n"));
		if (warnings.length > 0) {
			container.addChild(indentedText(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`));
		}
		return container;
	}

	if (context.isError) {
		publishErrorSummary(context, lines);
		return container;
	}

	const warningText = compactWarnings(warnings);
	publishRowSummary(
		context,
		makeSummary(
			[lines.length > 0 ? lineCountSummary(lines.length) : undefined, warningText],
			warningText !== undefined ? "warning" : "muted",
		),
	);
	addCollapsedPreview(container, lines, LINES[name], "start", theme, (hidden) => `... (${hidden} more lines, ${expandHint()})`);
	return container;
}

function renderResultFor(
	name: ToolName,
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike,
	context: RenderContextLike,
): Component {
	if (name === "bash") {
		return bashResult(result, options, theme, context);
	}
	if (name === "write") {
		return writeResult(result, options, theme, context);
	}
	if (name === "edit") {
		return editResult(result, options, theme, context);
	}
	return genericResult(name, result, options, theme, context);
}

export default function (pi: ExtensionAPI) {
	// 走 setEnabled 而不是直接安装：配置里写了 enabled: false 时也要卸一次——
	// /reload 之前那个实例的包装函数还挂在原型上，只跳过安装是关不掉的。
	setEnabled(enabled);

	// 逃生口：改完渲染代码发现行为不对时，先卸下补丁看原生输出，不必重启 pi
	pi.registerCommand("tool-lines", {
		description: "紧凑工具显示：on / off / status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				setEnabled(action === "on");
				ctx.ui.notify(
					action === "on"
						? "紧凑显示已开启（仅当前进程）"
						: "紧凑显示已关闭，后续工具调用走 pi 原生渲染；永久关闭请在配置文件里写 \"enabled\": false",
					"info",
				);
				return;
			}
			if (action !== "" && action !== "status") {
				ctx.ui.notify("用法：/tool-lines [on|off|status]", "error");
				return;
			}
			ctx.ui.notify(
				`紧凑显示${enabled ? "开启" : "关闭"}；配置${CONFIG.enabled ? "默认启用" : "已置 enabled: false"}；折叠补丁 ${patchStateLabel(compactRowsState())}；分组补丁 ${patchStateLabel(toolGroupsState())}`,
				"info",
			);
		},
	});

	// session_shutdown 覆盖 quit、reload、new、resume、fork，统一清理可能残留的计时器
	pi.on("session_shutdown", () => {
		stopAllTimers();
	});

	pi.registerToolRenderer((toolName, next) => {
		// 关掉后让位给后面的渲染器，工具卡片回到 pi 原生外观
		if (!enabled || !(toolName in DEFAULTS)) {
			return next();
		}
		const name = toolName as ToolName;
		const renderers: ToolRenderers = {
			// 保留 pi 默认卡片外壳：背景色、横向内边距和点击展开都由它提供，
			// 折叠时只把纵向内边距归零，展开时还原。
			renderShell: "default",
			renderCall(args, theme, context) {
				return renderCallFor(name, args, theme, context as unknown as RenderContextLike);
			},
			renderResult(result, options, theme, context) {
				return renderResultFor(
					name,
					result as unknown as ToolResultLike,
					options,
					theme,
					context as unknown as RenderContextLike,
				);
			},
		};
		return renderers;
	});
}
