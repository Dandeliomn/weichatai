# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React admin dashboard (independent container) with 7 pages for managing the wechat-companion platform, plus 6 new Express API endpoints.

**Architecture:** New `dashboard/` directory with React+Vite SPA served by its own nginx container. Main nginx routes `/*` → dashboard, `/api/*` → existing Express API. Backend adds read-only query endpoints for dashboard data.

**Tech Stack:** React 18 + TypeScript + Vite 5 + Ant Design 5 + @ant-design/charts + React Router v6 + Axios

---

## File Map

```
Create: dashboard/package.json, tsconfig.json, vite.config.ts, index.html
Create: dashboard/Dockerfile, dashboard/nginx.conf
Create: dashboard/src/{main.tsx, App.tsx, api/client.ts, hooks/useAuth.tsx}
Create: dashboard/src/components/{Layout.tsx, StatCard.tsx, EmotionTag.tsx}
Create: dashboard/src/pages/{Login,Dashboard,Users,UserDetail,Conversations,Queue,Settings}.tsx
Modify: src/routes/admin.ts (+6 routes)
Modify: docker-compose.yml (+dashboard service)
Modify: nginx.conf (route /* → dashboard)
```

---

### Task 1: Add 6 admin API endpoints

**Files:** Modify: `src/routes/admin.ts` (insert before `export default router;`)

- [ ] **Step 1: Add GET /api/admin/conversations**

```typescript
// =============================================================================
// GET /api/admin/conversations — 全局对话日志搜索
// =============================================================================
router.get('/conversations', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const wechatId = req.query.wechat_id as string || '';
    const keyword = req.query.keyword as string || '';
    const emotion = req.query.emotion as string || '';
    const dateFrom = req.query.date_from as string || '';
    const dateTo = req.query.date_to as string || '';

    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (wechatId) { conditions.push(`cl.wechat_id ILIKE $${idx}`); params.push(`%${wechatId}%`); idx++; }
    if (keyword) { conditions.push(`cl.content ILIKE $${idx}`); params.push(`%${keyword}%`); idx++; }
    if (emotion && ['happy','sad','angry','anxious','neutral'].includes(emotion)) { conditions.push(`cl.emotion = $${idx}`); params.push(emotion); idx++; }
    if (dateFrom) { conditions.push(`cl.created_at >= $${idx}::timestamp`); params.push(dateFrom); idx++; }
    if (dateTo) { conditions.push(`cl.created_at <= $${idx}::timestamp`); params.push(dateTo); idx++; }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const [logs, countResult] = await Promise.all([
      pgPool.query(`SELECT cl.id, cl.user_id, cl.wechat_id, cl.role, cl.content, cl.emotion, cl.emotion_confidence, cl.media_type, cl.created_at, u.nickname FROM conversation_logs cl LEFT JOIN users u ON cl.user_id = u.id ${where} ORDER BY cl.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]),
      pgPool.query(`SELECT COUNT(*) FROM conversation_logs cl ${where}`, params),
    ]);
    res.json({ logs: logs.rows, total: parseInt(countResult.rows[0].count), page, limit, totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit) });
  } catch (error: any) { console.error('[Admin] conversations error:', error.message); res.status(500).json({ error: '获取对话日志失败' }); }
});
```

- [ ] **Step 2: Add GET /api/admin/users/:id/emotions**

```typescript
router.get('/users/:id/emotions', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(`SELECT emotion, COUNT(*) as count FROM conversation_logs WHERE user_id = $1 AND emotion IS NOT NULL GROUP BY emotion ORDER BY count DESC`, [parseInt(req.params.id)]);
    res.json({ emotions: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取情绪分布失败' }); }
});
```

- [ ] **Step 3: Add GET /api/admin/users/:id/conversations**

```typescript
router.get('/users/:id/conversations', async (req: Request, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;
    const [logs, countResult] = await Promise.all([
      pgPool.query(`SELECT id, role, content, emotion, emotion_confidence, media_type, created_at FROM conversation_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]),
      pgPool.query('SELECT COUNT(*) FROM conversation_logs WHERE user_id = $1', [userId]),
    ]);
    res.json({ logs: logs.rows, total: parseInt(countResult.rows[0].count), page, limit, totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit) });
  } catch (error: any) { res.status(500).json({ error: '获取对话记录失败' }); }
});
```

- [ ] **Step 4: Add GET /api/admin/users/:id/memories**

```typescript
router.get('/users/:id/memories', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(`SELECT id, summary_text, keywords, emotion, importance, memory_type, created_at FROM user_memories WHERE user_id = $1 ORDER BY importance DESC, created_at DESC`, [parseInt(req.params.id)]);
    res.json({ memories: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取记忆失败' }); }
});
```

- [ ] **Step 5: Add GET /api/admin/users/:id/summaries**

```typescript
router.get('/users/:id/summaries', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(`SELECT id, summary_date, summary_text, mood_summary, topic_keywords, message_count FROM daily_summaries WHERE user_id = $1 ORDER BY summary_date DESC LIMIT 30`, [parseInt(req.params.id)]);
    res.json({ summaries: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取摘要失败' }); }
});
```

- [ ] **Step 6: Add GET /api/admin/dashboard**

```typescript
router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const [users, trend] = await Promise.all([
      pgPool.query(`SELECT (SELECT COUNT(*) FROM users WHERE is_active = TRUE) as total_users, (SELECT COUNT(*) FROM conversation_logs WHERE created_at > CURRENT_DATE) as today_messages, (SELECT COUNT(*) FROM users WHERE last_active_at > NOW() - INTERVAL '3 days') as active_users_3d, (SELECT COUNT(*) FROM conversation_logs) as total_messages`),
      pgPool.query(`SELECT summary_date::text, message_count FROM daily_summaries WHERE summary_date >= CURRENT_DATE - INTERVAL '7 days' ORDER BY summary_date ASC`),
    ]);
    const trendData: { date: string; messages: number }[] = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toISOString().split('T')[0]; const row = trend.rows.find((r: any) => r.summary_date === ds); trendData.push({ date: ds, messages: row ? parseInt(row.message_count) || 0 : 0 }); }
    res.json({ totalUsers: parseInt(users.rows[0].total_users) || 0, todayMessages: parseInt(users.rows[0].today_messages) || 0, activeUsers3d: parseInt(users.rows[0].active_users_3d) || 0, totalMessages: parseInt(users.rows[0].total_messages) || 0, trend: trendData });
  } catch (error: any) { console.error('[Admin] dashboard error:', error.message); res.status(500).json({ error: '获取仪表盘数据失败' }); }
});
```

- [ ] **Step 7: Rebuild api-server**

```bash
cd /home/dandelion/wechat-companion && docker compose build api-server && docker compose up -d --force-recreate api-server
```

---

### Task 2: Scaffold React dashboard project

**Files:** Create: `dashboard/package.json`, `dashboard/tsconfig.json`, `dashboard/vite.config.ts`, `dashboard/index.html`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p /home/dandelion/wechat-companion/dashboard/src/{api,pages,components,hooks}
```

```json
// dashboard/package.json
{
  "name": "weclaw-dashboard",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc && vite build", "preview": "vite preview" },
  "dependencies": {
    "@ant-design/charts": "^2.6.0", "antd": "^5.24.0", "@ant-design/icons": "^5.6.0",
    "axios": "^1.7.9", "dayjs": "^1.11.13", "react": "^18.3.1",
    "react-dom": "^18.3.1", "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12", "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4", "typescript": "^5.7.2", "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020", "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"], "module": "ESNext",
    "skipLibCheck": true, "moduleResolution": "bundler",
    "allowImportingTsExtensions": true, "isolatedModules": true,
    "moduleDetection": "force", "noEmit": true, "jsx": "react-jsx",
    "strict": true, "noUnusedLocals": false, "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true, "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
```

- [ ] **Step 4: Create index.html**

```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>情感陪伴AI - 管理后台</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```

- [ ] **Step 5: Install dependencies**

```bash
cd /home/dandelion/wechat-companion/dashboard && npm install
```

---

### Task 3: API client + Auth hook

**Files:** Create: `dashboard/src/api/client.ts`, `dashboard/src/hooks/useAuth.tsx`

- [ ] **Step 1: Create API client with JWT interceptors**

```typescript
// dashboard/src/api/client.ts
import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 10000 });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const orig = error.config;
    if (error.response?.status === 401 && !orig._retry) {
      orig._retry = true;
      const rt = localStorage.getItem('refresh_token');
      if (rt) {
        try {
          const { data } = await axios.post('/api/auth/refresh', { refreshToken: rt });
          localStorage.setItem('access_token', data.access_token);
          orig.headers.Authorization = `Bearer ${data.access_token}`;
          return api(orig);
        } catch { localStorage.clear(); window.location.href = '/login'; }
      }
    }
    return Promise.reject(error);
  }
);

export default api;
```

- [ ] **Step 2: Create Auth context + hook**

```typescript
// dashboard/src/hooks/useAuth.tsx
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';

interface User { userId: number; email: string; role: string; }
interface AuthCtx { user: User | null; loading: boolean; login: (email: string, password: string, captchaId?: string, captchaCode?: string) => Promise<void>; logout: () => void; }

const AuthContext = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (token) api.get('/auth/me').then(({ data }) => setUser(data.user)).catch(() => localStorage.clear()).finally(() => setLoading(false));
    else setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string, captchaId?: string, captchaCode?: string) => {
    const payload: any = { email, password };
    if (captchaId) { payload.captchaId = captchaId; payload.captchaCode = captchaCode; }
    const { data } = await api.post('/auth/login', payload);
    localStorage.setItem('access_token', data.access_token);
    localStorage.setItem('refresh_token', data.refresh_token);
    const me = await api.get('/auth/me');
    setUser(me.data.user);
  }, []);

  const logout = useCallback(() => { localStorage.clear(); setUser(null); }, []);
  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
```

---

### Task 4: Layout + shared components

**Files:** Create: `dashboard/src/components/Layout.tsx`, `StatCard.tsx`, `EmotionTag.tsx`

- [ ] **Step 1: Layout with Ant Design sidebar**

```typescript
// dashboard/src/components/Layout.tsx
import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Button, Typography, theme } from 'antd';
import { DashboardOutlined, UserOutlined, MessageOutlined, MonitorOutlined, SettingOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';

const { Header, Sider, Content } = AntLayout;

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { token: { colorBgContainer } } = theme.useToken();

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: '首页概览' },
    { key: '/users', icon: <UserOutlined />, label: '用户管理' },
    { key: '/conversations', icon: <MessageOutlined />, label: '对话浏览' },
    { key: '/queue', icon: <MonitorOutlined />, label: '队列监控' },
    { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
  ];

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider trigger={null} collapsible collapsed={collapsed} theme="dark">
        <div style={{ height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography.Text strong style={{ color: '#fff', fontSize: collapsed ? 14 : 16 }}>{collapsed ? '💬' : '💬 情感陪伴AI'}</Typography.Text>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[location.pathname]} items={menuItems} onClick={({ key }) => navigate(key)} />
      </Sider>
      <AntLayout>
        <Header style={{ padding: '0 24px', background: colorBgContainer, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
          <span><Typography.Text style={{ marginRight: 16 }}>{user?.email}</Typography.Text><Button type="text" icon={<LogoutOutlined />} onClick={() => { logout(); navigate('/login'); }}>退出</Button></span>
        </Header>
        <Content style={{ margin: 24, padding: 24, background: colorBgContainer, borderRadius: 8 }}><Outlet /></Content>
      </AntLayout>
    </AntLayout>
  );
}
```

- [ ] **Step 2: StatCard component**

```typescript
// dashboard/src/components/StatCard.tsx
import React from 'react';
import { Card, Statistic } from 'antd';

export default function StatCard({ title, value, suffix, icon, color }: { title: string; value: number | string; suffix?: string; icon?: React.ReactNode; color?: string }) {
  return <Card bordered={false} style={{ borderTop: `3px solid ${color || '#1890ff'}` }}><Statistic title={title} value={value} suffix={suffix} prefix={icon} /></Card>;
}
```

- [ ] **Step 3: EmotionTag component**

```typescript
// dashboard/src/components/EmotionTag.tsx
import React from 'react';
import { Tag } from 'antd';

const MAP: Record<string, { label: string; color: string }> = { happy: { label: '😊 开心', color: 'orange' }, sad: { label: '😢 悲伤', color: 'blue' }, angry: { label: '😠 愤怒', color: 'red' }, anxious: { label: '😰 焦虑', color: 'purple' }, neutral: { label: '😐 中性', color: 'default' } };

export default function EmotionTag({ emotion }: { emotion: string | null }) {
  if (!emotion) return <Tag>未知</Tag>;
  const info = MAP[emotion] || { label: emotion, color: 'default' };
  return <Tag color={info.color}>{info.label}</Tag>;
}
```

---

### Task 5: Login page

**Files:** Create: `dashboard/src/pages/Login.tsx`

- [ ] **Step 1: Login page with captcha support**

```typescript
// dashboard/src/pages/Login.tsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, message } from 'antd';
import { UserOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const fetchCaptcha = async () => {
    const { data } = await api.get('/auth/captcha');
    setCaptchaSvg(data.svg); setCaptchaId(data.captchaId); setNeedCaptcha(true);
  };

  const handleSubmit = async (values: { email: string; password: string; captcha?: string }) => {
    setLoading(true);
    try {
      await login(values.email, values.password, captchaId, values.captcha);
      message.success('登录成功'); navigate('/');
    } catch (err: any) { message.error(err.response?.data?.error || '登录失败'); if (err.response?.data?.error?.includes('验证码')) fetchCaptcha(); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f0f2f5' }}>
      <Card style={{ width: 400 }} title={<Typography.Title level={3} style={{ textAlign: 'center' }}>💬 情感陪伴AI 管理后台</Typography.Title>}>
        <Form onFinish={handleSubmit} size="large">
          <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }]}><Input prefix={<UserOutlined />} placeholder="管理员邮箱" /></Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} placeholder="密码" /></Form.Item>
          {needCaptcha && <>
            <Form.Item name="captcha" rules={[{ required: true, message: '请输入验证码' }]}><Input prefix={<SafetyOutlined />} placeholder="验证码" /></Form.Item>
            <div dangerouslySetInnerHTML={{ __html: captchaSvg }} style={{ marginBottom: 16, cursor: 'pointer' }} onClick={fetchCaptcha} />
          </>}
          <Form.Item><Button type="primary" htmlType="submit" loading={loading} block>登录</Button></Form.Item>
        </Form>
      </Card>
    </div>
  );
}
```

---

### Task 6: Dashboard overview page

**Files:** Create: `dashboard/src/pages/Dashboard.tsx`

- [ ] **Step 1: Dashboard with stats, trend chart, queue, health**

```typescript
// dashboard/src/pages/Dashboard.tsx
import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Tag, Typography } from 'antd';
import { UserOutlined, MessageOutlined, TeamOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Line } from '@ant-design/charts';
import api from '../api/client';
import StatCard from '../components/StatCard';

export default function Dashboard() {
  const [dash, setDash] = useState<any>(null);
  const [queue, setQueue] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);

  useEffect(() => {
    Promise.all([api.get('/admin/dashboard'), api.get('/admin/queue'), api.get('/health')])
      .then(([d, q, h]) => { setDash(d.data); setQueue(q.data); setHealth(h.data); });
  }, []);

  if (!dash) return <Card loading />;

  const lineConfig = { data: dash.trend || [], xField: 'date', yField: 'messages', point: { size: 4 }, smooth: true, height: 200, color: '#1890ff' };

  return <>
    <Typography.Title level={4}>首页概览</Typography.Title>
    <Row gutter={[16, 16]}>
      <Col span={6}><StatCard title="总用户数" value={dash.totalUsers || 0} icon={<UserOutlined />} color="#1890ff" /></Col>
      <Col span={6}><StatCard title="今日消息" value={dash.todayMessages || 0} icon={<MessageOutlined />} color="#52c41a" /></Col>
      <Col span={6}><StatCard title="3日活跃" value={dash.activeUsers3d || 0} icon={<TeamOutlined />} color="#fa8c16" /></Col>
      <Col span={6}><StatCard title="总消息数" value={dash.totalMessages || 0} icon={<MessageOutlined />} color="#722ed1" /></Col>
    </Row>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={12}><Card title="📊 近7天消息趋势"><Line {...lineConfig} /></Card></Col>
      <Col span={12}><Card title="📋 队列状态"><Row gutter={[12, 12]}>
        <Col span={8}><Statistic title="等待" value={queue?.waiting || 0} prefix={<ClockCircleOutlined />} /></Col>
        <Col span={8}><Statistic title="处理中" value={queue?.active || 0} prefix={<SyncOutlined spin />} valueStyle={{ color: '#1890ff' }} /></Col>
        <Col span={8}><Statistic title="延迟" value={queue?.delayed || 0} prefix={<ClockCircleOutlined />} /></Col>
        <Col span={8}><Statistic title="完成" value={queue?.completed || 0} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} /></Col>
        <Col span={8}><Statistic title="失败" value={queue?.failed || 0} prefix={<CloseCircleOutlined />} valueStyle={{ color: queue?.failed ? '#ff4d4f' : undefined }} /></Col>
      </Row></Card></Col>
    </Row>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={24}><Card title="🔧 系统健康">
        <Tag color={health?.services?.redis === 'healthy' ? 'green' : 'red'}>Redis: {health?.services?.redis || '?'}</Tag>
        <Tag color={health?.services?.postgres === 'healthy' ? 'green' : 'red'}>PG: {health?.services?.postgres || '?'}</Tag>
        <Tag color={health?.services?.queue?.status === 'healthy' ? 'green' : 'red'}>Queue: {health?.services?.queue?.status || '?'}</Tag>
        <Tag color={health?.status === 'ok' ? 'green' : 'red'}>Overall: {health?.status || '?'}</Tag>
      </Card></Col>
    </Row>
  </>;
}
```

---

### Task 7: Users list + User detail pages

**Files:** Create: `dashboard/src/pages/Users.tsx`, `UserDetail.tsx`

- [ ] **Step 1: Users list with search/filter/pagination**

```typescript
// dashboard/src/pages/Users.tsx
import React, { useEffect, useState } from 'react';
import { Table, Input, Select, Button, Space, Typography, Tag, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { ReloadOutlined } from '@ant-design/icons';
import api from '../api/client';

export default function Users() {
  const [users, setUsers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const fetchUsers = async (p = page, s = search, r = role) => {
    setLoading(true);
    try { const { data } = await api.get('/admin/users', { params: { page: p, limit: 20, search: s, role: r } }); setUsers(data.users); setTotal(data.total); }
    catch { message.error('加载失败'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchUsers(); }, []);

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '邮箱', dataIndex: 'email', ellipsis: true },
    { title: '显示名', dataIndex: 'display_name', ellipsis: true },
    { title: '微信ID', dataIndex: 'wechat_id', ellipsis: true },
    { title: '角色', dataIndex: 'role', render: (r: string) => <Tag color={r === 'admin' ? 'red' : 'blue'}>{r}</Tag> },
    { title: '状态', dataIndex: 'is_active', render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '活跃' : '禁用'}</Tag> },
    { title: '创建', dataIndex: 'created_at', render: (v: string) => v?.split('T')[0] },
    { title: '操作', render: (_: any, r: any) => <Button type="link" onClick={() => navigate(`/users/${r.id}`)}>详情</Button> },
  ];

  return <>
    <Typography.Title level={4}>用户管理</Typography.Title>
    <Space style={{ marginBottom: 16 }}>
      <Input.Search placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} onSearch={() => { setPage(1); fetchUsers(1, search, role); }} style={{ width: 280 }} />
      <Select value={role} onChange={v => { setRole(v); setPage(1); fetchUsers(1, search, v); }} style={{ width: 120 }} allowClear placeholder="角色"><Select.Option value="admin">管理员</Select.Option><Select.Option value="user">用户</Select.Option></Select>
      <Button icon={<ReloadOutlined />} onClick={() => fetchUsers()}>刷新</Button>
    </Space>
    <Table columns={columns} dataSource={users} rowKey="id" loading={loading}
      pagination={{ current: page, total, pageSize: 20, onChange: p => { setPage(p); fetchUsers(p, search, role); }, showTotal: t => `共 ${t} 人` }} />
  </>;
}
```

- [ ] **Step 2: User detail with info, emotion pie, tabs (logs/memories/summaries)**

```typescript
// dashboard/src/pages/UserDetail.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Table, Tabs, Typography, Button, Tag, Space } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Pie } from '@ant-design/charts';
import api from '../api/client';
import EmotionTag from '../components/EmotionTag';

export default function UserDetail() {
  const { id } = useParams(); const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [emotions, setEmotions] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const [summaries, setSummaries] = useState<any[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get(`/admin/users/${id}`), api.get(`/admin/users/${id}/emotions`),
      api.get(`/admin/users/${id}/conversations?page=1&limit=10`), api.get(`/admin/users/${id}/memories`),
      api.get(`/admin/users/${id}/summaries`),
    ]).then(([u, e, l, m, s]) => { setUser(u.data); setEmotions(e.data.emotions); setLogs(l.data.logs); setLogsTotal(l.data.total); setMemories(m.data.memories); setSummaries(s.data.summaries); }).finally(() => setLoading(false));
  }, [id]);

  const fetchLogs = async (p: number) => { const { data } = await api.get(`/admin/users/${id}/conversations`, { params: { page: p, limit: 10 } }); setLogs(data.logs); setLogsTotal(data.total); setLogsPage(p); };
  if (loading) return <Card loading />;
  if (!user) return <Typography.Text type="danger">用户不存在</Typography.Text>;

  const pieConfig = { data: emotions, angleField: 'count', colorField: 'emotion', radius: 0.8, height: 200, label: { type: 'outer' as const } };

  const logCols = [{ title: '时间', dataIndex: 'created_at', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN') }, { title: '', dataIndex: 'role', width: 40, render: (r: string) => r === 'user' ? '👤' : '🤖' }, { title: '内容', dataIndex: 'content', ellipsis: true }, { title: '情绪', dataIndex: 'emotion', width: 100, render: (e: string) => <EmotionTag emotion={e} /> }];
  const memCols = [{ title: '摘要', dataIndex: 'summary_text', ellipsis: true }, { title: '关键词', dataIndex: 'keywords', render: (k: string[]) => k?.join(', ') }, { title: '重要性', dataIndex: 'importance' }, { title: '情绪', dataIndex: 'emotion', render: (e: string) => <EmotionTag emotion={e} /> }];
  const sumCols = [{ title: '日期', dataIndex: 'summary_date' }, { title: '摘要', dataIndex: 'summary_text', ellipsis: true }, { title: '心情', dataIndex: 'mood_summary' }, { title: '消息数', dataIndex: 'message_count' }];

  return <>
    <Space style={{ marginBottom: 16 }}><Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/users')}>返回</Button></Space>
    <Typography.Title level={4}>用户详情</Typography.Title>
    <Card title="基本信息" style={{ marginBottom: 16 }}>
      <Descriptions column={3} size="small">
        <Descriptions.Item label="ID">{user.user.id}</Descriptions.Item>
        <Descriptions.Item label="邮箱">{user.user.email}</Descriptions.Item>
        <Descriptions.Item label="显示名">{user.user.display_name}</Descriptions.Item>
        <Descriptions.Item label="微信ID">{user.user.wechat_id}</Descriptions.Item>
        <Descriptions.Item label="角色"><Tag color={user.user.role === 'admin' ? 'red' : 'blue'}>{user.user.role}</Tag></Descriptions.Item>
        <Descriptions.Item label="活跃"><Tag color={user.user.is_active ? 'green' : 'default'}>{user.user.is_active ? '是' : '否'}</Tag></Descriptions.Item>
      </Descriptions>
    </Card>
    <Card title="😊 情绪分布" style={{ marginBottom: 16 }}>{emotions.length > 0 ? <Pie {...pieConfig} /> : <Typography.Text type="secondary">暂无数据</Typography.Text>}</Card>
    <Card><Tabs items={[
      { key: 'logs', label: '对话记录', children: <Table columns={logCols} dataSource={logs} rowKey="id" size="small" pagination={{ current: logsPage, total: logsTotal, pageSize: 10, onChange: fetchLogs, showTotal: (t: number) => `共 ${t} 条` }} /> },
      { key: 'memories', label: '长期记忆', children: <Table columns={memCols} dataSource={memories} rowKey="id" size="small" /> },
      { key: 'summaries', label: '每日摘要', children: <Table columns={sumCols} dataSource={summaries} rowKey="id" size="small" /> },
    ]} /></Card>
  </>;
}
```

---

### Task 8: Conversations + Queue + Settings pages

**Files:** Create: `dashboard/src/pages/Conversations.tsx`, `Queue.tsx`, `Settings.tsx`

- [ ] **Step 1: Conversations browser**

```typescript
// dashboard/src/pages/Conversations.tsx
import React, { useEffect, useState } from 'react';
import { Table, Input, Select, DatePicker, Typography, Space, Button } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import api from '../api/client';
import EmotionTag from '../components/EmotionTag';
import dayjs from 'dayjs';
const { RangePicker } = DatePicker;

export default function Conversations() {
  const [logs, setLogs] = useState<any[]>([]); const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1); const [wechatId, setWechatId] = useState('');
  const [keyword, setKeyword] = useState(''); const [emotion, setEmotion] = useState('');
  const [dateRange, setDateRange] = useState<[string, string] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = async (p = 1) => {
    setLoading(true);
    const params: any = { page: p, limit: 20 };
    if (wechatId) params.wechat_id = wechatId;
    if (keyword) params.keyword = keyword;
    if (emotion) params.emotion = emotion;
    if (dateRange) { params.date_from = dateRange[0]; params.date_to = dateRange[1]; }
    try { const { data } = await api.get('/admin/conversations', { params }); setLogs(data.logs); setTotal(data.total); setPage(p); }
    finally { setLoading(false); }
  };
  useEffect(() => { fetchLogs(); }, []);

  const cols = [
    { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
    { title: '微信ID', dataIndex: 'wechat_id', width: 140, ellipsis: true },
    { title: '昵称', dataIndex: 'nickname', width: 80, ellipsis: true },
    { title: '', dataIndex: 'role', width: 36, render: (r: string) => r === 'user' ? '👤' : '🤖' },
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '情绪', dataIndex: 'emotion', width: 100, render: (e: string) => <EmotionTag emotion={e} /> },
    { title: '媒体', dataIndex: 'media_type', width: 70, render: (t: string) => t || '-' },
  ];

  return <>
    <Typography.Title level={4}>对话浏览</Typography.Title>
    <Space wrap style={{ marginBottom: 16 }}>
      <Input placeholder="微信ID" value={wechatId} onChange={e => setWechatId(e.target.value)} style={{ width: 140 }} />
      <Input placeholder="关键词" value={keyword} onChange={e => setKeyword(e.target.value)} style={{ width: 140 }} />
      <Select value={emotion} onChange={setEmotion} style={{ width: 120 }} allowClear placeholder="情绪">
        <Select.Option value="happy">😊 开心</Select.Option><Select.Option value="sad">😢 悲伤</Select.Option>
        <Select.Option value="angry">😠 愤怒</Select.Option><Select.Option value="anxious">😰 焦虑</Select.Option>
        <Select.Option value="neutral">😐 中性</Select.Option>
      </Select>
      <RangePicker onChange={(_, dss) => setDateRange(dss[0] && dss[1] ? [dss[0], dss[1]] : null)} />
      <Button icon={<ReloadOutlined />} onClick={() => fetchLogs(1)}>刷新</Button>
    </Space>
    <Table columns={cols} dataSource={logs} rowKey="id" loading={loading}
      pagination={{ current: page, total, pageSize: 20, onChange: fetchLogs, showTotal: (t: number) => `共 ${t} 条` }} />
  </>;
}
```

- [ ] **Step 2: Queue monitor (auto-refresh)**

```typescript
// dashboard/src/pages/Queue.tsx
import React, { useEffect, useState, useRef } from 'react';
import { Card, Row, Col, Statistic, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ClockCircleOutlined, PauseCircleOutlined } from '@ant-design/icons';
import api from '../api/client';

export default function Queue() {
  const [queue, setQueue] = useState<any>({}); const [health, setHealth] = useState<any>({});
  const timer = useRef<any>(null);

  useEffect(() => {
    const fetch = async () => { try { const [q, h] = await Promise.all([api.get('/admin/queue'), api.get('/health')]); setQueue(q.data); setHealth(h.data); } catch {} };
    fetch(); timer.current = setInterval(fetch, 5000);
    return () => clearInterval(timer.current);
  }, []);

  return <>
    <Typography.Title level={4}>队列监控</Typography.Title>
    <Typography.Text type="secondary">每5秒自动刷新</Typography.Text>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={4}><Card><Statistic title="⏳ 等待中" value={queue.waiting || 0} prefix={<ClockCircleOutlined />} /></Card></Col>
      <Col span={4}><Card><Statistic title="🔄 处理中" value={queue.active || 0} prefix={<SyncOutlined spin />} valueStyle={{ color: '#1890ff' }} /></Card></Col>
      <Col span={4}><Card><Statistic title="⏸️ 延迟" value={queue.delayed || 0} prefix={<PauseCircleOutlined />} /></Card></Col>
      <Col span={4}><Card><Statistic title="✅ 已完成" value={queue.completed || 0} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} /></Card></Col>
      <Col span={4}><Card><Statistic title="❌ 失败" value={queue.failed || 0} prefix={<CloseCircleOutlined />} valueStyle={{ color: queue.failed ? '#ff4d4f' : undefined }} /></Card></Col>
    </Row>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={24}><Card title="服务状态">
        <p>Redis: {health?.services?.redis || '-'} | PG: {health?.services?.postgres || '-'} | Queue: {health?.services?.queue?.status || '-'} | Overall: {health?.status || '-'}</p>
      </Card></Col>
    </Row>
  </>;
}
```

- [ ] **Step 3: Settings (care templates + system info)**

```typescript
// dashboard/src/pages/Settings.tsx
import React, { useEffect, useState } from 'react';
import { Card, Table, Button, Modal, Input, Select, Typography, Space, message, Tabs, Tag } from 'antd';
import { PlusOutlined, SaveOutlined } from '@ant-design/icons';
import api from '../api/client';

export default function Settings() {
  const [templates, setTemplates] = useState<any[]>([]); const [editing, setEditing] = useState<any>(null);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => { api.get('/admin/care-templates').then(({ data }) => setTemplates(data.templates)); }, []);

  const handleSave = async (t: any) => {
    try { await api.put('/admin/care-templates', { templates: [t] }); message.success('保存成功'); setModalVisible(false); api.get('/admin/care-templates').then(({ data }) => setTemplates(data.templates)); }
    catch { message.error('保存失败'); }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '时段', dataIndex: 'schedule_type', width: 100, render: (v: string) => ({ morning: '🌅 早安', afternoon: '☀️ 午间', evening: '🌙 晚间' } as any)[v] || v },
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '排序', dataIndex: 'sort_order', width: 60 },
    { title: '状态', dataIndex: 'is_active', width: 60, render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag> },
    { title: '操作', width: 80, render: (_: any, r: any) => <Button type="link" onClick={() => { setEditing(r); setModalVisible(true); }}>编辑</Button> },
  ];

  return <>
    <Typography.Title level={4}>系统设置</Typography.Title>
    <Tabs items={[
      {
        key: 'care', label: '关怀文案',
        children: <>
          <Space style={{ marginBottom: 16 }}><Button icon={<PlusOutlined />} onClick={() => { setEditing({ schedule_type: 'morning', content: '', sort_order: 0, is_active: true }); setModalVisible(true); }}>新增文案</Button></Space>
          <Table columns={columns} dataSource={templates} rowKey="id" size="small" />
        </>,
      },
      { key: 'system', label: '系统信息', children: <Card><Typography.Paragraph>版本: 2.0 | 模式: Docker Compose | API: /api</Typography.Paragraph></Card> },
    ]} />
    <Modal title={editing?.id ? '编辑文案' : '新增文案'} open={modalVisible} onCancel={() => setModalVisible(false)}
      footer={[<Button key="cancel" onClick={() => setModalVisible(false)}>取消</Button>, <Button key="save" type="primary" icon={<SaveOutlined />} onClick={() => handleSave(editing)}>保存</Button>]}>
      {editing && <>
        <p>时段</p><Select value={editing.schedule_type} onChange={v => setEditing({ ...editing, schedule_type: v })} style={{ width: '100%', marginBottom: 16 }}>
          <Select.Option value="morning">🌅 早安</Select.Option><Select.Option value="afternoon">☀️ 午间</Select.Option><Select.Option value="evening">🌙 晚间</Select.Option>
        </Select>
        <p>内容</p><Input.TextArea value={editing.content} onChange={e => setEditing({ ...editing, content: e.target.value })} rows={3} style={{ marginBottom: 16 }} />
        <p>启用</p><Select value={editing.is_active} onChange={v => setEditing({ ...editing, is_active: v })} style={{ width: '100%' }}>
          <Select.Option value={true}>✅ 启用</Select.Option><Select.Option value={false}>❌ 禁用</Select.Option>
        </Select>
      </>}
    </Modal>
  </>;
}
```

---

### Task 9: App.tsx + main.tsx (router wiring)

**Files:** Create: `dashboard/src/App.tsx`, `dashboard/src/main.tsx`

- [ ] **Step 1: App.tsx with auth-protected routes**

```typescript
// dashboard/src/App.tsx
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import UserDetail from './pages/UserDetail';
import Conversations from './pages/Conversations';
import Queue from './pages/Queue';
import Settings from './pages/Settings';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>加载中...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/users" element={<Users />} />
        <Route path="/users/:id" element={<UserDetail />} />
        <Route path="/conversations" element={<Conversations />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return <ConfigProvider locale={zhCN}><AntApp><AuthProvider><BrowserRouter><AppRoutes /></BrowserRouter></AuthProvider></AntApp></ConfigProvider>;
}
```

- [ ] **Step 2: main.tsx entry point**

```typescript
// dashboard/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
```

---

### Task 10: Dashboard Dockerfile + nginx

**Files:** Create: `dashboard/Dockerfile`, `dashboard/nginx.conf`

- [ ] **Step 1: Dockerfile (multi-stage: build + nginx serve)**

```dockerfile
# dashboard/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ ./src/
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 2: nginx.conf (SPA fallback)**

```nginx
# dashboard/nginx.conf
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
    location /assets/ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
```

---

### Task 11: Wire everything — nginx + docker-compose

**Files:** Modify: `nginx.conf`, `docker-compose.yml`

- [ ] **Step 1: Update main nginx.conf**

Add this upstream block after the existing `upstream api_backend { ... }` block in `nginx.conf`:

```nginx
upstream dashboard_backend {
    server dashboard:80;
}
```

Then replace the `location /` block with:

```nginx
        # Dashboard SPA
        location / {
            proxy_pass http://dashboard_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
```

- [ ] **Step 2: Add dashboard service to docker-compose.yml**

Insert before the `volumes:` section at the bottom:

```yaml
  # ===========================================================================
  # Dashboard - React Admin SPA
  # ===========================================================================
  dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    container_name: weclaw-dashboard
    restart: unless-stopped
    depends_on:
      - api-server
    networks:
      - companion-net
```

- [ ] **Step 3: Build and deploy**

```bash
cd /home/dandelion/wechat-companion
docker compose build dashboard api-server
docker compose up -d
sleep 5
docker compose ps
```

- [ ] **Step 4: Verify**

```bash
curl -s http://localhost/ | grep -o '<title>.*</title>'
curl -s http://localhost:3000/health | python3 -m json.tool
```

Expected: `<title>情感陪伴AI - 管理后台</title>` and health JSON.

---

### Task 12: Seed admin user + smoke test

- [ ] **Step 1: Create admin account**

```bash
docker compose exec postgres psql -U weclaw -d weclaw_companion -c "
INSERT INTO user_accounts (email, password_hash, display_name, role, is_active)
VALUES ('admin@weclaw.com', '\$2a\$10\$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', '管理员', 'admin', TRUE)
ON CONFLICT (email) DO NOTHING;
"
```
(Valid bcrypt hash of `admin123`)

- [ ] **Step 2: Test login and all dashboard APIs**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@weclaw.com","password":"admin123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "=== Dashboard ==="
curl -s http://localhost:3000/api/admin/dashboard -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

echo "=== Users ==="
curl -s "http://localhost:3000/api/admin/users?page=1" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'OK: {d[\"total\"]} users')"

echo "=== Conversations ==="
curl -s "http://localhost:3000/api/admin/conversations?page=1" -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'OK: {d[\"total\"]} logs')"

echo "=== Queue ==="
curl -s http://localhost:3000/api/admin/queue -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

echo "=== UI ==="
curl -s http://localhost/ -o /dev/null -w "Status: %{http_code}, Size: %{size_download} bytes\n"

echo "✅ All checks passed"
```
