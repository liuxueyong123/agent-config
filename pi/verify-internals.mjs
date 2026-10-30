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
const TIMER_EXTENSION = join(HERE, "extensions", "task-timer.ts");
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

function makeTool(name, args, text, { partial = false, error = false, durationMs = undefined } = {}) {
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
  component.updateResult({ content: [{ type: "text", text }], details: {}, isError: error, durationMs }, partial);
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

await record("块前空行：紧贴工具块压到 0，其余保留一行", () => {
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

await record("edit / write 不进折叠组，紧跟折叠组时保留空行", () => {
  const chat = new tui.Container();
  chat.addChild(makeTool("bash", { command: "a" }, "1\n"));
  chat.addChild(makeTool("edit", { file_path: "a.ts" }, "ok\n"));
  chat.addChild(makeTool("write", { file_path: "b.ts", content: "x\n" }, "ok\n"));
  chat.addChild(makeTool("bash", { command: "b" }, "2\n"));
  const names = chat.children.map((child) => child.constructor.name);
  assert(
    names.join(",") === "ToolGroup,ToolExecutionComponent,ToolExecutionComponent,ToolGroup",
    `edit / write 被收进了折叠组：${names.join(",")}`,
  );
  const editTool = chat.children[1];
  // 这条失败意味着 isUngroupedTool 读不到 toolName 而静默退回分组，不是分组逻辑回归
  assert(
    editTool.toolName === "edit",
    "组件上读不到 toolName，不进组的判断会静默失效（pi 可能改了私有字段名）",
  );

  const rows = chat.render(80).map(stripAnsi);
  assert(
    rows.length === 7,
    `预期「组 2 行 + 空行 + edit 1 行 + write 1 行 + 组 2 行」，实际 ${rows.length} 行：${JSON.stringify(rows)}`,
  );
  // 组的摘要行与 edit 路径行之间必须留一行，否则会读成同一个折叠块的一部分
  assert(rows[2] === "", `折叠组和 edit 之间应保留一行空行：${JSON.stringify(rows)}`);
  assert(rows[3].includes("edit"), `edit 行不在预期位置：${JSON.stringify(rows)}`);
  assert(rows[4].includes("write"), `write 行不在预期位置：${JSON.stringify(rows)}`);

  const clickAt = (y, height) => ({
    type: "click",
    button: "left",
    x: 2,
    y,
    width: 80,
    height,
    screenX: 2,
    screenY: y,
    shift: false,
    ctrl: false,
    alt: false,
  });
  // 展开后多出内边距行，坐标不再固定，按渲染结果定位调用行
  const clickRow = (needle) => {
    const rendered = chat.render(80).map(stripAnsi);
    const row = rendered.findIndex((line) => line.includes(needle));
    assert(row !== -1, `渲染结果里找不到 ${needle} 行：${JSON.stringify(rendered)}`);
    chat.handleMouse(clickAt(row, rendered.length));
  };

  clickRow("edit");
  assert(editTool.expanded === true, "点击 edit 行没有展开");
  assert(editTool.render(80).length > 2, "edit 展开后仍是 1 行");
  clickRow("edit");
  assert(editTool.expanded === false, "再次点击没有收起 edit");

  // 紧贴只对连续的 edit / write 生效：接到文本、折叠组后面或作为首块时，块前空行必须还在
  for (const [label, children] of [
    ["文本之后", [new tui.Text("assistant", 0, 0), makeTool("edit", { file_path: "a.ts" }, "ok\n")]],
    ["作为首块", [makeTool("write", { file_path: "b.ts", content: "x\n" }, "ok\n")]],
  ]) {
    const solo = new tui.Container();
    for (const child of children) {
      solo.addChild(child);
    }
    const soloRows = solo.render(80).map(stripAnsi);
    // 工具自身占「块前空行 + 调用行」两行
    const leadingBlank = soloRows.length - 2;
    assert(
      leadingBlank >= 0 && soloRows[leadingBlank] === "",
      `${label}的 edit / write 块前空行被压掉了：${JSON.stringify(soloRows)}`,
    );
  }
  return "组后留一行，edit / write 相邻贴紧，点击可展开与收起";
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
    for (const isError of [false, true]) {
      const label = isError ? `${name} 错误` : name;
      const renderers = resolver(name, () => undefined);
      const context = makeContext();
      context.isError = isError;
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
        { content: [{ type: "text", text: isError ? "boom\nsecond line\n" : "line\n" }], details },
        { expanded: false, isPartial: false },
        theme,
        context,
      );
      const resultRows = result.render(120);
      if (callRows.length !== 1) {
        problems.push(`${label} 调用行 ${callRows.length} 行`);
      }
      if (resultRows.length !== 0) {
        problems.push(`${label} 结果区 ${resultRows.length} 行`);
      }
    }
  }
  assert(problems.length === 0, problems.join("；"));
  return `${TOOLS.length} 个工具在成功与错误下都是 1 行`;
});

await record("错误结果折叠成一行，展开才输出完整错误", async () => {
  const problems = [];
  const errorText = "Could not find edits[2] in /a.ts.\nThe oldText must match exactly.\n";
  for (const name of ["edit", "write"]) {
    const renderers = resolver(name, () => undefined);
    const context = makeContext();
    context.isError = true;
    const args = name === "edit" ? { file_path: "a.ts" } : { file_path: "a.ts", content: "x\n" };
    const result = { content: [{ type: "text", text: errorText }], details: {} };

    const collapsed = renderers.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    if (collapsed.render(120).length !== 0) {
      problems.push(`${name} 折叠时仍渲染错误正文`);
    }
    // 摘要由 renderResult 发布，调用行要等下一次重绘才拿到
    await new Promise((done) => setTimeout(done, 10));
    const callRows = renderers.renderCall(args, theme, context).render(120);
    if (callRows.length !== 1) {
      problems.push(`${name} 调用行 ${callRows.length} 行`);
    } else if (!callRows[0].includes("Could not find edits[2]")) {
      problems.push(`${name} 调用行缺少错误摘要：${JSON.stringify(callRows)}`);
    }

    const expandedContext = { ...context, expanded: true };
    const expandedRows = renderers
      .renderResult(result, { expanded: true, isPartial: false }, theme, expandedContext)
      .render(120);
    const expanded = expandedRows.map(stripAnsi).join("\n");
    if (!expanded.includes("The oldText must match exactly.")) {
      problems.push(`${name} 展开后看不到完整错误：${JSON.stringify(expanded)}`);
    }
    // 错误原文常以换行结尾，正文必须先进 trim，否则尾部会多渲染一行空白
    if (expandedRows.length > 1 && stripAnsi(expandedRows[expandedRows.length - 1]) === "") {
      problems.push(`${name} 展开正末尾残留空行：${JSON.stringify(expandedRows.map(stripAnsi))}`);
    }
  }
  assert(problems.length === 0, problems.join("；"));
  return "edit / write 折叠 0 行，摘要进调用行，展开有完整错误";
});

await record("write 参数缺 content 时折叠仍是一行", () => {
  const renderers = resolver("write", () => undefined);
  const context = makeContext();
  const rows = renderers.renderCall({ file_path: "a.ts" }, theme, context).render(120).map(stripAnsi);
  assert(rows.length === 1, `折叠应只有 1 行，实际 ${rows.length} 行：${JSON.stringify(rows)}`);
  assert(rows[0].includes("invalid content arg"), `折叠行缺少原因：${JSON.stringify(rows)}`);

  context.expanded = true;
  const expanded = renderers.renderCall({ file_path: "a.ts" }, theme, context).render(120);
  assert(expanded.length === 2, `展开应显示原因，实际 ${expanded.length} 行`);
  return "折叠 1 行，展开 2 行";
});

await record("真实组件：edit / write 错误折叠仍是一行", async () => {
  const problems = [];
  for (const name of ["edit", "write"]) {
    // 走真实 ToolExecutionComponent，覆盖 renderCall/renderResult 的调用顺序与 context 字段
    const args = name === "edit" ? { file_path: "a.ts" } : { file_path: "a.ts", content: "x\n" };
    const tool = makeTool(name, args, "first line.\nsecond line.", { error: true, durationMs: 1200 });
    // 摘要由 renderResult 发布，等一次延迟重绘把调用行重建出来
    await new Promise((done) => setTimeout(done, 10));

    const collapsed = tool.render(80);
    const visible = collapsed.map(stripAnsi);
    if (collapsed.length !== 2) {
      problems.push(`${name} 折叠时 ${collapsed.length} 行：${JSON.stringify(visible)}`);
    } else if (!visible[1].includes("first line.")) {
      problems.push(`${name} 折叠行缺少错误摘要：${JSON.stringify(visible)}`);
    } else if (name === "write") {
      // write 的摘要槽位同时放错误、行数与耗时，三者都不能被挤掉
      if (!visible[1].includes("1 line")) {
        problems.push(`write 折叠行丢了行数摘要：${JSON.stringify(visible)}`);
      }
      if (!visible[1].includes("Took")) {
        problems.push(`write 折叠行缺耗时：${JSON.stringify(visible)}`);
      }
    }

    tool.setExpanded(true);
    const expanded = tool.render(80).map(stripAnsi).join("\n");
    if (!expanded.includes("second line.")) {
      problems.push(`${name} 展开后看不到完整错误：${JSON.stringify(expanded)}`);
    }
    tool.setExpanded(false);
    // 收起时摘要也要等一次延迟重绘才写回调用行，与其它工具同一套发布链路
    await new Promise((done) => setTimeout(done, 10));
    const recollapsed = tool.render(80).map(stripAnsi);
    if (
      recollapsed.length !== 2 ||
      recollapsed[1] === undefined ||
      !recollapsed[1].includes("first line.")
    ) {
      problems.push(`${name} 收起后没有回到一行带摘要：${JSON.stringify(recollapsed)}`);
    }
  }
  assert(problems.length === 0, problems.join("；"));
  return "折叠 2 行（空行 + 带摘要的卡片），展开有完整错误，收起后恢复一行";
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

/**
 * task-timer 依赖 footer 的两件事：状态行永远是最后一行、FooterComponent.render 可 patch。
 * 这里用最小的假 session 构造真实的 FooterComponent，不走 TUI 也能验证渲染结果。
 */
function makeFooterFixture() {
  const statuses = new Map();
  return {
    statuses,
    session: {
      state: { model: { id: "probe", provider: "probe", reasoning: false, contextWindow: 1000 }, thinkingLevel: "off" },
      sessionManager: {
        getCwd: () => "/probe",
        getSessionName: () => undefined,
        getEntryCount: () => 0,
        getSessionId: () => "probe-session",
        getLeafId: () => "probe-leaf",
        getEntries: () => [],
      },
      getContextUsage: () => undefined,
      modelRuntime: { isUsingSubscription: () => false },
      routedModel: undefined,
    },
    footerData: {
      getGitBranch: () => null,
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => statuses,
    },
  };
}

function renderFooter(fixture, width = 120) {
  return new pi.FooterComponent(fixture.session, fixture.footerData).render(width).map(stripAnsi);
}

/** 收集 task-timer 注册的事件处理器，并提供一个只记录状态栏写入的假 ctx */
function makeTimerHarness(fixture) {
  const handlers = new Map();
  const api = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      theme: { fg: (color, text) => `<${color}>${text}` },
      setStatus(key, text) {
        if (text === undefined) fixture.statuses.delete(key);
        else fixture.statuses.set(key, text);
      },
    },
  };
  return {
    api,
    async emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event, ...payload }, ctx);
      }
    },
  };
}

const timerPatchTable = () => globalThis[Symbol.for("pi.task-timer.footer-patch")];
const timerModule = await jiti.import(TIMER_EXTENSION, { default: true });
const timerFactory = timerModule.default ?? timerModule;
assert(typeof timerFactory === "function", "task-timer 没有默认导出工厂函数");

await record("FooterComponent 结构：扩展状态单独占最后一行", () => {
  const fixture = makeFooterFixture();
  fixture.statuses.set("probe", "<accent>probe status");
  const lines = renderFooter(fixture);
  assert(lines.length === 3, `footer 不是三行（pwd / 统计 / 状态）：${lines.length}`);
  assert(lines[2] === "<accent>probe status", `最后一行不是状态行：${lines[2]}`);
  return `${lines.length} 行，状态行在末尾`;
});

await record("task-timer 把状态行搬到 footer 第一行开头", async () => {
  const fixture = makeFooterFixture();
  const harness = makeTimerHarness(fixture);
  timerFactory(harness.api);
  await harness.emit("before_agent_start", { messageType: "user", prompt: "probe" });
  const lines = renderFooter(fixture);
  assert(lines.length === 2, `搬移后 footer 不是两行：${lines.length}`);
  assert(lines[0].startsWith("<accent>⏱ Elapsed "), `第一行不是计时：${lines[0]}`);
  assert(lines[0].endsWith("/probe"), `第一行丢了 pwd：${lines[0]}`);
  await harness.emit("agent_settled", { aborted: false });
  const settled = renderFooter(fixture);
  assert(settled.length === 2, `结束后 footer 不是两行：${settled.length}`);
  assert(settled[0].startsWith("<success>⏱ Took "), `结束后第一行不是总时长：${settled[0]}`);
  return settled[0];
});

await record("别的扩展也写状态时保持原生三行布局", async () => {
  const fixture = makeFooterFixture();
  const harness = makeTimerHarness(fixture);
  timerFactory(harness.api);
  await harness.emit("before_agent_start", { messageType: "user", prompt: "probe" });
  fixture.statuses.set("another-extension", "<dim>other</dim>");
  const lines = renderFooter(fixture);
  assert(lines.length === 3, `混排时不应搬走整行：${lines.length}`);
  assert(lines[2].includes("⏱ Elapsed"), `混排时状态行不在末尾：${lines[2]}`);
  await harness.emit("agent_settled", { aborted: false });
  return "退回独立一行";
});

await record("task-timer 重载后 footer 补丁不叠加", async () => {
  const before = timerPatchTable().relocate;
  const reloadedModule = await jiti.import(TIMER_EXTENSION, { default: true });
  const reloaded = reloadedModule.default ?? reloadedModule;
  reloaded(makeTimerHarness(makeFooterFixture()).api);
  const after = timerPatchTable().relocate;
  assert(after.original === before.original, "重载后 original 仍是上一个实例的包装函数");
  assert(pi.FooterComponent.prototype.render === after.wrapper, "重载后原型上不是新实例的包装函数");
  return "original 保持原生 render";
});

/**
 * 计时语义：用假时钟推进 Date.now，不必真的等上几分钟。
 * 断言看渲染结果而不是内部状态，保证「起点 / 每秒刷新 / 定格」是用户能看到的行为。
 */
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const realDateNow = Date.now;
let timerClock = 1_000_000_000;
Date.now = () => timerClock;

async function startTimerTask(fixture, prompt = "probe") {
  const harness = makeTimerHarness(fixture);
  timerFactory(harness.api);
  await harness.emit("input", { text: prompt, source: "interactive" });
  return harness;
}

try {
  await record("task-timer 起点包含启动前的自动压缩", async () => {
    const fixture = makeFooterFixture();
    const harness = await startTimerTask(fixture);
    timerClock += 4000;
    await harness.emit("before_agent_start", { messageType: "user", prompt: "probe" });
    const first = renderFooter(fixture)[0];
    assert(first.startsWith("<accent>⏱ Elapsed 4s"), `起点没有取 input 时间：${first}`);
    await harness.emit("session_shutdown", {});
    return first;
  });

  await record("task-timer 执行中每秒刷新，追加消息不重置起点", async () => {
    const fixture = makeFooterFixture();
    const harness = await startTimerTask(fixture);
    await harness.emit("before_agent_start", { messageType: "user", prompt: "probe" });
    timerClock += 26_000;
    await sleepFor(1100);
    const ticking = renderFooter(fixture)[0];
    assert(ticking.startsWith("<accent>⏱ Elapsed 26s"), `计时没有刷新：${ticking}`);

    await harness.emit("input", { text: "追加要求", source: "interactive", streamingBehavior: "steer" });
    timerClock += 3000;
    await harness.emit("before_agent_start", { messageType: "user", prompt: "追加要求" });
    await sleepFor(1100);
    const merged = renderFooter(fixture)[0];
    assert(merged.startsWith("<accent>⏱ Elapsed 29s"), `追加消息重置了起点：${merged}`);
    await harness.emit("session_shutdown", {});
    return merged;
  });

  await record("task-timer 结束后定格且不再刷新", async () => {
    const fixture = makeFooterFixture();
    const harness = await startTimerTask(fixture);
    await harness.emit("before_agent_start", { messageType: "user", prompt: "probe" });
    timerClock += 63_000;
    await harness.emit("agent_settled", { aborted: false });
    const settled = renderFooter(fixture)[0];
    assert(settled.startsWith("<success>⏱ Took 1m 03s"), `终值不对：${settled}`);

    timerClock += 5000;
    await sleepFor(1100);
    const after = renderFooter(fixture);
    assert(after.length === 2 && after[0] === settled, `结束后仍在刷新：${after[0]}`);
    await harness.emit("session_shutdown", {});
    return settled;
  });

  await record("task-timer 中断标注 aborted", async () => {
    const fixture = makeFooterFixture();
    const harness = await startTimerTask(fixture);
    await harness.emit("before_agent_start", { messageType: "user", prompt: "probe" });
    timerClock += 12_000;
    await harness.emit("agent_settled", { aborted: true });
    const line = renderFooter(fixture)[0];
    assert(line.startsWith("<warning>⏱ Took 12s · aborted"), `中断标注不对：${line}`);
    await harness.emit("session_shutdown", {});
    return line;
  });

  await record("task-timer 忽略 custom 运行与斜杠命令的输入时间", async () => {
    const fixture = makeFooterFixture();
    const harness = await startTimerTask(fixture, "/model");
    timerClock += 90_000;
    await harness.emit("before_agent_start", { messageType: "user", prompt: "新任务" });
    const line = renderFooter(fixture)[0];
    assert(line.startsWith("<accent>⏱ Elapsed 0s"), `斜杠命令的时间污染了起点：${line}`);

    const customFixture = makeFooterFixture();
    const custom = makeTimerHarness(customFixture);
    timerFactory(custom.api);
    await custom.emit("before_agent_start", { messageType: "custom", message: { role: "user" } });
    await custom.emit("agent_settled", { aborted: false });
    assert(renderFooter(customFixture).length === 2, "custom 运行也写了状态栏");

    await harness.emit("session_shutdown", {});
    return "起点取运行开始时刻";
  });
} finally {
  Date.now = realDateNow;
}

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
