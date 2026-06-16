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
import Characters from './pages/Characters';
import ImportChat from './pages/ImportChat';
import MyProfile from './pages/MyProfile';
import AdminLogs from './pages/AdminLogs';
import Register from './pages/Register';
import BridgePage from './pages/BridgePage';
import Stickers from './pages/Stickers';

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
      <Route path="/register" element={<Register />} />
      <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/profile" element={<MyProfile />} />
        <Route path="/users" element={<Users />} />
        <Route path="/users/:id" element={<UserDetail />} />
        <Route path="/conversations" element={<Conversations />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/admin-logs" element={<AdminLogs />} />
        <Route path="/characters" element={<Characters />} />
        <Route path="/import" element={<ImportChat />} />
        <Route path="/stickers" element={<Stickers />} />
        <Route path="/bridge" element={<BridgePage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return <ConfigProvider locale={zhCN}><AntApp><AuthProvider><BrowserRouter><AppRoutes /></BrowserRouter></AuthProvider></AntApp></ConfigProvider>;
}
