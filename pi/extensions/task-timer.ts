/**
 * 任务总时长
 *
 * 记录「用户消息触发 → pi 真正空闲」这段墙钟时间，显示在底部 footer 第一行开头：
 *
 * - 执行中：`⏱ Elapsed 42s ~/Downloads`，每秒刷新，能看到任务已经跑了多久。
 * - 结束后：`⏱ Took 1m 03s ~/Downloads`，留在 footer，直到下一次任务开始。
 *
 * 计时起点取 input 事件而不是 before_agent_start：pi 发消息前可能先做一次自动压缩，
 * 那段等待同样属于用户感知的任务时长，而 before_agent_start 在压缩之后才触发。
 * 斜杠命令可能被扩展直接处理、根本不启动任务，所以只记普通输入的提交时间；再配合
 * PROMPT_TIMESTAMP_TTL_MS，避免扩展注入的消息拿一个早已过期的输入时间当起点。
 *
 * 终点是 agent_settled 而不是 agent_end：重试、压缩重跑和排队中的后续工作会再开一轮 agent run，
 * agent_end 之后还可能继续，只有 agent_settled 才是真的没有自动续跑了。任务进行中追加的消息
 * （steer / followUp）并入当前任务，计时不中断。
 *
 * 按 Esc 中断同样会触发 agent_settled，此时终值标注 aborted，时长算到中断那一刻。
 *
 * messageType 为 user 的运行都算一次任务，包括扩展用 pi.sendUserMessage() 注入的消息。
 * 后者没有 input 事件，起点退化为运行开始时刻（受 PROMPT_TIMESTAMP_TTL_MS 保护，
 * 不会拿一条过期输入的时间凑数）。
 *
 * 显示位置：pi 把扩展状态固定放在 footer 最后单独一行。内容仍然走公开的 setStatus()，
 * 再由 installFooterRelocate() 把这一行搬到第一行开头，footer 保持两行。
 * 补丁只在「最后一行恰好是本次写入的状态文本」时搬移：终端太窄被截断、或有别的扩展也写了
 * 状态行时保持 pi 的原生布局，退化成独立一行。
 */

import { FooterComponent, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** 状态栏键名：固定不变，多次设置会覆盖同一个位置 */
const STATUS_KEY = "task-timer";

/** 执行中的刷新间隔，1 秒足够回答「已经跑了多久」 */
const TICK_MS = 1000;

/** 输入时间最多可信多久，超过说明这次运行不是由那条输入启动的 */
const PROMPT_TIMESTAMP_TTL_MS = 5 * 60 * 1000;

/** 最近一次写入状态栏的文本，footer 补丁按它认出自己那一行 */
const STATUS_STORE_KEY = Symbol.for("pi.task-timer.status");

/** footer 补丁登记表，放在全局以便 /reload 后的新实例认出上一个实例的包装函数 */
const PATCH_TABLE_KEY = Symbol.for("pi.task-timer.footer-patch");

function formatDuration(ms: number): string {
	// 时钟回拨时不让时长变成负数
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/**
 * 状态文本存在 globalThis 上而不是模块作用域：/reload 换掉的是模块实例，原型上可能还挂着
 * 上一个实例装的包装函数，它必须能读到当前实例写入的文本。
 */
function statusStore(): { text?: string } {
	const store = globalThis as unknown as Record<symbol, { text?: string } | undefined>;
	return (store[STATUS_STORE_KEY] ??= {});
}

type FooterRender = (width: number) => string[];

interface FooterPrototype {
	render: FooterRender;
}

interface FooterPatchTable {
	relocate?: { wrapper: FooterRender; original: FooterRender };
}

function patchTable(): FooterPatchTable {
	const store = globalThis as unknown as Record<symbol, FooterPatchTable | undefined>;
	return (store[PATCH_TABLE_KEY] ??= {});
}

/**
 * 把扩展状态行搬进 footer 第一行开头。
 *
 * 只改渲染结果，不动 footer 的状态、布局和鼠标坐标：footer 不接收点击，行数变化没有副作用。
 * 搬移条件是最后一行与本次写入的状态文本完全一致，这样别的扩展也写了状态、或终端太窄把
 * 文本截断时，保持 pi 的原生布局而不是把别人的内容一起搬走。
 */
function installFooterRelocate(): void {
	try {
		const prototype = FooterComponent.prototype as unknown as FooterPrototype;
		const table = patchTable();

		// /reload 后原型上还挂着上一个实例的包装函数：先剥回去，否则每 reload 一次就多一层
		const previous = table.relocate;
		if (previous !== undefined && prototype.render === previous.wrapper) {
			prototype.render = previous.original;
		}
		delete table.relocate;

		const original = prototype.render;
		prototype.render = function (this: unknown, width: number): string[] {
			const lines = original.call(this, width);
			const status = statusStore().text;
			// footer 固定输出 pwd 与统计两行，有状态行时至少三行；行数不对说明结构变了，不搬
			if (status === undefined || lines.length < 3) {
				return lines;
			}
			if (lines[lines.length - 1] !== status) {
				return lines;
			}
			lines[0] = truncateToWidth(`${status} ${lines[0]}`, width);
			lines.pop();
			return lines;
		};

		table.relocate = { wrapper: prototype.render, original };
	} catch {
		// 升级 pi 后 FooterComponent 结构变化时跳过，状态退回独立一行
	}
}

export default function (pi: ExtensionAPI) {
	installFooterRelocate();

	/** 当前任务起点；undefined 表示没有正在进行的任务 */
	let startedAt: number | undefined;
	/** 最近一次普通输入的提交时间，通常早于 before_agent_start */
	let promptSubmittedAt: number | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function stopTicker(): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	/** 回到「没有任务」的状态：会话切换和进程退出都走这里，不依赖两者的先后顺序 */
	function resetTask(): void {
		startedAt = undefined;
		promptSubmittedAt = undefined;
		stopTicker();
	}

	function publish(ctx: ExtensionContext, color: ThemeColor, text: string): void {
		if (!ctx.hasUI) {
			return;
		}
		// 先让状态栏拿到带颜色的文本，再让 footer 补丁按同一份文本把它搬到第一行
		const rendered = ctx.ui.theme.fg(color, text);
		statusStore().text = rendered;
		ctx.ui.setStatus(STATUS_KEY, rendered);
	}

	function clearStatus(ctx: ExtensionContext): void {
		statusStore().text = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function renderElapsed(ctx: ExtensionContext): void {
		if (startedAt === undefined) {
			return;
		}
		try {
			publish(ctx, "accent", `⏱ Elapsed ${formatDuration(Date.now() - startedAt)}`);
		} catch {
			// 会话切换或进程退出后旧 ctx 不再可用，继续 tick 只会重复抛错
			stopTicker();
		}
	}

	function startTask(ctx: ExtensionContext, startAt: number): void {
		startedAt = startAt;
		promptSubmittedAt = undefined;
		stopTicker();
		ticker = setInterval(() => renderElapsed(ctx), TICK_MS);
		// 计时器只负责刷新界面，不应阻止进程退出
		ticker.unref?.();
		renderElapsed(ctx);
	}

	function finishTask(ctx: ExtensionContext, aborted: boolean): void {
		if (startedAt === undefined) {
			return;
		}
		const durationMs = Date.now() - startedAt;
		startedAt = undefined;
		promptSubmittedAt = undefined;
		stopTicker();
		// 时长算到中断那一刻，不再随重绘漂移
		try {
			publish(ctx, aborted ? "warning" : "success", `⏱ Took ${formatDuration(durationMs)}${aborted ? " · aborted" : ""}`);
		} catch {
			// UI 已经销毁时只是少一次终值显示，不影响后续计时
		}
	}

	pi.on("input", async (event) => {
		// 任务进行中的输入会并入当前任务，不需要新的起点
		if (startedAt !== undefined) {
			return;
		}
		// 斜杠命令可能被扩展直接处理而不启动任务，记下来只会给下一次运行留下过期起点
		if (event.text.trimStart().startsWith("/")) {
			return;
		}
		promptSubmittedAt = Date.now();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// 扩展注入的 custom 消息不算任务；user 消息（含 sendUserMessage 注入）都算
		if (event.messageType !== "user") {
			return;
		}
		// 重试和续跑不会再走到这里，真遇到残留起点时保留它，不重置已进行的计时
		if (startedAt !== undefined) {
			return;
		}
		const submittedAt = promptSubmittedAt;
		const trusted = submittedAt !== undefined && Date.now() - submittedAt <= PROMPT_TIMESTAMP_TTL_MS;
		startTask(ctx, trusted ? submittedAt : Date.now());
	});

	pi.on("agent_settled", async (event, ctx) => {
		finishTask(ctx, event.aborted);
	});

	pi.on("session_start", async (_event, ctx) => {
		// 新会话没有「本次任务」：停表并清掉上一个会话留下的终值
		resetTask();
		clearStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		resetTask();
	});
}
