/**
 * Skill 快捷调用扩展
 *
 * Pi 内置的技能调用有两个不便：
 * 1. `/skill:name` 只在消息开头展开一个技能，后面再写 `/skill:name` 会被当成普通文本。
 * 2. 补全候选统一带 `skill:` 前缀；消息中间再输入 `/` 时没有任何技能候选。
 *
 * 本扩展在 session_start 时为每个技能注册一个同名命令（技能 `code-review` → `/code-review`），
 * 并接管两处交互：
 *
 * 1. input 事件统一处理行首与正文里的技能引用：
 *      /code-review /tdd 审查并补测试            行首连续写，展开 2 个技能
 *      /skill:code-review /skill:tdd ...         显式写法，同样支持多个
 *      先做 A，然后用 /tdd 补测试                正文里的引用也会加载（去掉 `/` 后保留名字）
 * 2. 补全候选：行首的 `/` 保持 Pi 原行为（内置命令 + 裸名别名），并隐藏与之重复的内置
 *    `skill:name` 候选；消息中间再输入 `/` 时只给技能候选，补全后自动补一个空格。
 *
 * 多个技能合并进同一个 `<skill>` 块，既能保留 Pi 原生的折叠展示，也让模型一次拿到全部内容，
 * 不需要额外的 read 往返。单技能输出与内置 `_expandSkillCommand` 逐字节一致。
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CustomEditor,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type InputEventResult,
	type KeybindingsManager,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	EditorTheme,
	TUI,
} from "@earendil-works/pi-tui";

/**
 * Pi 内置 `/` 命令名，对应 core/slash-commands.ts 的 BUILTIN_SLASH_COMMANDS。
 * 内置命令在输入框层就先被处理，别名必须避开它们，否则补全项会被过滤并产生冲突告警。
 */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
	"settings",
	"model",
	"tree",
	"thinking",
	"scoped-models",
	"export",
	"import",
	"share",
	"bug",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
]);

/** `getCommands()` 里技能命令统一带的前缀。 */
const SKILL_COMMAND_PREFIX = "skill:";

interface SkillEntry {
	readonly name: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly description: string | undefined;
}

/** 一次技能展开的结果；失败信息用于提示用户而不是静默退化成普通文本。 */
type Expansion =
	| { readonly kind: "expanded"; readonly text: string }
	| { readonly kind: "failed"; readonly message: string };

function toSkillEntry(command: SlashCommandInfo): SkillEntry | undefined {
	if (!command.name.startsWith(SKILL_COMMAND_PREFIX)) {
		return undefined;
	}
	const name = command.name.slice(SKILL_COMMAND_PREFIX.length);
	if (name.length === 0) {
		return undefined;
	}
	return {
		name,
		filePath: command.sourceInfo.path,
		baseDir: command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path),
		description: command.description,
	};
}

/** 从当前会话的斜杠命令列表里取出所有已加载技能。 */
function collectSkills(pi: ExtensionAPI): Map<string, SkillEntry> {
	const skills = new Map<string, SkillEntry>();
	for (const command of pi.getCommands()) {
		if (command.source !== "skill") {
			continue;
		}
		const entry = toSkillEntry(command);
		if (entry !== undefined && !skills.has(entry.name)) {
			skills.set(entry.name, entry);
		}
	}
	return skills;
}

/**
 * 光标所在的、以 `/` 开头且不带空白的片段。前置边界允许标点（`，/td` 也算），
 * 但不允许字母、数字、`/`、`-`，避免把路径中间当成命令起点。
 */
const SLASH_TOKEN_AT_CURSOR = /(?:^|[^\w/\\-])\/([^\s]*)$/u;

/** 从 `/` 之后的片段取出技能名：去掉 `skill:` 前缀；空片段或含 `/`（路径）返回 undefined。 */
function skillNameFromToken(token: string): string | undefined {
	const body = token.startsWith(SKILL_COMMAND_PREFIX)
		? token.slice(SKILL_COMMAND_PREFIX.length)
		: token;
	if (body.length === 0 || body.includes("/")) {
		return undefined;
	}
	return body;
}

/** 给技能名打分，分数越小越靠前：前缀命中 → 任意词段前缀命中。返回 undefined 表示不匹配。 */
function scoreSkillName(name: string, query: string): number | undefined {
	const lowerName = name.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (lowerName.startsWith(lowerQuery)) {
		return 0;
	}
	return lowerName.split("-").some((segment) => segment.startsWith(lowerQuery)) ? 1 : undefined;
}

/** 生成行内 `/` 之后只包含技能的候选，前缀命中优先；没有命中时返回 undefined。 */
function buildSkillSuggestions(
	skills: ReadonlyMap<string, SkillEntry>,
	query: string,
): AutocompleteItem[] | undefined {
	const ranked: Array<{ skill: SkillEntry; score: number }> = [];
	for (const skill of skills.values()) {
		const score = scoreSkillName(skill.name, query);
		if (score !== undefined) {
			ranked.push({ skill, score });
		}
	}
	if (ranked.length === 0) {
		return undefined;
	}
	ranked.sort(
		(left, right) =>
			left.score - right.score ||
			left.skill.name.length - right.skill.name.length ||
			left.skill.name.localeCompare(right.skill.name),
	);
	return ranked.map(({ skill }) => ({
		value: skill.name,
		label: skill.name,
		...(skill.description ? { description: skill.description } : {}),
	}));
}

/** 隐藏内置 `skill:name` 候选：它们的落点与裸名别名完全相同，留着只会出现重复项。 */
function hideBuiltinSkillSuggestions(
	suggestions: AutocompleteSuggestions | null,
	shouldHide: (skillName: string) => boolean,
): AutocompleteSuggestions | null {
	if (suggestions === null) {
		return null;
	}
	const items = suggestions.items.filter((item) => {
		if (!item.value.startsWith(SKILL_COMMAND_PREFIX)) {
			return true;
		}
		return !shouldHide(item.value.slice(SKILL_COMMAND_PREFIX.length));
	});
	if (items.length === suggestions.items.length) {
		return suggestions;
	}
	return items.length === 0 ? null : { items, prefix: suggestions.prefix };
}

/**
 * 读取技能集合。运行时已经失效时（例如 `/reload` 期间仍有在途的补全请求，
 * `pi.getCommands()` 会抛 stale 错误）返回 undefined，让补全安静退化成无候选，
 * 而不是把异常抛进编辑器变成未处理的 Promise 拒绝。
 */
function readSkillsForCompletion(
	getSkills: () => ReadonlyMap<string, SkillEntry>,
): ReadonlyMap<string, SkillEntry> | undefined {
	try {
		return getSkills();
	} catch {
		return undefined;
	}
}

/**
 * 包装内置补全：行首的 `/` 完全交给 Pi（内置命令、别名、参数补全都不变），
 * 消息中间再输入 `/` 时只给技能候选。
 */
function createSkillCompletionProvider(
	base: AutocompleteProvider,
	deps: {
		getSkills: () => ReadonlyMap<string, SkillEntry>;
		isAliased: (skillName: string) => boolean;
	},
): AutocompleteProvider {
	return {
		...(base.triggerCharacters ? { triggerCharacters: base.triggerCharacters } : {}),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const token = cursorLine === 0 ? SLASH_TOKEN_AT_CURSOR.exec(textBeforeCursor) : null;
			const isMidTextToken =
				token !== null && textBeforeCursor.slice(0, token.index).trim().length > 0;
			if (token !== null && isMidTextToken) {
				// 行内 `/...` 只给技能候选：不是技能（路径、空白）就关掉菜单，不回退到路径补全。
				const name = skillNameFromToken(token[1]);
				if (name === undefined) {
					return null;
				}
				const skills = readSkillsForCompletion(deps.getSkills);
				if (skills === undefined) {
					return null;
				}
				const items = buildSkillSuggestions(skills, name);
				return items === undefined ? null : { items, prefix: token[1] };
			}
			// 行首 token 沿用 Pi 补全，只隐藏重复的 `skill:` 候选。
			const hideDuplicates = !/^\s*\/skill:/u.test(textBeforeCursor);
			return hideBuiltinSkillSuggestions(
				await base.getSuggestions(lines, cursorLine, cursorCol, options),
				(name) => hideDuplicates && deps.isAliased(name),
			);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			// 行内技能候选：`beforePrefix` 以 `/` 结尾且前面还有内容，前缀本身不含空白与 `/`。
			const isInlineSkill =
				beforePrefix.endsWith("/") &&
				beforePrefix.slice(0, -1).trim().length > 0 &&
				!/[\s/]/u.test(prefix);
			if (!isInlineSkill) {
				return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const afterCursor = currentLine.slice(cursorCol);
			const separator = /^\s/u.test(afterCursor) ? "" : " ";
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}${item.value}${separator}${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + separator.length,
			};
		},
		...(base.shouldTriggerFileCompletion
			? { shouldTriggerFileCompletion: base.shouldTriggerFileCompletion.bind(base) }
			: {}),
	};
}

/**
 * 从文本开头连续取出技能标记，支持 `/name` 与 `/skill:name` 混写。
 * 遇到非技能标记的 token 立即停止，剩余内容原样交给模型作为请求参数。
 */
function readLeadingSkillTokens(
	text: string,
	skills: ReadonlyMap<string, SkillEntry>,
): { skills: SkillEntry[]; rest: string } {
	const matched: SkillEntry[] = [];
	let rest = text.trimStart();
	for (;;) {
		const token = /^\/(\S+)(?:\s+|$)/.exec(rest);
		if (token === null) {
			break;
		}
		const word = token[1];
		const explicit = word.startsWith(SKILL_COMMAND_PREFIX);
		const name = explicit ? word.slice(SKILL_COMMAND_PREFIX.length) : word;
		// 裸别名让位于内置命令，显式 `/skill:name` 仍然按技能处理。
		if (!explicit && RESERVED_COMMAND_NAMES.has(name)) {
			break;
		}
		const skill = skills.get(name);
		if (skill === undefined) {
			break;
		}
		matched.push(skill);
		rest = rest.slice(token[0].length);
	}
	return { skills: matched, rest };
}

function renderSkillSection(skill: SkillEntry, index: number): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
	const reference = `References are relative to ${skill.baseDir}.`;
	if (index === 0) {
		return `${reference}\n\n${body}`;
	}
	// 额外技能放在同一块的正文里，折叠状态只显示首个技能名，展开后仍能逐段区分来源。
	const title = `# Also loaded skill: ${skill.name}`;
	return `---\n\n${title}\n\nSource: ${skill.filePath}\n${reference}\n\n${body}`;
}

function buildSkillBlock(skills: readonly SkillEntry[], args: string): string {
	const [primary] = skills;
	if (primary === undefined) {
		throw new Error("至少需要一个技能才能生成技能块");
	}
	const sections = skills.map((skill, index) => renderSkillSection(skill, index)).join("\n\n");
	// Pi 的 `parseSkillBlock` 只解析单个 `<skill>` 块，折叠视图也只显示 name，
	// 所以多技能时把所有技能名写进 name，避免看起来只加载了一个。单技能时与内置输出一致。
	const label = skills.map((skill) => skill.name).join(" + ");
	const block = `<skill name="${label}" location="${primary.filePath}">\n${sections}\n</skill>`;
	return args.length > 0 ? `${block}\n\n${args}` : block;
}

/** 合并技能、去重、读取内容并生成最终提示文本。 */
function composeExpansion(rawSkills: readonly SkillEntry[], rawArgs: string): Expansion {
	const unique: SkillEntry[] = [];
	const seen = new Set<string>();
	for (const skill of rawSkills) {
		if (seen.has(skill.name)) {
			continue;
		}
		seen.add(skill.name);
		unique.push(skill);
	}
	if (unique.length === 0) {
		return { kind: "failed", message: "没有匹配到可用的技能" };
	}
	try {
		return { kind: "expanded", text: buildSkillBlock(unique, rawArgs.trim()) };
	} catch (error) {
		return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 找出正文里的技能引用：非行首的 `/name`、`/skill:name` 只要精确命中已加载技能，同样算一次加载。
 *
 * 误伤边界：前置字符不能是字母、数字、`/` 或 `-`，所以路径（`/etc/hosts`、`src/tdd/x.md`）和
 * 未知命令都不会命中；命中后会把那个 `/`（及 `skill:` 前缀）去掉，让句子仍读得通。
 * 代价是“不要用 `/tdd`”这类否定句也会加载，目前靠一条提示让用户能立即发现。
 */
function extractInlineSkillTokens(
	text: string,
	skills: ReadonlyMap<string, SkillEntry>,
): { skills: SkillEntry[]; text: string } {
	const matched: SkillEntry[] = [];
	const rewritten = text.replace(
		/(^|[^\w/\\-])\/(?:skill:)?([A-Za-z0-9_-]+)/gu,
		(whole: string, prefix: string, name: string): string => {
			const skill = skills.get(name);
			if (skill === undefined) {
				return whole;
			}
			matched.push(skill);
			return `${prefix}${name}`;
		},
	);
	return { skills: matched, text: rewritten };
}

/** 正文里命中技能时告知用户加载了哪些，避免否定句等误伤被静默接受。 */
function notifyInlineSkills(
	ui: { notify: (message: string, level?: "info" | "warning" | "error") => void },
	skills: readonly SkillEntry[],
): void {
	if (skills.length === 0) {
		return;
	}
	ui.notify(`已按正文里的引用加载：${skills.map((skill) => `/${skill.name}`).join("、")}`, "info");
}

/** 能继续扩展行内技能标记的输入字符。 */
const SKILL_TOKEN_INPUT = /^[A-Za-z0-9_:/-]$/u;

/** 该查询是否能匹配到至少一个技能（编辑器据此决定要不要自动弹候选）。 */
function hasMatchingSkill(skills: ReadonlyMap<string, SkillEntry>, query: string): boolean {
	for (const name of skills.keys()) {
		if (scoreSkillName(name, query) !== undefined) {
			return true;
		}
	}
	return false;
}

/**
 * Pi 只在消息以 `/` 开头、或遇到 `@`/`#` 等触发字符时才自动弹出补全，
 * 正文中间的 `/token` 只能按 Tab 补全。这里在 `super.handleInput` 之后补一次触发，
 * 其余行为（键位、粘贴、撤销）完全沿用 CustomEditor。
 */
class SkillTokenEditor extends CustomEditor {
	readonly #matchesSkill: (query: string) => boolean;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		matchesSkill: (query: string) => boolean,
	) {
		super(tui, theme, keybindings);
		this.#matchesSkill = matchesSkill;
	}

	handleInput(data: string): void {
		super.handleInput(data);
		if (!SKILL_TOKEN_INPUT.test(data) || this.isShowingAutocomplete()) {
			return;
		}
		const { line, col } = this.getCursor();
		const textBeforeCursor = (this.getLines()[line] ?? "").slice(0, col);
		const token = SLASH_TOKEN_AT_CURSOR.exec(textBeforeCursor);
		const name = token === null ? undefined : skillNameFromToken(token[1]);
		// 至少两个字符才自动弹，避免打路径时菜单一闪而过；路径本身已被 skillNameFromToken 排除。
		if (name === undefined || name.length < 2 || !this.#matchesSkill(name)) {
			return;
		}
		// 触发方法未公开：缺失时静默跳过，退化成原来的“按 Tab 才补全”。
		const trigger = (this as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete;
		trigger?.call(this);
	}
}

/** 空闲时直接发送；流式执行中沿用 Pi 默认的 steer 排队方式。 */
function sendExpansion(pi: ExtensionAPI, ctx: ExtensionCommandContext, expansion: Expansion): void {
	switch (expansion.kind) {
		case "expanded":
			pi.sendUserMessage(expansion.text, ctx.isIdle() ? undefined : { deliverAs: "steer" });
			return;
		case "failed":
			ctx.ui.notify(`技能内容读取失败：${expansion.message}`, "error");
			return;
	}
}

/** 同一运行时内 `session_start` 可能触发多次，补全包装只挂一次。 */
let completionAttached = false;

/** 本扩展自己注册过的别名；`session_start` 再次触发时它们已经出现在 `getCommands()` 里。 */
const registeredAliases = new Set<string>();

export default function skillShortcuts(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const skills = collectSkills(pi);
		const taken = new Set(pi.getCommands().map((command) => command.name));
		const skipped: string[] = [];

		for (const skill of skills.values()) {
			const takenByOthers = taken.has(skill.name) && !registeredAliases.has(skill.name);
			if (RESERVED_COMMAND_NAMES.has(skill.name) || takenByOthers) {
				skipped.push(`/${skill.name}`);
				continue;
			}
			registeredAliases.add(skill.name);
			pi.registerCommand(skill.name, {
				description: skill.description,
				handler: async (args, commandCtx) => {
					// 会话切换或 /reload 后技能集合可能变化，这里重新读取以拿到最新路径。
					const currentSkills = collectSkills(pi);
					const primary = currentSkills.get(skill.name) ?? skill;
					const leading = readLeadingSkillTokens(args, currentSkills);
					const inline = extractInlineSkillTokens(leading.rest, currentSkills);
					notifyInlineSkills(commandCtx.ui, inline.skills);
					sendExpansion(
						pi,
						commandCtx,
						composeExpansion([primary, ...leading.skills, ...inline.skills], inline.text),
					);
				},
			});
		}

		if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === "function") {
			if (!completionAttached) {
				completionAttached = true;
				ctx.ui.addAutocompleteProvider((current) =>
					createSkillCompletionProvider(current, {
						getSkills: () => collectSkills(pi),
						isAliased: (name) => registeredAliases.has(name),
					}),
				);
			}
			if (skipped.length > 0) {
				ctx.ui.notify(`技能别名与已有命令冲突，已跳过：${skipped.join("、")}`, "warning");
			}
		}

		// 正文中间的 `/token` 要自动弹候选，只能靠编辑器子类；已有自定义编辑器时不抢占。
		if (ctx.hasUI && typeof ctx.ui.getEditorComponent === "function" && ctx.ui.getEditorComponent() === undefined) {
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) =>
					new SkillTokenEditor(tui, theme, keybindings, (query) => {
						const skills = readSkillsForCompletion(() => collectSkills(pi));
						return skills !== undefined && hasMatchingSkill(skills, query);
					}),
			);
		}
	});

	// 兜底：行首与正文里的技能引用统一走这里，即使别名未注册也能多技能展开。
	pi.on("input", (event, ctx): InputEventResult => {
		if (event.source === "extension") {
			return { action: "continue" };
		}
		if (!event.text.includes("/")) {
			return { action: "continue" };
		}
		const skills = collectSkills(pi);
		const leading = readLeadingSkillTokens(event.text, skills);
		const inline = extractInlineSkillTokens(leading.rest, skills);
		if (leading.skills.length === 0 && inline.skills.length === 0) {
			return { action: "continue" };
		}
		const expansion = composeExpansion([...leading.skills, ...inline.skills], inline.text);
		if (expansion.kind === "expanded") {
			notifyInlineSkills(ctx.ui, inline.skills);
			return { action: "transform", text: expansion.text };
		}
		// 读取失败时退回内置处理，由它给出自己的错误提示。
		return { action: "continue" };
	});
}

/** 供本地测试脚本使用，不参与 Pi 运行时。 */
export const __test = {
	RESERVED_COMMAND_NAMES,
	SLASH_TOKEN_AT_CURSOR,
	collectSkills,
	readLeadingSkillTokens,
	buildSkillBlock,
	composeExpansion,
	extractInlineSkillTokens,
	scoreSkillName,
	skillNameFromToken,
	buildSkillSuggestions,
	hideBuiltinSkillSuggestions,
	createSkillCompletionProvider,
};
