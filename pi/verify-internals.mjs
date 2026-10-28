#!/usr/bin/env node
/**
 * 校验 tool-preview-lines 扩展依赖的 pi 内部特性。
 *
 * 扩展为了把工具调用压成一行，用到了几处未写入扩展 API 文档的细节：
 * renderShell: "self" 的渲染路径、ToolExecutionComponent 的前导空行、
 * 以及扩展与宿主共享同一个包实例。升级 pi 后跑一次本脚本，就能知道
 * 这些前提是否还成立。
 *
 * 用法：
 *   node pi/verify-internals.mjs
 *   node pi/verify-internals.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
 *   PI_PACKAGE_DIR=/path/to/pi-coding-agent node pi/verify-internals.mjs
 *
 * 退出码：0 全部通过，1 有失败项。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "extensions", "tool-preview-lines.ts");
const PACKAGE_NAMES = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"];
const TOOLS = ["bash", "grep", "ls", "find", "write", "edit"];
const REQUIRED_EXPORTS = [
  "ToolExecutionComponent",
  "DEFAULT_MAX_BYTES",
  "formatSize",
  "getLanguageFromPath",
  "highlightCode",
  "initTheme",
  "keyHint",
  "renderDiff",
];

const results = [];

async function record(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail: message });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function locatePackageDir() {
  const explicit = process.argv[2] ?? process.env.PI_PACKAGE_DIR;
  if (explicit) {
    const directory = resolve(explicit);
    if (!existsSync(join(directory, "package.json"))) {
      throw new Error(`指定的目录不是 pi 包：${directory}`);
    }
    return directory;
  }
  const candidates = [];
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    for (const name of PACKAGE_NAMES) {
      candidates.push(join(root, name));
    }
  } catch {
    // 没有 npm 时继续尝试其他线索
  }
  try {
    const binary = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    candidates.push(resolve(dirname(realpathSync(binary)), ".."));
  } catch {
    // pi 不在 PATH 时忽略
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }
  throw new Error("找不到 pi 包，请传入包目录或设置 PI_PACKAGE_DIR");
}

let packageDir;
try {
  packageDir = locatePackageDir();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const pi = await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
const requireFromPi = createRequire(join(packageDir, "dist", "index.js"));
const tuiEntry = requireFromPi.resolve("@earendil-works/pi-tui");
const { createJiti } = requireFromPi("jiti");

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(packageDir, "dist", "index.js"),
    "@earendil-works/pi-tui": tuiEntry,
  },
});

await record("pi 包版本可读", () => `${manifest.name}@${manifest.version}`);

await record("必需导出存在", () => {
  const missing = REQUIRED_EXPORTS.filter((name) => !(name in pi));
  assert(missing.length === 0, `缺少导出：${missing.join(", ")}`);
  return REQUIRED_EXPORTS.join(", ");
});

// keyHint 与 renderDiff 都依赖全局主题，必须先初始化，否则扩展渲染会抛错。
try {
  pi.initTheme();
} catch (error) {
  console.error(`初始化主题失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let resolver;
const loadedExtension = await jiti.import(EXTENSION, { default: true });
const extensionFactory = loadedExtension.default ?? loadedExtension;

const commands = new Map();
const commandApi = {
  on() {},
  registerCommand(name, definition) {
    commands.set(name, definition);
  },
  registerToolRenderer(fn) {
    resolver = fn;
  },
};
extensionFactory(commandApi);

// 命令处理器的输出不需要真实 UI，这里只记录调用
const notifications = [];
const commandContext = {
  ui: {
    notify(text, level) {
      notifications.push({ text, level });
    },
  },
};

async function runCommand(name, args) {
  const definition = commands.get(name);
  assert(definition !== undefined, `没有注册 /${name}`);
  await definition.handler(args ?? "", commandContext);
}

/** 补丁登记表由扩展写在 globalThis 上，这里按同一个 symbol 读回来 */
const patchTable = () => globalThis[Symbol.for("pi.tool-lines.patches")];

const tui = await import(pathToFileURL(tuiEntry).href);

function makeTool(name, args, text, { partial = false, error = false } = {}) {
  const base = name === "bash" ? pi.createBashToolDefinition(process.cwd()) : pi.createReadToolDefinition(process.cwd());
  const renderers = resolver(name, () => base);
  const component = new pi.ToolExecutionComponent(
    name,
    `verify-${name}-${Math.random()}`,
    args,
    {},
    { ...base, ...renderers },
    { requestRender() {} },
    process.cwd(),
  );
  if (partial) {
    component.markExecutionStarted();
  }
  component.updateResult({ content: [{ type: "text", text }], details: {}, isError: error }, partial);
  return component;
}

const stripAnsi = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

await record("扩展加载并注册渲染器", () => {
  assert(typeof resolver === "function", "registerToolRenderer 未被调用");
  return "registerToolRenderer";
});

await record("扩展使用默认卡片外壳", () => {
  const wrong = TOOLS.filter((name) => {
    const shell = resolver(name, () => undefined)?.renderShell;
    return shell !== undefined && shell !== "default";
  });
  assert(wrong.length === 0, `这些工具没有走默认外壳：${wrong.join(", ")}`);
  return "default";
});

await record("ToolExecutionComponent 与宿主是同一个类", () => {
  const entry = patchTable()?.compactRows;
  assert(entry !== undefined, "登记表里没有折叠补丁，扩展可能加载了另一份包实例");
  assert(
    pi.ToolExecutionComponent.prototype.updateDisplay === entry.wrapper,
    "宿主原型上没有本扩展的包装函数，patch 可能没生效",
  );
  return "wrapper 已在宿主原型上";
});

await record("独立工具保留块前空行，组内成员压到 0", () => {
  const solo = makeTool("bash", { command: "solo" }, "1\n");
  const soloRows = solo.render(80).map(stripAnsi);
  assert(soloRows.length === 2 && soloRows[0] === "", `独立工具应保留一行空行：${JSON.stringify(soloRows)}`);

  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const group = chat.children[0];
  group.handleMouse({
    type: "click",
    button: "left",
    x: 1,
    y: 0,
    width: 80,
    height: 2,
    screenX: 1,
    screenY: 0,
    shift: false,
    ctrl: false,
    alt: false,
  });
  const groupRows = chat.render(80).map(stripAnsi);
  assert(groupRows[0] === "" && groupRows[1].includes("tool"), `组头布局不对：${JSON.stringify(groupRows)}`);
  assert(
    groupRows.slice(2).every((line) => line !== ""),
    `组内成员之间出现了空行：${JSON.stringify(groupRows)}`,
  );
  return "独立 1 行空行，组内 0";
});

await record("连续工具合并为一个折叠组", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  assert(chat.children.length === 1, `预期只剩一个组，实际 ${chat.children.length} 项`);
  assert(chat.children[0].constructor.name === "ToolGroup", `实际类型 ${chat.children[0].constructor.name}`);
  const rows = chat.render(80).map(stripAnsi);
  const visible = rows.filter((line) => line !== "");
  assert(visible.length === 1 && visible[0].includes("2 tool calls"), `摘要不对：${JSON.stringify(rows)}`);
  assert(rows.length === 2 && rows[0] === "", `组前应保留一行空行：${JSON.stringify(rows)}`);
  return "2 tool calls，空行 + 摘要";
});

await record("单个工具也建组", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "solo" }, "1\n"));
  assert(chat.children[0].constructor.name === "ToolGroup", `实际类型 ${chat.children[0].constructor.name}`);
  const rows = chat.render(80).map(stripAnsi);
  assert(rows.length === 2 && rows[1].includes("1 tool call"), `单工具摘要不对：${JSON.stringify(rows)}`);
  return "1 tool call，与多工具外观一致";
});

await record("插入文本后另开一组", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(new tui.Text("assistant", 0, 0));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const names = chat.children.map((child) => child.constructor.name);
  assert(
    names.join(",") === "ToolGroup,Text,ToolGroup",
    `组边界不对：${names.join(",")}`,
  );
  return "文本断开两组";
});

// 模拟 pi 的 AssistantMessageComponent：只读 lastMessage，空内容渲染为空行数
class AssistantMessageComponent {
  constructor(message) {
    this.lastMessage = message;
  }
  render() {
    return [];
  }
  invalidate() {}
}

await record("只含 toolCall 的 assistant 组件不断开组", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(new AssistantMessageComponent({ content: [{ type: "toolCall", id: "x" }] }));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  assert(chat.children.length === 1, `预期只剩一个组，实际 ${chat.children.length} 项`);
  assert(chat.children[0].constructor.name === "ToolGroup", `实际类型 ${chat.children[0].constructor.name}`);
  const rows = chat.render(80).map(stripAnsi).filter((line) => line !== "");
  assert(rows.length === 1 && rows[0].includes("2 tool calls"), `摘要不对：${JSON.stringify(rows)}`);
  return "跨过不可见 assistant 合并";
});

await record("含文本的 assistant 组件仍断开组", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(new AssistantMessageComponent({ content: [{ type: "text", text: "说明" }] }));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const names = chat.children.map((child) => child.constructor.name);
  assert(
    names.join(",") === "ToolGroup,AssistantMessageComponent,ToolGroup",
    `有文本时不应合并：${names.join(",")}`,
  );
  return "文本保留断组";
});

await record("内容尚未开始的 assistant 组件不被清掉", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(new AssistantMessageComponent({ content: [] }));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const names = chat.children.map((child) => child.constructor.name);
  assert(
    names.join(",") === "ToolGroup,AssistantMessageComponent,ToolGroup",
    `流式开始的消息被误删：${names.join(",")}`,
  );
  return "空内容保留";
});

await record("点击折叠摘要展开组", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const group = chat.children[0];
  const event = {
    type: "click",
    button: "left",
    x: 1,
    y: 0,
    width: 80,
    height: 1,
    screenX: 1,
    screenY: 0,
    shift: false,
    ctrl: false,
    alt: false,
  };
  const result = group.handleMouse(event);
  assert(result?.handled === true, "点击摘要没有返回 handled");
  const rows = chat.render(80).map(stripAnsi).filter((line) => line !== "");
  assert(rows.length === 3, `展开后应有摘要 + 2 个工具行，实际 ${JSON.stringify(rows)}`);
  assert(rows[0].includes("click to collapse"), `展开后的摘要应提示可收起：${rows[0]}`);

  // 再点一次标题行应收起
  const collapse = group.handleMouse({ ...event, y: 1, height: rows.length });
  assert(collapse?.handled === true, "再次点击没有返回 handled");
  const after = chat.render(80).map(stripAnsi).filter((line) => line !== "");
  assert(after.length === 1 && after[0].includes("click to expand"), `没有收起来：${JSON.stringify(after)}`);
  return "展开 3 行，可再收起";
});

await record("展开参数里的控制字符被清除", () => {
  const component = makeTool("grep", { pattern: "evil\u0007bell", path: "." }, "hit\n");
  component.setExpanded(true);
  const joined = component.render(120).join("\n");
  assert(!joined.includes("\u0007"), "BEL 逃过了 sanitize");
  return "BEL 已清除";
});

await record("展开后仍显示耗时并停止计时器", () => {
  const component = makeTool("bash", { command: "sleep 1" }, "out\n", { partial: true });
  // 先折叠渲染一次，启动计时器
  component.render(80);
  component.setExpanded(true);
  const expanded = stripAnsi(component.render(80).join("\n"));
  assert(expanded.includes("Elapsed"), `展开态应显示耗时：${expanded}`);

  component.updateResult({ content: [{ type: "text", text: "done\n" }], details: {}, isError: false }, false);
  component.render(80);
  assert(component.rendererState.interval === undefined, "工具结束后计时器没有停止");
  return "Elapsed 可见，interval 已清理";
});

await record("组摘要反映运行与失败", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "long" }, "x\n", { partial: true }));
  chat.addChild(makeTool("bash", { command: "bad" }, "boom\n", { error: true }));
  const text = chat.render(80).map(stripAnsi).join("");
  assert(text.includes("running"), `缺少 running：${text}`);
  assert(text.includes("1 failed"), `缺少 failed：${text}`);
  return text.trim();
});

await record("折叠时卡片纵向内边距归零", () => {
  const prototype = pi.ToolExecutionComponent.prototype;
  for (const [expanded, expected] of [
    [false, 0],
    [true, 1],
  ]) {
    const fake = Object.create(prototype);
    Object.assign(fake, {
      expanded,
      children: [],
      contentBox: {
        paddingY: expanded ? 0 : 1,
        invalidateCache() {},
      },
    });
    try {
      prototype.updateDisplay.call(fake);
    } catch {
      // 真实的 updateDisplay 依赖完整实例字段，这里只关心 patch 先改掉的 paddingY
    }
    assert(
      fake.contentBox.paddingY === expected,
      `expanded=${expanded} 时 paddingY 预期 ${expected}，实际 ${fake.contentBox.paddingY}`,
    );
  }
  return "折叠 0 / 展开 1";
});

await record("Text 仍会补齐到整宽（PlainText 的存在理由）", async () => {
  const tui = await import(pathToFileURL(tuiEntry).href);
  const line = new tui.Text("abc", 0, 0).render(20)[0];
  assert(line.length === 20, `预期补齐到 20 列，实际 ${line.length} 列`);
  return "20 列";
});

const theme = { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => `<b>${text}</b>` };
const makeContext = () => ({
  expanded: false,
  isPartial: false,
  isError: false,
  state: {},
  invalidate() {},
});

await record("折叠时调用行 1 行、结果区 0 行", async () => {
  const problems = [];
  for (const name of TOOLS) {
    const renderers = resolver(name, () => undefined);
    const context = makeContext();
    const args =
      name === "bash"
        ? { command: "echo hi" }
        : name === "write"
          ? { file_path: "a.ts", content: "x\n" }
          : name === "edit"
            ? { file_path: "a.ts" }
            : { path: "." };
    const call = renderers.renderCall(args, theme, context);
    const callRows = call.render(120);
    const details = name === "edit" ? { diff: "-a\n+b" } : {};
    const result = renderers.renderResult(
      { content: [{ type: "text", text: "line\n" }], details },
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    const resultRows = result.render(120);
    if (callRows.length !== 1) {
      problems.push(`${name} 调用行 ${callRows.length} 行`);
    }
    if (resultRows.length !== 0) {
      problems.push(`${name} 结果区 ${resultRows.length} 行`);
    }
  }
  assert(problems.length === 0, problems.join("；"));
  return `${TOOLS.length} 个工具均为 1 行`;
});

await record("摘要经过一次延迟重绘后出现", async () => {
  const renderers = resolver("bash", () => undefined);
  const context = makeContext();
  let invalidations = 0;
  context.invalidate = () => {
    invalidations += 1;
  };
  renderers.renderResult(
    { content: [{ type: "text", text: "a\nb\nc\n" }], details: {} },
    { expanded: false, isPartial: false },
    theme,
    context,
  );
  await new Promise((done) => setTimeout(done, 10));
  assert(invalidations === 1, `预期安排一次重绘，实际 ${invalidations} 次`);
  const call = renderers.renderCall({ command: "printf" }, theme, context);
  const rows = call.render(120);
  assert(rows.length === 1 && rows[0].includes("3 lines"), `摘要缺失：${JSON.stringify(rows)}`);
  return "3 lines";
});

await record("真实组件：折叠 2 行且卡片可点开", () => {
  const ui = { requestRender() {} };
  const cwd = process.cwd();
  const base = pi.createBashToolDefinition(cwd);
  const renderers = resolver("bash", () => base);
  const component = new pi.ToolExecutionComponent(
    "bash",
    "verify-call",
    { command: "echo hi" },
    {},
    { ...base, ...renderers },
    ui,
    cwd,
  );
  component.updateResult({ content: [{ type: "text", text: "a\nb\n" }], details: {} }, false);

  const collapsed = component.render(80);
  assert(collapsed.length === 2 && collapsed[0] === "", `折叠应为空行 + 卡片共 2 行，实际 ${collapsed.length} 行`);

  const click = component.handleMouse({
    type: "click",
    button: "left",
    x: 2,
    y: 1,
    width: 80,
    height: collapsed.length,
  });
  assert(click?.handled === true, "点击第一行没有触发展开，鼠标坐标与渲染行数可能又不同步了");

  const expanded = component.render(80);
  assert(expanded.length > 1, `展开后应有多行，实际 ${expanded.length} 行`);
  return `折叠 ${collapsed.length} 行，展开 ${expanded.length} 行`;
});

await record("点击组内成员空白行也能展开收起", () => {
  const chat = new tui.Container();
  const toolA = makeTool("bash", { command: "a" }, "1\n");
  chat.addChild(toolA);
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const event = (y, type = "click") => ({
    type,
    button: type === "move" ? "none" : "left",
    x: 2,
    y,
    width: 80,
    height: chat.render(80).length,
    screenX: 2,
    screenY: y,
    shift: false,
    ctrl: false,
    alt: false,
  });

  chat.handleMouse(event(0));
  const expandedGroup = chat.render(80).length;
  assert(expandedGroup >= 4, `组没有展开：${expandedGroup} 行`);

  // 鼠标移动不能切换展开状态
  const moved = chat.handleMouse(event(2, "move"));
  assert(moved === undefined, `移动事件被当成了点击：${JSON.stringify(moved)}`);
  assert(toolA.expanded !== true, "hover 把成员展开了");

  // 组内 y=2 是第一个成员的首行（Spacer），原生 MouseRegion 命中不到
  const opened = chat.handleMouse(event(2));
  assert(opened?.handled === true, "点击成员空白行没有响应");
  assert(toolA.expanded === true, "成员没有展开");

  const closed = chat.handleMouse(event(2));
  assert(closed?.handled === true, "再次点击没有响应");
  assert(toolA.expanded === false, "成员没有收起");
  return "move 不切换，点击可展开与收起";
});

await record("补丁所有权记在全局登记表里", () => {
  const table = patchTable();
  assert(table?.toolGroups !== undefined, "登记表里没有分组补丁");
  assert(tui.Container.prototype.addChild === table.toolGroups.wrapper, "addChild 上的方法不是本扩展的包装函数");
  return "compactRows / toolGroups";
});

await record("/tool-lines off 还原原型并让位给原生渲染", async () => {
  const table = patchTable();
  const originalUpdateDisplay = table.compactRows.original;
  const originalAddChild = table.toolGroups.original;
  await runCommand("tool-lines", "off");
  assert(pi.ToolExecutionComponent.prototype.updateDisplay === originalUpdateDisplay, "updateDisplay 没有还原");
  assert(tui.Container.prototype.addChild === originalAddChild, "addChild 没有还原");
  assert(patchTable().compactRows === undefined && patchTable().toolGroups === undefined, "关闭后仍留着所有权条目");
  assert(resolver("bash", () => "native") === "native", "渲染器没有让位给原生实现");
  return "两个原型已还原，渲染器让位";
});

await record("/tool-lines on 重新装上补丁", async () => {
  await runCommand("tool-lines", "on");
  const table = patchTable();
  assert(pi.ToolExecutionComponent.prototype.updateDisplay === table.compactRows.wrapper, "updateDisplay 没有重新装上");
  assert(tui.Container.prototype.addChild === table.toolGroups.wrapper, "addChild 没有重新装上");
  assert(resolver("bash", () => "native") !== "native", "渲染器没有恢复");
  return "补丁与渲染器都回来了";
});

await record("/tool-lines status 报告开关与补丁归属", async () => {
  notifications.length = 0;
  await runCommand("tool-lines", "status");
  const text = notifications.at(-1)?.text ?? "";
  assert(text.includes("紧凑显示开启"), `状态输出不对：${text}`);
  assert(text.includes("本扩展"), `状态没有报告补丁归属：${text}`);
  return text;
});

await record("/reload 后新实例接管，调用链不叠加", async () => {
  const before = patchTable().compactRows;
  const reloaded = await jiti.import(EXTENSION, { default: true });
  const factory = reloaded.default ?? reloaded;
  factory(commandApi);
  const after = patchTable().compactRows;
  assert(after.wrapper !== before.wrapper, "重载没有产生新的模块实例，jiti 缓存了模块");
  assert(after.original === before.original, "重载后被当成 original 的仍是上一个实例的包装函数，调用链会逐次变长");
  assert(
    pi.ToolExecutionComponent.prototype.updateDisplay === after.wrapper,
    "重载后原型上不是新实例的包装函数",
  );
  return "original 保持原生方法";
});

await record("其他扩展接管后关闭只放弃所有权", async () => {
  const foreign = function updateDisplay() {};
  pi.ToolExecutionComponent.prototype.updateDisplay = foreign;
  await runCommand("tool-lines", "off");
  assert(
    pi.ToolExecutionComponent.prototype.updateDisplay === foreign,
    "关闭时把其他扩展的补丁写回了自己的 original",
  );
  assert(patchTable().compactRows === undefined, "关闭后仍留着所有权条目");
  return "保留外部补丁";
});

const failed = results.filter((item) => !item.ok).length;

console.log(`\n${manifest.name}@${manifest.version}`);
console.log(packageDir);
console.log("");
for (const item of results) {
  const label = item.ok ? "PASS" : "FAIL";
  console.log(`${label}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
}
console.log("");
console.log(`${results.length - failed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
