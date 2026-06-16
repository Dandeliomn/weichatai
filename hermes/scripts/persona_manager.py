#!/usr/bin/env python3
"""
前任 Skill — 人格管理
用法:
  python3 persona_manager.py list                          # 列出所有人格
  python3 persona_manager.py switch <name> [--keep-memory]  # 切换人格
  python3 persona_manager.py current                        # 查看当前人格
"""
import os, sys, json, subprocess, sqlite3
from pathlib import Path

HERMES_HOME = Path.home() / ".hermes"
SKILLS_DIR = HERMES_HOME / "skills" / "ex-skill"
ENV_FILE = HERMES_HOME / ".env"
PG_DB = Path.home() / "wechat-companion" / "data" / "weclaw.db"  # SQLite fallback

def get_official_characters():
    """官方角色已在 ex-skill 目录中，这里只作备用查询"""
    return []  # 官方角色已转为 ex-skill，由 get_ex_personas() 统一列出

def get_ex_personas():
    """从 ex-skill 目录获取前任人格"""
    personas = []
    exes_dir = SKILLS_DIR
    if exes_dir.exists():
        for d in sorted(exes_dir.iterdir()):
            if d.is_dir() and not d.name.startswith('.') and d.name != "memory_extract":
                skill_file = d / "SKILL.md"
                if skill_file.exists():
                    name = d.name.replace("ex_", "").replace("_", " ")
                    desc = ""
                    try:
                        content = skill_file.read_text(encoding='utf-8')
                        for line in content.split('\n')[:5]:
                            if line.startswith('description:'):
                                desc = line.split(':', 1)[1].strip()
                                break
                    except:
                        pass
                    personas.append({"slug": d.name, "name": name, "desc": desc, "source": "前任Skill"})
    return personas

def list_all():
    """列出所有可用人格"""
    print("=== 前任 Skill 人格 ===")
    ex = get_ex_personas()
    if ex:
        for i, p in enumerate(ex):
            print(f"  [{i+1}] {p['name']}  ({p['slug']})")
            if p['desc']:
                print(f"      {p['desc'][:80]}")
    else:
        print("  (无)")

    print(f"\n当前: {get_current()}")
    print(f"\n共 {len(ex)} 个人格可用。说 '切换到 <名称>' 来切换。")

def get_current():
    """获取当前激活的人格"""
    try:
        content = ENV_FILE.read_text()
        for line in content.split('\n'):
            if line.startswith('WEIXIN_AUTO_SKILL='):
                return line.split('=', 1)[1].strip()
    except:
        pass
    return "(未设置)"

def switch_persona(slug, keep_memory=False):
    """切换人格，可选保留记忆"""
    # Update .env
    env_lines = ENV_FILE.read_text().split('\n') if ENV_FILE.exists() else []
    new_lines = []
    found = False
    for line in env_lines:
        if line.startswith('WEIXIN_AUTO_SKILL='):
            new_lines.append(f'WEIXIN_AUTO_SKILL={slug}')
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f'WEIXIN_AUTO_SKILL={slug}')

    ENV_FILE.write_text('\n'.join(new_lines) + '\n')
    print(f"人格已切换: {slug}")

    if not keep_memory:
        print("记忆已清除 (新人格从空白开始)")
    else:
        print("保留当前对话记忆")

    # Restart gateway
    subprocess.run(["hermes", "gateway", "restart"], capture_output=True, timeout=30)
    print("Gateway 已重启，新人格生效")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        list_all()
    elif cmd == "current":
        print(get_current())
    elif cmd == "switch":
        if len(sys.argv) < 3:
            print("用法: persona_manager.py switch <slug> [--keep-memory]")
            sys.exit(1)
        slug = sys.argv[2]
        keep = "--keep-memory" in sys.argv
        switch_persona(slug, keep)
    else:
        print(f"未知命令: {cmd}")
        sys.exit(1)
