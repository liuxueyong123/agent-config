/**
 * 后台服务面板
 *
 * 解决的问题：agent 用 `nohup pnpm dev &` 一类命令起前端/后端服务后，pi 界面里没有任何痕迹，
 * 用户只能自己去 ps / lsof 找。会话结束时那些进程还会继续跑。
 *
 * 判定方式：不看命令怎么写，也不靠「谁新开了端口」，而是靠进程归属——扩展加载时往自己的
 * `process.env` 写一个本进程唯一的随机标记，之后由 pi 的 bash 工具启动的子进程都会继承它。
 * 轮询监听列表后，用 `ps eww` 回读每个新出现进程的环境，只有带这个标记的才算「当前 agent 起的」，
 * 再连同端口、命令行、运行时长显示在编辑器上方。这样 `pnpm dev`、`next dev`、`uvicorn` 都能抓到，
 * 而你自己在别的终端或应用里起的服务不会被列进来。
 *
 * 已知局限：
 * - 只跟踪 TCP 监听端口。不监听端口的后台任务（nohup 跑构建、后台 tail 日志）不会出现在面板里。
 * - 归属靠环境变量继承。命令主动清理环境（`env -i`、部分服务的 daemon 化）或端口由常驻守护进程
 *   代理时（`docker run -p` 的监听者是 Docker 守护进程）判定不到，这些服务不会显示。
 * - 运行时长是「首次被本扩展看到」至今，不是进程真实启动时长，误差上限一个采样周期。
 * - 面板只读，不做 kill。停服务仍然要自己 kill；面板给出 pid 就是为了这个。
 *
 * 成本：每轮采样 fork 一个 lsof。macOS 上实测约 40ms CPU（14k 个打开文件描述符时），且随全机
 * 打开文件数线性增长；因此采样间隔按活跃度分三档，避免长期满速扫描。ps 与归属判定只在发现
 * 新 pid 时调用，之后命令行、首见时间与归属都走缓存，运行时长本地计算。
 *
 * 采样节奏：agent 忙碌或已有服务在列时 5 秒；最近 3 分钟有过活动 20 秒；更久空闲 60 秒。
 * turn_end / agent_settled 各额外采样一次，让「刚起完服务」的结果立刻出现。
 *
 * 依赖 macOS 自带的 `lsof` 与 `ps`（`ps eww` 读环境）。采样失败时保留上一轮结果，不清空面板。
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";

/** 面板键名：固定不变，重复 setWidget 会覆盖同一个位置 */
const WIDGET_KEY = "service-watch";

/** agent 忙碌、或已有服务在列时的采样间隔 */
const POLL_BUSY_MS = 5_000;

/** agent 停下不久时的采样间隔：dev server 常在 agent 结束之后才绑上端口 */
const POLL_RECENT_MS = 20_000;

/** 长时间空闲后的采样间隔 */
const POLL_IDLE_MS = 60_000;

/** 上一次 agent 活动距今多久之内算「最近」 */
const RECENT_WINDOW_MS = 3 * 60_000;

/** 距上一次采样不足这个时间就跳过 turn_end 触发的补采，避免短时间内重复 fork */
const SAMPLE_DEBOUNCE_MS = 1_000;

/** 面板最多显示几行，超出部分折叠成一行提示 */
const MAX_ROWS = 4;

/** 面板行里短命令的字符上限：再长就会挤掉右边的运行时长和 pid */
const MAX_SHORT_COMMAND = 48;

/** lsof 在进程表很大时会变慢，超时就当作本轮采样失败，下个周期重试 */
const LSOF_TIMEOUT_MS = 4_000;

const PS_TIMEOUT_MS = 3_000;

/** 调试日志最多写多少行，避免开着开关跑一整天写出几十 MB */
const DEBUG_MAX_LINES = 5_000;

/** 设置为文件路径后，每次采样把结果追加进去，便于在没有 TUI 的场景下核对判定逻辑 */
const DEBUG_PATH = process.env.SERVICE_WATCH_DEBUG;

/**
 * 归属标记的环境变量名。扩展加载时把值写进 process.env，之后 pi 通过 bash 工具启动的所有
 * 子进程都会继承；采样时回读进程环境，带这个值才算当前 agent 起的服务。
 */
const MARKER_ENV = "PI_SERVICE_WATCH_MARKER";

/**
 * 跨 /reload 保留的状态。/reload 换掉的是模块实例，闭包变量会跟着丢；基线一丢，新实例就会把
 * agent 已经起的服务重新算进基线，面板静默清空。放在 globalThis 上才能延续。
 */
const SHARED_STATE_KEY = Symbol.for("pi.service-watch.state");

const execFileAsync = promisify(execFile);

/** 一个监听进程和它占用的端口 */
interface Listener {
	pid: number;
	ports: number[];
}

/** 面板上的一行：监听进程 + 命令行与运行时长 */
interface ServiceRow extends Listener {
	command: string;
	elapsed: string;
}

/** 首次发现某个 pid 时记下它的命令行与归属，之后只本地累加运行时长 */
interface ProcessMemo {
	command: string;
	firstSeenAt: number;
	/** 环境里带着本进程标记：这个监听进程是当前 agent 起的 */
	owned: boolean;
}

interface SharedState {
	/** 本 pi 进程的归属标记，跨 /reload 保持不变，否则已起的服务会突然不再归属 */
	marker?: string;
	/** pid → 命令行、首见时间与归属。跟着标记一起跨 /reload 保留，否则运行时长会重新计数 */
	memo?: Map<number, ProcessMemo>;
}

function sharedState(): SharedState {
	const store = globalThis as unknown as Record<symbol, SharedState | undefined>;
	return (store[SHARED_STATE_KEY] ??= {});
}

/**
 * 取（必要时生成）本 pi 进程的归属标记并写进环境变量。
 *
 * 标记跟着 pi 进程而不是模块实例：/reload 后新实例用同一值，已起的服务不会突然不再归属。
 * 写进 process.env 的时机是扩展加载，早于任何工具调用，所以后面启动的子进程都能继承。
 */
function ensureMarker(): string {
	const state = sharedState();
	state.marker ??= randomUUID();
	process.env[MARKER_ENV] = state.marker;
	return state.marker;
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` 的输出。
 *
 * 字段行格式是一个字母加内容：`p<pid>`、`c<命令名>`、`f<fd>`、`n<地址>`，同一个 pid 会先出现
 * 一次 `p`，随后是若干组 `f`/`n`。这里只关心 pid 与地址，命令名交给 ps（lsof 会截断它）。
 */
export function parseLsofListeners(stdout: string): Listener[] {
	const portsByPid = new Map<number, Set<number>>();
	let currentPid: number | undefined;

	for (const line of stdout.split("\n")) {
		if (line === "") {
			continue;
		}
		const tag = line[0];
		const value = line.slice(1);
		if (tag === "p") {
			const pid = Number(value);
			currentPid = Number.isInteger(pid) && pid > 0 ? pid : undefined;
			continue;
		}
		if (tag !== "n" || currentPid === undefined) {
			continue;
		}
		const port = parsePort(value);
		if (port === undefined) {
			continue;
		}
		const ports = portsByPid.get(currentPid) ?? new Set<number>();
		ports.add(port);
		portsByPid.set(currentPid, ports);
	}

	return [...portsByPid].map(([pid, ports]) => ({ pid, ports: [...ports].sort((a, b) => a - b) }));
}

/** 从 `*:3000`、`127.0.0.1:5173`、`[::1]:8787` 这类地址里取端口 */
function parsePort(address: string): number | undefined {
	const separator = address.lastIndexOf(":");
	if (separator < 0) {
		return undefined;
	}
	const port = Number(address.slice(separator + 1));
	return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** 解析 `ps -p … -o pid=,command=` 的输出，返回 pid → 完整命令行 */
export function parsePsRows(stdout: string): Map<number, string> {
	const rows = new Map<number, string>();
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
		if (match === null) {
			continue;
		}
		rows.set(Number(match[1]), match[2]);
	}
	return rows;
}

/** stdout 在失败时也常常有内容（lsof 找不到匹配项就走退出码 1），两条路径都按同样的方式解析 */
function stdoutOf(error: unknown): string {
	if (typeof error === "object" && error !== null && "stdout" in error) {
		const stdout = (error as { stdout?: unknown }).stdout;
		if (typeof stdout === "string") {
			return stdout;
		}
	}
	return "";
}

/**
 * 采一次监听列表。
 *
 * 返回 `undefined` 表示本轮采样无效（lsof 不可用、超时、输出溢出），调用方必须保留上一轮结果；
 * 返回 `[]` 表示采样成功但系统里确实没有监听端口——包括 lsof「没有匹配项」时以退出码 1 结束的
 * 情况，那仍然是一次完整扫描。两种情况混为一谈会让基线在首轮失败时被钉成空集。
 */
async function readListeners(): Promise<Listener[] | undefined> {
	try {
		const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
			timeout: LSOF_TIMEOUT_MS,
			maxBuffer: 8 * 1024 * 1024,
		});
		return parseLsofListeners(stdout);
	} catch (error) {
		// 数字 code 是子进程退出码：lsof 跑完了，输出可信（无匹配项时为空）
		const code = (error as { code?: unknown }).code;
		return typeof code === "number" ? parseLsofListeners(stdoutOf(error)) : undefined;
	}
}

async function readProcessInfo(pids: number[]): Promise<Map<number, string>> {
	if (pids.length === 0) {
		return new Map();
	}
	try {
		const { stdout } = await execFileAsync("ps", ["-p", pids.join(","), "-o", "pid=,command="], {
			timeout: PS_TIMEOUT_MS,
			maxBuffer: 2 * 1024 * 1024,
		});
		return parsePsRows(stdout);
	} catch {
		// 只影响这一行的信息完整度：端口仍然显示，命令行等下一轮补
		return new Map();
	}
}

/**
 * 回读这些 pid 的环境，判断哪些带着本 pi 进程的标记。
 *
 * `ps eww` 把环境变量接在命令行后面输出，所以这里不能用它取显示用的命令行（会带着整份环境），
 * 只用来判定归属；标记是 UUID，不会与别的参数撞字符串。读不到环境（权限、进程已退出）时
 * 一律当作不属于当前 agent：宁可少报，也不把别人的服务列进来。
 */
async function readOwnership(pids: number[], marker: string): Promise<Map<number, boolean>> {
	const owned = new Map<number, boolean>();
	if (pids.length === 0) {
		return owned;
	}
	const needle = `${MARKER_ENV}=${marker}`;
	try {
		const { stdout } = await execFileAsync("ps", ["eww", "-p", pids.join(","), "-o", "pid=,command="], {
			timeout: PS_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		for (const line of stdout.split("\n")) {
			const match = /^\s*(\d+)\s/.exec(line);
			if (match === null) {
				continue;
			}
			owned.set(Number(match[1]), line.includes(needle));
		}
	} catch {
		// 读不到就当作都不属于本 agent
	}
	return owned;
}

/**
 * 面板行里的短命令：取可执行文件与最多两个非开关参数，路径只留 basename，再按字符上限截断。
 * 完整命令行留在 /services 里，面板这一行负责快速认出「这是哪个服务」。
 */
export function shortCommand(command: string): string {
	const parts = command.trim().split(/\s+/).filter((part) => part !== "");
	if (parts.length === 0) {
		return "";
	}
	const head = basename(parts[0] ?? "");
	const rest = parts
		.slice(1)
		// 跳过开关和 `3000:3000` 这类端口映射，否则 `docker run -p 3000:3000 img` 会把镜像名挤掉
		.filter((part) => !part.startsWith("-") && !/^\d+(?::\d+)?$/.test(part))
		.slice(0, 2)
		.map((part) => basename(part));
	const short = [head, ...rest].join(" ");
	return short.length > MAX_SHORT_COMMAND ? `${short.slice(0, MAX_SHORT_COMMAND - 1)}…` : short;
}

/** 运行时长：本地累加，不依赖 ps 的 etime，因此每轮采样不需要再 fork 一次 ps */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
	}
	return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`;
}

function formatPorts(ports: number[]): string {
	return ports.map((port) => `:${port}`).join(", ");
}

/**
 * 面板的纯渲染：给定服务列表与宽度，返回要显示的终端行。
 *
 * 与组件生命周期分开，既能单独核对排版，也让组件本身只负责转发宽度和主题。
 */
export function formatWidgetLines(rows: ServiceRow[], theme: Theme, width: number): string[] {
	if (rows.length === 0) {
		return [];
	}
	const fit = (line: string): string => truncateToWidth(line, width, "…");
	const lines = [fit(`${theme.fg("accent", "●")} ${theme.fg("accent", `Services (${rows.length})`)}`)];

	const shown = rows.slice(0, MAX_ROWS);
	shown.forEach((row, index) => {
		const isLast = index === shown.length - 1 && rows.length <= MAX_ROWS;
		const command = shortCommand(row.command);
		const meta = [row.elapsed === "" ? "" : row.elapsed, `pid ${row.pid}`].filter((part) => part !== "").join(" · ");
		lines.push(
			fit(
				`${theme.fg("dim", isLast ? "└─" : "├─")} ${theme.fg("accent", formatPorts(row.ports))}` +
					`${command === "" ? "" : `  ${theme.fg("text", command)}`}  ${theme.fg("dim", meta)}`,
			),
		);
	});

	if (rows.length > MAX_ROWS) {
		lines.push(fit(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${rows.length - MAX_ROWS} more · /services 查看全部`)}`));
	}
	// 与其它自绘面板一致：末尾留一个空行，避免和编辑器贴在一起
	lines.push("");
	return lines;
}

export default function (pi: ExtensionAPI) {
	// 必须在任何工具调用之前写入环境标记，后续子进程才能继承
	const marker = ensureMarker();

	let uiCtx: ExtensionUIContext | undefined;
	let tui: TUI | undefined;
	let widgetRegistered = false;
	/** 接管面板的会话 id；子会话（subagent）与它不同，不会抢面板 */
	let foregroundSid: string | undefined;
	let rows: ServiceRow[] = [];
	/** pid → 命令行与首见时间，只对新出现的 pid 调用 ps；跟着基线跨 /reload 保留 */
	const processMemo = (sharedState().memo ??= new Map<number, ProcessMemo>());
	/** 上一次渲染的内容指纹，内容没变化就不打扰 TUI */
	let fingerprint = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let polling = false;
	/** 采样期间又被要求采样时置位，本轮结束后补跑一次 */
	let pending = false;
	let busy = false;
	let lastSampleAt = 0;
	let lastActivityAt = Date.now();
	let debugLines = 0;

	function markActivity(): void {
		lastActivityAt = Date.now();
	}

	function rowOf(listener: Listener, now: number): ServiceRow {
		const memo = processMemo.get(listener.pid);
		return {
			pid: listener.pid,
			ports: listener.ports,
			command: memo?.command ?? "",
			elapsed: memo === undefined ? "" : formatElapsed(now - memo.firstSeenAt),
		};
	}

	function publish(): void {
		const next = JSON.stringify(rows);
		if (next === fingerprint) {
			return;
		}
		fingerprint = next;

		if (uiCtx === undefined) {
			return;
		}
		if (rows.length === 0) {
			if (widgetRegistered) {
				uiCtx.setWidget(WIDGET_KEY, undefined);
				widgetRegistered = false;
				tui = undefined;
			}
			return;
		}
		if (!widgetRegistered) {
			uiCtx.setWidget(
				WIDGET_KEY,
				(hostTui, factoryTheme) => {
					tui = hostTui;
					return {
						render: (width: number) => formatWidgetLines(rows, uiCtx?.theme ?? factoryTheme, width),
						invalidate: () => {
							// 没有缓存渲染结果，主题变化后下一次 render 直接读 uiCtx.theme
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
			return;
		}
		tui?.requestRender();
	}

	function debugLog(listeners: number): void {
		if (DEBUG_PATH === undefined || debugLines >= DEBUG_MAX_LINES) {
			return;
		}
		debugLines++;
		const line = `${JSON.stringify({
			at: new Date().toISOString(),
			listeners,
			shown: rows.length,
			rows,
		})}\n`;
		// 异步写：调试输出不能阻塞事件循环
		appendFile(DEBUG_PATH, line, () => undefined);
	}

	async function sample(): Promise<void> {
		if (polling) {
			pending = true;
			return;
		}
		polling = true;
		try {
			const listeners = await readListeners();
			if (listeners === undefined) {
				// 本轮无效：保留上一轮结果
				return;
			}

			// 只对没见过的 pid 判一次归属与命令行，之后走缓存
			const unknown = listeners.filter((listener) => !processMemo.has(listener.pid)).map((listener) => listener.pid);
			if (unknown.length > 0) {
				const [commandByPid, ownedByPid] = await Promise.all([
					readProcessInfo(unknown),
					readOwnership(unknown, marker),
				]);
				const seenAt = Date.now();
				for (const pid of unknown) {
					processMemo.set(pid, {
						command: commandByPid.get(pid) ?? "",
						firstSeenAt: seenAt,
						owned: ownedByPid.get(pid) ?? false,
					});
				}
			}

			// 已经退出的进程不再占缓存
			for (const pid of processMemo.keys()) {
				if (!listeners.some((listener) => listener.pid === pid)) {
					processMemo.delete(pid);
				}
			}

			const now = Date.now();
			rows = listeners
				.filter((listener) => processMemo.get(listener.pid)?.owned === true)
				.map((listener) => rowOf(listener, now))
				.sort((a, b) => (a.ports[0] ?? 0) - (b.ports[0] ?? 0) || a.pid - b.pid);
			debugLog(listeners.length);
			publish();
		} catch {
			// 采样异常只跳过这一轮，不让面板影响主流程
		} finally {
			polling = false;
			lastSampleAt = Date.now();
			if (pending) {
				pending = false;
				void sample();
			}
		}
	}

	function delay(): number {
		if (busy || rows.length > 0) {
			return POLL_BUSY_MS;
		}
		return Date.now() - lastActivityAt < RECENT_WINDOW_MS ? POLL_RECENT_MS : POLL_IDLE_MS;
	}

	function schedule(): void {
		if (timer !== undefined) {
			return;
		}
		timer = setTimeout(() => {
			timer = undefined;
			void sample().finally(() => schedule());
		}, delay());
		timer.unref?.();
	}

	/** 节奏变化时（agent 开始忙）立刻换成更短的间隔 */
	function reschedule(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		schedule();
	}

	function resetPanel(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (uiCtx !== undefined && widgetRegistered) {
			try {
				uiCtx.setWidget(WIDGET_KEY, undefined);
			} catch {
				// reload / 关闭会话时 ui 代理可能已失效，面板随窗口一起消失即可
			}
		}
		uiCtx = undefined;
		tui = undefined;
		widgetRegistered = false;
		rows = [];
		fingerprint = "";
	}

	pi.on("session_start", async (_event, ctx) => {
		let id: string;
		try {
			id = ctx.sessionManager.getSessionId() ?? "";
		} catch {
			// 会话已换代，拿不到 id 就没有可绑定的面板
			return;
		}
		// 第一个会话（交互式启动的那个）接管面板；子会话不抢
		if (foregroundSid === undefined) {
			foregroundSid = id;
		}
		if (id !== foregroundSid) {
			return;
		}
		// ui 换代（/reload、新会话）后必须重新注册，否则会往旧的 ui 上写
		if (ctx.hasUI) {
			uiCtx = ctx.ui;
			widgetRegistered = false;
			tui = undefined;
			fingerprint = "";
		}
		markActivity();
		void sample().finally(() => schedule());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		let id: string;
		try {
			id = ctx.sessionManager.getSessionId() ?? "";
		} catch {
			// 关闭时 ctx 已失效：按前台会话处理，清干净即可
			id = "";
		}
		if (id !== "" && id !== foregroundSid) {
			return;
		}
		try {
			resetPanel();
		} finally {
			foregroundSid = undefined;
		}
	});

	pi.on("agent_start", async () => {
		markActivity();
		busy = true;
		reschedule();
	});

	pi.on("agent_settled", async () => {
		markActivity();
		busy = false;
		// dev server 常在 agent 结束后才绑上端口，这里补采一次，不等下一个空闲周期
		void sample();
	});

	// 一轮响应结束后立刻采样：服务多半就是在这轮里起来的。不 await，避免把事件处理拖到 lsof 超时。
	pi.on("turn_end", async () => {
		markActivity();
		if (Date.now() - lastSampleAt < SAMPLE_DEBOUNCE_MS) {
			return;
		}
		void sample();
	});

	pi.registerCommand("services", {
		description: "列出当前 agent 起的监听服务（只读）",
		handler: async (_args, ctx) => {
			await sample();
			if (rows.length === 0) {
				ctx.ui.notify(
					"没有检测到当前 agent 起的监听服务。只跟踪本 pi 进程启动、环境里带归属标记的 TCP 监听端口。",
					"info",
				);
				return;
			}
			const lines = [`${rows.length} 个监听服务（只读，停止请自行 kill）`];
			for (const row of rows) {
				lines.push(`${formatPorts(row.ports)}  pid ${row.pid}  ${row.elapsed}`);
				if (row.command !== "") {
					lines.push(`  ${row.command}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
