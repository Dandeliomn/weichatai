# Admin Dashboard Design Spec

**Date:** 2026-06-08
**Project:** wechat-companion 微信情感陪伴AI平台
**Status:** Draft

---

## 1. Overview

Add a management dashboard UI to the wechat-companion platform. The dashboard provides user management, conversation browsing, queue monitoring, and system configuration through a React SPA served via a dedicated Docker container.

---

## 2. Architecture

### 2.1 Container Topology

```
Browser → Nginx:80
            ├── /api/*     → proxy → api-server:3000 (Express API)
            ├── /webhook   → proxy → api-server:3000
            ├── /health    → proxy → api-server:3000
            └── /*         → proxy → dashboard:80 (React SPA)

New container: weclaw-dashboard
  - nginx:alpine serving React build output
  - Internal port 80, no host port exposed (proxied via main nginx)
```

### 2.2 Directory Structure

```
wechat-companion/
├── docker-compose.yml         # + dashboard service
├── nginx.conf                 # update: /* → dashboard upstream
├── dashboard/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/               # Axios client + API functions
│       │   └── client.ts
│       ├── pages/
│       │   ├── Login.tsx
│       │   ├── Dashboard.tsx      # Overview
│       │   ├── Users.tsx          # User list
│       │   ├── UserDetail.tsx     # User detail
│       │   ├── Conversations.tsx  # Global conversation browser
│       │   ├── Queue.tsx          # Queue monitor
│       │   └── Settings.tsx       # Care templates + config
│       ├── components/
│       │   ├── Layout.tsx         # Sidebar + header shell
│       │   ├── StatCard.tsx       # Metric card
│       │   └── EmotionTag.tsx     # Emotion badge
│       └── hooks/
│           └── useAuth.tsx        # Auth context + JWT management
```

---

## 3. Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Framework | React 18 + TypeScript | Consistent with existing TS codebase |
| Build | Vite 5 | Fast dev HMR, simple config |
| UI Kit | Ant Design 5 | Rich Chinese-friendly admin components |
| Charts | @ant-design/charts (G2-based) | Integrated with Ant Design |
| Routing | React Router v6 | Standard SPA routing |
| HTTP | Axios | Interceptors for JWT refresh |
| Container | nginx:alpine | Serve static files, same as main nginx |

---

## 4. Pages

### 4.1 Login (`/login`)
- Email + password form
- Captcha support (reuse existing `/api/auth/captcha` endpoint)
- Store JWT access_token + refresh_token in localStorage
- Redirect to `/` on success

### 4.2 Dashboard Overview (`/`)
- 4 stat cards: Total Users, Today Messages, Active Users (3d), Online Status
- Queue status panel: waiting / active / completed / failed counts
- System health indicators: Redis / PostgreSQL / Queue (green/red dots)
- 7-day message trend line chart (from daily_summaries)

### 4.3 User List (`/users`)
- Paginated table: ID, Display Name, WeChat ID, Role, Active, Last Login, Created
- Search by email / display name / wechat_id
- Filter by role (admin/user)
- Click row → `/users/:id`

### 4.4 User Detail (`/users/:id`)
- Basic info card + emotion distribution pie chart
- Conversation timeline (paginated, scrollable)
- Long-term memories table (keywords, summary, importance)
- Daily summaries list

### 4.5 Conversations (`/conversations`)
- Global search: filter by wechat_id / keyword / emotion / date range
- Paginated table with timestamp, user, role, content preview, emotion badge

### 4.6 Queue Monitor (`/queue`)
- Real-time stats: waiting / active / completed / failed / delayed
- Auto-refresh every 5 seconds
- Queue health indicator

### 4.7 Settings (`/settings`)
- Care templates editor: Morning / Afternoon / Evening message lists
- System config view (read-only for now)

---

## 5. API Integration

### 5.1 Auth Flow
```
POST /api/auth/login         → { access_token, refresh_token }
POST /api/auth/refresh       → { access_token }
GET  /api/auth/captcha       → { svg, captchaId }
```

### 5.2 Admin Endpoints (all require Bearer token + admin role)
```
GET    /api/admin/users?page=&limit=&search=&role=
GET    /api/admin/users/:id
PUT    /api/admin/users/:id
DELETE /api/admin/users/:id
GET    /api/admin/stats         ← needs enhancement for dashboard metrics
GET    /api/admin/queue
GET    /api/admin/care-templates
PUT    /api/admin/care-templates
```

### 5.3 New / Enhanced Endpoints Needed
- `GET /api/admin/dashboard` — aggregated stats: total_users, today_messages, active_users_3d, message_trend_7d
- `GET /api/admin/conversations?wechat_id=&keyword=&emotion=&date_from=&date_to=&page=&limit=` — global conversation search
- `GET /api/admin/users/:id/emotions` — emotion distribution for user detail
- `GET /api/admin/users/:id/conversations?page=&limit=` — paginated conversations for one user
- `GET /api/admin/users/:id/memories` — memories for one user
- `GET /api/admin/users/:id/summaries` — daily summaries for one user

These are thin wrappers over existing PostgreSQL tables. The data is already being collected by the worker and care scheduler.

---

## 6. Nginx Routing

```nginx
# Main nginx.conf changes:
upstream dashboard_backend {
    server dashboard:80;
}

location / {
    proxy_pass http://dashboard_backend;
    proxy_set_header Host $host;
}

location /api/ {
    proxy_pass http://api_backend;   # unchanged
}
# /health, /webhook, /stats unchanged
```

---

## 7. Docker Compose Changes

```yaml
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

---

## 8. Scope / Non-Goals

**In scope:**
- All 7 pages listed above
- JWT login + logout
- Chart rendering for trend/emotion data
- Auto-refresh on queue page
- New/updated admin API routes on Express side

**Out of scope (v2):**
- Role-based access beyond admin/user
- Real-time WebSocket updates
- Dark mode
- i18n
- Mobile responsive design

---

## 9. Data Flow

```
User opens / → React Router loads Dashboard page
  → useEffect calls GET /api/admin/dashboard (Bearer token in header)
  → Express validates JWT, checks admin role
  → PostgreSQL queries return aggregated data
  → React renders stat cards + charts

User goes to /users
  → Table component fetches GET /api/admin/users?page=1&limit=20
  → Pagination triggers re-fetch
  → Click row → navigate to /users/:id
  → UserDetail fetches 4 endpoints in parallel
```

---

## 10. Self-Review

- ✅ No placeholders or TBDs
- ✅ Backend changes are additive (new routes, no existing route changes)
- ✅ Frontend is fully isolated in `dashboard/` directory
- ✅ No breaking changes to existing Docker Compose services
- ✅ All data already exists in PostgreSQL tables
