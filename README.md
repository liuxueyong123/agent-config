# 个人 Agent 配置

通过 Git 管理个人全局规则和选定的 skill，使用软链接让 Codex、Claude Code 和 Pi 直接读取仓库中的同一份真实文件。

## 当前内容

- `AGENTS.md`：共享全局规则，分别通过 `~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md` 和 `~/.pi/agent/AGENTS.md` 加载。
- `skills/code-review-and-quality/`：代码质量审查 skill，包含安全与性能检查清单。
- `skills/code-simplification/`：保持行为不变的代码简化 skill。
- `skills/deevid-tracking-doc/`：Deevid 埋点文档 skill，包含模板与界面元数据。
- `skills/implementation-handoff/`：实现交接 skill。
- `pi/APPEND_SYSTEM.md`：Pi 专有的系统提示追加段，通过 `~/.pi/agent/APPEND_SYSTEM.md` 加载，用于补充过程播报等行为约束。
- `pi/extensions/`：Pi 专有扩展，逐个链接到 `~/.pi/agent/extensions/`，当前包含 `exit-alias`、`skill-shortcuts` 和 `tool-preview-lines`。
- `install.sh`：为选定客户端建立全局规则、`skills/` 下所有 skill 以及 Pi 专有配置的软链接。
- `tests/test_install.py`：在隔离目录验证安装、重复运行和冲突保护。

以上四个 skill 在三个客户端共用同一份正文与配套资源，全局规则中的 skill 路径按当前客户端发现的实际位置解析。`pi/` 下的内容只服务 Pi，不链接到其他客户端；未列出的个人 skill、系统 skill 和客户端插件不由此仓库管理。

## 在其他电脑安装

将仓库 clone 到任意稳定位置，然后执行：

```bash
cd /你的路径/agent-config
bash install.sh
```

**默认同时安装 Codex、Claude Code 和 Pi**。三边的规则入口都直接链接到仓库中的 `AGENTS.md`，每个 skill 分别链接到各自加载目录。安装脚本根据仓库实际位置生成绝对软链接，不依赖本机用户名。

| 客户端 | 默认规则入口 | 默认 skill 目录 |
| --- | --- | --- |
| Codex | `${CODEX_HOME:-$HOME/.codex}/AGENTS.md` | `${CODEX_HOME:-$HOME/.codex}/skills/` |
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills/` |
| Pi | `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md` | `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/` |

`pi/` 目录只服务 Pi，安装脚本只在目标包含 Pi 时创建以下链接：

| 仓库路径 | Pi 加载位置 | 作用 |
| --- | --- | --- |
| `pi/APPEND_SYSTEM.md` | `<pi-dir>/APPEND_SYSTEM.md` | 启动时追加到系统提示末尾，补充过程播报等行为约束 |
| `pi/extensions/*.ts` | `<pi-dir>/extensions/` | 启动时逐个自动发现的 Pi 扩展 |

Pi 的扩展加载器会跟随软链接，链接后保持原文件名即可被识别。`install.sh` 只处理 `pi/extensions/` 下的 `*.ts` 文件；新增扩展子目录或带 `package.json` 的包时需要手动补充脚本。

只使用其中一个客户端时，可选择安装目标：

```bash
bash install.sh --target codex
bash install.sh --target claude
bash install.sh --target pi
```

如 Codex 使用 `~/.agents/skills`，可指定其 skill 加载目录；Claude Code 的目录不受此参数影响：

```bash
bash install.sh --skills-dir "$HOME/.agents/skills"
```

同一客户端内，每个 skill 只选择一个加载入口，避免重复显示。需要自定义配置目录时可传入 `--codex-dir /绝对路径`、`--claude-dir /绝对路径` 或 `--pi-dir /绝对路径`。

在 Claude Code 中可使用 `/code-review-and-quality`、`/code-simplification`、`/deevid-tracking-doc` 和 `/implementation-handoff` 调用，也可根据任务自动选用。`agents/openai.yaml` 是 Codex 的界面元数据，Claude Code 和 Pi 共用的是 `SKILL.md` 及其配套资源，无需复制或转换正文。

Pi 的规则入口是 agent 目录下的上下文文件 `AGENTS.md`，对所有工作目录生效；skill 从 agent 目录的 `skills/` 递归发现，无需额外改 `settings.json`。在 Pi 中可用 `/skill:名称` 强制加载，或在任务匹配时自动选用。Pi 也支持共享的 `~/.agents/skills/`，本脚本默认只写入 agent 目录内的 `skills/`，避免与其他工具重复；若希望改用共享目录，可在 `settings.json` 的 `skills` 数组里追加路径。

安装可重复运行，已经正确连接的目标会跳过。已有普通文件、目录、指向其他位置的链接或失效链接都会被视为冲突；脚本在创建链接前检查全部目标，遇到冲突会停止，请先检查并将冲突项备份到加载目录之外。运行中的磁盘或权限错误仍可能造成部分安装，排除原因后可以重跑。脚本适用于 macOS 和 Linux 的 Bash 环境，原生 Windows 未验证。

## 日常修改与同步

直接编辑仓库内的 `AGENTS.md` 或 `skills/`；通过全局软链接编辑也会写入同一份文件。检查差异后再提交并推送，在其他电脑拉取更新：

```bash
git status
git diff
git add AGENTS.md pi/ skills/ README.md install.sh tests/ .gitignore
git commit -m "chore: sync personal agent configuration"
git push
```

新电脑首次安装前需要配置 Git 远端和访问权限。在其他电脑执行 `git pull` 后，已有链接会直接读取新内容；新增 skill 需要再运行 `bash install.sh`，删除或重命名 skill 后需要检查并移除对应的旧链接。仓库移动位置后，已有绝对链接也需要检查并重建。若客户端中内容没有刷新，请重新开启会话或重启客户端。

此仓库只同步列出的规则和 skill；登录凭据、会话、插件缓存与其他客户端设置不在同步范围内。

## 验证安装脚本

测试只操作临时目录，不修改真实客户端配置：

```bash
python3 -B -m unittest discover -s tests
```

Claude Code 支持软链接 skill 文件夹和共享规则文件，参见[官方 skill 文档](https://code.claude.com/docs/en/skills#choose-where-skills-load)与[官方规则文档](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools)。Pi 支持 agent 目录下的 `AGENTS.md` 上下文文件、`skills/` 与 `extensions/` 自动发现、`APPEND_SYSTEM.md` 系统提示追加，以及 `settings.json` 的资源路径配置，参见[配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md)、[skills 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)与 [extensions 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)。本机已验证链接与资源可读性；自动加载和手动调用仍需在新客户端会话中确认。

## 本机首次迁移与恢复

首次迁移时，原来的全局规则和两个 skill 已备份到 `~/.codex/backups/agent-config-20261016-*`，备份不进入 Git 仓库。

接入 Claude Code 时，原 `~/.claude/CLAUDE.md` 链接已另行备份到 `~/.claude/backups/agent-config-*`，新入口直接链接到本仓库，不再经过 Codex 目录。

2026-10-22 迁入 `code-review-and-quality` 和 `code-simplification` 时，两个客户端的原目录分别备份到 `~/.codex/backups/agent-config-20261022-214639/` 和 `~/.claude/backups/agent-config-20261022-214639/`。两边正文一致，共享源完整保留 Claude Code 版本中的来源注释与附带检查清单。

2026-10-28 迁入 Pi 专有的 `APPEND_SYSTEM.md` 与三个扩展时，原文件从 `~/.pi/agent/` 移入仓库的 `pi/`，原位置替换为软链接，没有保留额外备份，仓库中的文件即唯一副本。

恢复时，先核对并保存迁移后在仓库中产生的修改，再逐项确认全局路径确实为指向此仓库的软链接；删除链接本身后，从对应备份目录移回原文件或文件夹。不要递归删除软链接目标。

## Git 与远端

仓库使用 `main` 分支。跨电脑同步前，需要配置可访问的 Git 远端；远端地址和访问凭据由各电脑自行配置。
