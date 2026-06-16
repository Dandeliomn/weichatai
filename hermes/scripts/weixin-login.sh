#!/usr/bin/env bash
# 微信扫码登录助手
# 用法: bash ~/.hermes/scripts/weixin-login.sh

echo "=== Hermes Weixin / WeChat 扫码登录 ==="
echo ""

cd "$HOME" && PYTHONUNBUFFERED=1 python3 -c "
import sys, os
sys.path.insert(0, os.path.expanduser('~/.local/share/pipx/venvs/hermes-agent/lib/python3.14/site-packages'))
import asyncio
from gateway.platforms.weixin import qr_login
from hermes_constants import get_hermes_home

async def main():
    print('正在获取微信二维码，请稍候...')
    creds = await qr_login(str(get_hermes_home()))
    if creds:
        aid = creds.get('account_id', '')
        token = creds.get('token', '')
        base_url = creds.get('base_url', '')
        print()
        print('=== 登录成功 ===')
        print()
        # 写入 .env
        with open(os.path.expanduser('~/.hermes/.env'), 'a') as f:
            f.write(f'\n# Weixin Gateway (auto-login)\n')
            f.write(f'WEIXIN_ACCOUNT_ID={aid}\n')
            f.write(f'WEIXIN_TOKEN={token}\n')
            if base_url:
                f.write(f'WEIXIN_BASE_URL={base_url}\n')
            f.write(f'WEIXIN_CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c\n')
        print('已写入 ~/.hermes/.env')
        print()
        echo_cmd = f'export WEIXIN_ACCOUNT_ID={aid}'
        print(f'如果 gateway 已运行，重启: hermes gateway restart')
        print()
    else:
        print('登录失败或超时，请重试')

asyncio.run(main())
" 2>&1
