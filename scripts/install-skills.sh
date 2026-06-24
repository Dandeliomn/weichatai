#!/bin/bash
# =============================================================================
# install-skills.sh 鈥?瀹夎 vendor 涓殑 Hermes Agent 鎶€鑳?#
# 灏?vendor/ 鐩綍涓嬬殑绗笁鏂规妧鑳借蒋閾惧埌 ~/.hermes/skills/
# 鐢ㄦ硶: bash scripts/install-skills.sh [--dry-run]
# =============================================================================

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_SKILLS_DIR="${HERMES_SKILLS_DIR:-$HOME/.hermes/skills}"
VENDOR_DIR="$PROJECT_DIR/vendor"

echo "=========================================="
echo "  瀹夎绗笁鏂?Hermes Agent 鎶€鑳?
echo "=========================================="
echo "  椤圭洰鐩綍:    $PROJECT_DIR"
echo "  鐩爣鐩綍:    $HERMES_SKILLS_DIR"
echo "  妯″紡:        $($DRY_RUN && echo 'DRY RUN' || echo '瀹為檯瀹夎')"
echo ""

if [ ! -d "$VENDOR_DIR" ]; then
    echo "鉂?鏈壘鍒?vendor/ 鐩綍锛岃鍏?git pull"
    exit 1
fi

mkdir -p "$HERMES_SKILLS_DIR"

# ===== SoulCraft 浜烘牸钂搁 =====
echo "[1/2] SoulCraft 鈥?浜烘牸钂搁鎶€鑳?
for skill in distill distill-lite distill-standard; do
    src="$VENDOR_DIR/soulcraft/skills/$skill"
    dst="$HERMES_SKILLS_DIR/$skill"
    
    if [ ! -d "$src" ] && [ ! -f "$src/SKILL.md" ]; then
        echo "  鈿狅笍  璺宠繃 $skill锛堟湭鎵惧埌 SKILL.md锛?
        continue
    fi
    
    if [ -L "$dst" ] || [ -d "$dst" ]; then
        echo "  鈴笍  宸插瓨鍦? $skill 鈫?$(readlink "$dst" 2>/dev/null || echo '鐩綍宸插瓨鍦?)"
        continue
    fi
    
    if $DRY_RUN; then
        echo "  馃敆 灏嗗垱寤? ln -sf $src $dst"
    else
        ln -sf "$src" "$dst"
        echo "  鉁?宸插畨瑁? $skill"
    fi
done

# ===== hersona 浜烘牸灞炴€?=====
echo ""
echo "[2/2] hersona 鈥?浜烘牸灞炴€фā鏉?
src="$VENDOR_DIR/hersona/skills/hersona"
dst="$HERMES_SKILLS_DIR/hersona"

if [ -f "$src/SKILL.md" ]; then
    if [ -L "$dst" ] || [ -d "$dst" ]; then
        echo "  鈴笍  宸插瓨鍦? hersona"
    else
        if $DRY_RUN; then
            echo "  馃敆 灏嗗垱寤? ln -sf $src $dst"
        else
            ln -sf "$src" "$dst"
            echo "  鉁?宸插畨瑁? hersona"
        fi
    fi
else
    echo "  鈿狅笍  璺宠繃 hersona锛堟湭鎵惧埌 SKILL.md锛?
fi

echo ""
echo "=========================================="
echo "  瀹夎瀹屾垚"
echo "=========================================="
echo ""
echo "浣跨敤鏂瑰紡:"
echo "  Hermes 涓洿鎺ヨ: \"钂搁闈欓潤\" 鈫?瑙﹀彂 SoulCraft"
echo "  Hermes 涓洿鎺ヨ: \"/hersona personality/tsundere\" 鈫?鍔犺浇鍌插▏灞炴€?
echo ""
echo "鐜鍙橀噺 (hersona 闇€瑕?:"
echo "  export HERSONA_REPO=\$PROJECT_DIR/vendor/hersona"
echo ""
