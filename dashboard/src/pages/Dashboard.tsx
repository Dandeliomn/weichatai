import React, { useEffect, useState } from 'react';
import { Row, Col, Card, Statistic, Tag, Typography } from 'antd';
import { UserOutlined, MessageOutlined, TeamOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ClockCircleOutlined } from '@ant-design/icons';
import axios from 'axios';
import api from '../api/client';
import StatCard from '../components/StatCard';

export default function Dashboard() {
  const [dash, setDash] = useState<any>(null);
  const [queue, setQueue] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get('/admin/dashboard'), api.get('/admin/queue'), axios.get('/health')])
      .then(([d, q, h]) => { setDash(d.data); setQueue(q.data); setHealth(h.data); })
      .catch((err: any) => { console.error('Dashboard load error:', err); setError(err.message || '加载失败'); });
  }, []);

  if (error) return <Card><Typography.Text type="danger">加载失败: {error}</Typography.Text></Card>;
  if (!dash) return <Card loading />;

  // Simple bar chart for 7-day trend
  const maxVal = Math.max(...dash.trend.map((t: any) => t.messages), 1);

  return <>
    <Typography.Title level={4}>首页概览</Typography.Title>
    <Row gutter={[16, 16]}>
      <Col span={6}><StatCard title="总用户数" value={dash.totalUsers || 0} icon={<UserOutlined />} color="#1890ff" /></Col>
      <Col span={6}><StatCard title="今日消息" value={dash.todayMessages || 0} icon={<MessageOutlined />} color="#52c41a" /></Col>
      <Col span={6}><StatCard title="3日活跃" value={dash.activeUsers3d || 0} icon={<TeamOutlined />} color="#fa8c16" /></Col>
      <Col span={6}><StatCard title="总消息数" value={dash.totalMessages || 0} icon={<MessageOutlined />} color="#722ed1" /></Col>
    </Row>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={12}>
        <Card title="📊 近7天消息趋势">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 160, padding: '8px 0' }}>
            {dash.trend.map((t: any) => (
              <div key={t.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                <Typography.Text style={{ fontSize: 11, marginBottom: 4 }}>{t.messages}</Typography.Text>
                <div style={{ width: '100%', maxWidth: 40, height: `${Math.max((t.messages / maxVal) * 120, 2)}px`, background: '#1890ff', borderRadius: '4px 4px 0 0', minHeight: 2 }} />
                <Typography.Text style={{ fontSize: 10, marginTop: 4, color: '#999' }}>{t.date.slice(5)}</Typography.Text>
              </div>
            ))}
          </div>
        </Card>
      </Col>
      <Col span={12}><Card title="📋 队列状态"><Row gutter={[12, 12]}>
        <Col span={8}><Statistic title="等待" value={queue?.waiting || 0} prefix={<ClockCircleOutlined />} /></Col>
        <Col span={8}><Statistic title="处理中" value={queue?.active || 0} prefix={<SyncOutlined spin={queue?.active > 0} />} valueStyle={{ color: queue?.active > 0 ? '#1890ff' : undefined }} /></Col>
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
