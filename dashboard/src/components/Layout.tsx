import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Button, Typography, theme, Drawer, Grid } from 'antd';
import { DashboardOutlined, UserOutlined, MessageOutlined, MonitorOutlined, SettingOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MenuOutlined, SmileOutlined, LinkOutlined, ImportOutlined, PictureOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';

const { Header, Sider, Content } = AntLayout;
const { useBreakpoint } = Grid;

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { token: { colorBgContainer } } = theme.useToken();
  const screens = useBreakpoint();

  const isMobile = !screens.md; // <768px
  const isTablet = screens.md && !screens.lg; // 768-1024px

  // 平板自动折叠侧边栏
  useEffect(() => {
    if (isTablet) setCollapsed(true);
  }, [isTablet]);

  const commonItems = [
    { key: '/', icon: <DashboardOutlined />, label: '首页概览' },
    { key: '/profile', icon: <UserOutlined />, label: '我的' },
    { key: '/characters', icon: <SmileOutlined />, label: '角色管理' },
    { key: '/persona', icon: <SmileOutlined />, label: '人格调校' },
    { key: '/bridge', icon: <LinkOutlined />, label: '微信桥接' },
    { key: '/import', icon: <ImportOutlined />, label: '聊天导入' },
    { key: '/stickers', icon: <PictureOutlined />, label: '表情包' },
  ];
  const adminItems = user?.role === 'admin' ? [
    { key: '/users', icon: <UserOutlined />, label: '用户管理' },
    { key: '/conversations', icon: <MessageOutlined />, label: '对话浏览' },
    { key: '/queue', icon: <MonitorOutlined />, label: '队列监控' },
    { key: '/admin-logs', icon: <SettingOutlined />, label: '操作日志' },
    { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
  ] : [];
  const menuItems = [...commonItems, ...adminItems];

  const handleMenuClick = (key: string) => {
    navigate(key);
    if (isMobile) setMobileDrawerOpen(false);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // 桌面/平板：Sider + Header 布局
  const desktopHeader = (
    <Header style={{ padding: '0 16px', background: colorBgContainer, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Button type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typography.Text style={{ fontSize: 14 }} ellipsis={{ tooltip: user?.email }}>{user?.email}</Typography.Text>
        <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout}>退出</Button>
      </span>
    </Header>
  );

  // 手机端：Drawer 菜单 + 简约顶栏
  const mobileHeader = (
    <Header style={{ padding: '0 12px', background: colorBgContainer, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Button type="text" icon={<MenuOutlined />} onClick={() => setMobileDrawerOpen(true)} />
      <Typography.Text strong>💬 情感陪伴AI</Typography.Text>
      <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout} />
    </Header>
  );

  const menuComponent = (
    <Menu
      theme={isMobile ? "light" : "dark"}
      mode="inline"
      selectedKeys={[location.pathname]}
      items={menuItems}
      onClick={({ key }) => handleMenuClick(key)}
    />
  );

  // 响应式内容区缩进
  const contentMargin = isMobile ? 8 : 24;
  const contentPadding = isMobile ? 12 : 24;

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      {!isMobile && (
        <Sider trigger={null} collapsible collapsed={collapsed} theme="dark" width={220}>
          <div style={{ height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Typography.Text strong style={{ color: '#fff', fontSize: collapsed ? 14 : 16 }}>
              {collapsed ? '💬' : '💬 情感陪伴AI'}
            </Typography.Text>
          </div>
          {menuComponent}
        </Sider>
      )}

      {/* 手机端：Drawer 菜单 */}
      <Drawer
        title="💬 情感陪伴AI"
        placement="left"
        onClose={() => setMobileDrawerOpen(false)}
        open={mobileDrawerOpen}
        width={260}
        styles={{ body: { padding: 0 } }}
      >
        {menuComponent}
      </Drawer>

      <AntLayout>
        {isMobile ? mobileHeader : desktopHeader}
        <Content style={{
          margin: contentMargin,
          padding: contentPadding,
          background: colorBgContainer,
          borderRadius: 8,
          overflow: 'auto',
        }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
