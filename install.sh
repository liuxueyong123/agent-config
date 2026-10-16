#!/bin/bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
codex_dir="${CODEX_HOME:-$HOME/.codex}"
claude_dir="$HOME/.claude"
skills_dir=""
target_client="all"

usage() {
  printf '%s\n' '用法：bash install.sh [--target codex|claude|all] [--codex-dir 绝对路径] [--claude-dir 绝对路径] [--skills-dir Codex的skill绝对路径]'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      if [[ $# -lt 2 ]]; then
        usage >&2
        exit 1
      fi
      case "$2" in
        codex|claude|all) target_client="$2" ;;
        *) usage >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --codex-dir|--claude-dir|--skills-dir)
      if [[ $# -lt 2 || "$2" != /* ]]; then
        printf '参数 %s 需要一个绝对路径。\n' "$1" >&2
        exit 1
      fi
      case "$1" in
        --codex-dir) codex_dir="$2" ;;
        --claude-dir) claude_dir="$2" ;;
        --skills-dir) skills_dir="$2" ;;
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

skills_dir="${skills_dir:-$codex_dir/skills}"
if [[ "$codex_dir" != /* || "$claude_dir" != /* || "$skills_dir" != /* ]]; then
  printf '%s\n' '安装目录必须使用绝对路径。' >&2
  exit 1
fi

sources=()
targets=()
if [[ "$target_client" == all || "$target_client" == codex ]]; then
  sources+=("$repo_dir/AGENTS.md")
  targets+=("$codex_dir/AGENTS.md")
fi
if [[ "$target_client" == all || "$target_client" == claude ]]; then
  sources+=("$repo_dir/AGENTS.md")
  targets+=("$claude_dir/CLAUDE.md")
fi
for skill_dir in "$repo_dir"/skills/*; do
  [[ -d "$skill_dir" ]] || continue
  if [[ ! -f "$skill_dir/SKILL.md" ]]; then
    printf '缺少 skill 入口：%s/SKILL.md\n' "$skill_dir" >&2
    exit 1
  fi
  if [[ "$target_client" == all || "$target_client" == codex ]]; then
    sources+=("$skill_dir")
    targets+=("$skills_dir/$(basename -- "$skill_dir")")
  fi
  if [[ "$target_client" == all || "$target_client" == claude ]]; then
    sources+=("$skill_dir")
    targets+=("$claude_dir/skills/$(basename -- "$skill_dir")")
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
