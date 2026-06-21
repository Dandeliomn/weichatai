# WeChat Companion AI

微信情感陪伴AI服务平台

## 系统架构
- 宿主机 Hermes: WeChat消息处理 + AI角色扮演 (DeepSeek V4 Flash + ex_gentle_ex + SOUL.md)
- Docker 系统: 管理后台 + 对话记录 + Bot管理 (BridgePage)
- 对话同步: Hermes state.db → PostgreSQL (10s interval)

## 部署
```bash
docker compose up -d                    # 管理后台
systemctl --user start hermes-gateway   # AI引擎
systemctl --user start hermes-sync      # 对话同步
```

## 访问
- Dashboard: http://localhost:8080
- BridgePage: http://localhost:8080/bridge
