#!/bin/bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
codex_dir="${CODEX_HOME:-$HOME/.codex}"
claude_dir="$HOME/.claude"
pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
codex_skills_dir=""
target_client="all"

usage() {
  printf '%s\n' '用法：bash install.sh [--target codex|claude|pi|all] [--codex-dir 绝对路径] [--claude-dir 绝对路径] [--pi-dir 绝对路径] [--skills-dir Codex的skill绝对路径]'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      if [[ $# -lt 2 ]]; then
        usage >&2
        exit 1
      fi
      case "$2" in
        codex|claude|pi|all) target_client="$2" ;;
        *) usage >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --codex-dir|--claude-dir|--pi-dir|--skills-dir)
      if [[ $# -lt 2 || "$2" != /* ]]; then
        printf '参数 %s 需要一个绝对路径。\n' "$1" >&2
        exit 1
      fi
      case "$1" in
        --codex-dir) codex_dir="$2" ;;
        --claude-dir) claude_dir="$2" ;;
        --pi-dir) pi_dir="$2" ;;
        --skills-dir) codex_skills_dir="$2" ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

codex_skills_dir="${codex_skills_dir:-$codex_dir/skills}"
if [[ "$codex_dir" != /* || "$claude_dir" != /* || "$pi_dir" != /* || "$codex_skills_dir" != /* ]]; then
  printf '%s\n' '安装目录必须使用绝对路径。' >&2
  exit 1
fi

want_codex=0
want_claude=0
want_pi=0
[[ "$target_client" == all || "$target_client" == codex ]] && want_codex=1
[[ "$target_client" == all || "$target_client" == claude ]] && want_claude=1
[[ "$target_client" == all || "$target_client" == pi ]] && want_pi=1

# Codex 和 Claude Code 使用独立目录；Pi 额外支持共享的 ~/.agents/skills。
# Pi 的 AGENTS.md 是 agent 目录下的上下文文件，对所有工作目录生效。
sources=()
targets=()
if [[ "$want_codex" == 1 ]]; then
  sources+=("$repo_dir/AGENTS.md")
  targets+=("$codex_dir/AGENTS.md")
fi
if [[ "$want_claude" == 1 ]]; then
  sources+=("$repo_dir/AGENTS.md")
  targets+=("$claude_dir/CLAUDE.md")
fi
if [[ "$want_pi" == 1 ]]; then
  sources+=("$repo_dir/AGENTS.md")
  targets+=("$pi_dir/AGENTS.md")
fi

skill_names=()
for skill_dir in "$repo_dir"/skills/*; do
  [[ -d "$skill_dir" ]] || continue
  skill_name="$(basename -- "$skill_dir")"
  if [[ ! -f "$skill_dir/SKILL.md" ]]; then
    printf '缺少 skill 入口：%s/SKILL.md\n' "$skill_dir" >&2
    exit 1
  fi
  skill_names+=("$skill_name")
  if [[ "$want_codex" == 1 ]]; then
    sources+=("$skill_dir")
    targets+=("$codex_skills_dir/$skill_name")
  fi
  if [[ "$want_claude" == 1 ]]; then
    sources+=("$skill_dir")
    targets+=("$claude_dir/skills/$skill_name")
  fi
  if [[ "$want_pi" == 1 ]]; then
    sources+=("$skill_dir")
    targets+=("$pi_dir/skills/$skill_name")
  fi
done

# 先检查全部目标，避免因为已知冲突而只安装一部分。
for i in "${!sources[@]}"; do
  source_path="${sources[$i]}"
  target_path="${targets[$i]}"
  if [[ ! -e "$source_path" ]]; then
    printf '缺少源文件：%s\n' "$source_path" >&2
    exit 1
  fi
  if [[ -L "$target_path" && "$target_path" -ef "$source_path" ]]; then
    continue
  fi
  if [[ -e "$target_path" || -L "$target_path" ]]; then
    printf '目标已存在，请检查并自行备份后再安装：%s\n' "$target_path" >&2
    exit 1
  fi
done

for i in "${!sources[@]}"; do
  source_path="${sources[$i]}"
  target_path="${targets[$i]}"
  if [[ -L "$target_path" && "$target_path" -ef "$source_path" ]]; then
    printf '已连接：%s\n' "$target_path"
    continue
  fi
  mkdir -p -- "$(dirname -- "$target_path")"
  ln -s -- "$source_path" "$target_path"
  printf '已创建：%s -> %s\n' "$target_path" "$source_path"
done

if [[ "$want_pi" == 1 ]]; then
  printf 'Pi 提示：%s 中的 skills/ 会被自动发现；如需改用其他目录，可在 settings.json 的 skills 中追加路径。\n' "$pi_dir" >&2
fi
