import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Descriptions, Table, Tabs, Typography, Button, Tag, Space, Progress, Select, message } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';
import EmotionTag from '../components/EmotionTag';

const EMOTION_COLORS: Record<string, string> = { happy: '#fa8c16', sad: '#1890ff', angry: '#f5222d', anxious: '#722ed1', neutral: '#8c8c8c' };
const EMOTION_LABELS: Record<string, string> = { happy: '😊 开心', sad: '😢 悲伤', angry: '😠 愤怒', anxious: '😰 焦虑', neutral: '😐 中性' };

export default function UserDetail() {
  const { id } = useParams(); const navigate = useNavigate();
  const { user: adminUser } = useAuth();
  const [user, setUser] = useState<any>(null);
  const [membership, setMembership] = useState(1);
  const [emotions, setEmotions] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [memories, setMemories] = useState<any[]>([]);
  const [summaries, setSummaries] = useState<any[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const tiers: any = { 1: '🌱 体验', 2: '⭐ 普通', 3: '💎 高级', 4: '👑 至尊' };
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get(`/admin/users/${id}`), api.get(`/admin/users/${id}/emotions`),
      api.get(`/admin/users/${id}/conversations?page=1&limit=10`), api.get(`/admin/users/${id}/memories`),
      api.get(`/admin/users/${id}/summaries`),
    ]).then(([u, e, l, m, s]) => { setUser(u.data); setEmotions(e.data.emotions); setLogs(l.data.logs); setLogsTotal(l.data.total); setMemories(m.data.memories); setSummaries(s.data.summaries); setMembership(u.data.user?.membership || 1); })
      .catch((err: any) => { console.error('UserDetail load error:', err); setError(err.message || '加载失败'); })
      .finally(() => setLoading(false));
  }, [id]);

  const fetchLogs = async (p: number) => {
    try { const { data } = await api.get(`/admin/users/${id}/conversations`, { params: { page: p, limit: 10 } }); setLogs(data.logs); setLogsTotal(data.total); setLogsPage(p); }
    catch { /* silent */ }
  };

  if (error) return <Card><Typography.Text type="danger">加载失败: {error}</Typography.Text></Card>;
  if (loading) return <Card loading />;
  if (!user) return <Typography.Text type="danger">用户不存在</Typography.Text>;

  const total = emotions.reduce((s: number, e: any) => s + parseInt(e.count), 0) || 1;

  const logCols = [
    { title: '时间', dataIndex: 'created_at', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    { title: '', dataIndex: 'role', width: 40, render: (r: string) => r === 'user' ? '👤' : '🤖' },
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '情绪', dataIndex: 'emotion', width: 100, render: (e: string) => <EmotionTag emotion={e} /> },
  ];
  const memCols = [
    { title: '摘要', dataIndex: 'summary_text', ellipsis: true },
    { title: '关键词', dataIndex: 'keywords', render: (k: string[]) => k?.join(', ') },
    { title: '重要性', dataIndex: 'importance' },
    { title: '情绪', dataIndex: 'emotion', render: (e: string) => <EmotionTag emotion={e} /> },
  ];
  const sumCols = [
    { title: '日期', dataIndex: 'summary_date' },
    { title: '摘要', dataIndex: 'summary_text', ellipsis: true },
    { title: '心情', dataIndex: 'mood_summary' },
    { title: '消息数', dataIndex: 'message_count' },
  ];

  return <>
    <Space style={{ marginBottom: 16 }}><Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/users')}>返回</Button></Space>
    <Typography.Title level={4}>用户详情</Typography.Title>
    <Card title="基本信息" style={{ marginBottom: 16 }}>
      <Descriptions column={3} size="small">
        <Descriptions.Item label="ID">{user.user.id}</Descriptions.Item>
        <Descriptions.Item label="用户名">{user.user.email}</Descriptions.Item>
        <Descriptions.Item label="显示名">{user.user.display_name}</Descriptions.Item>
        <Descriptions.Item label="微信ID">{user.user.wechat_id}</Descriptions.Item>
        <Descriptions.Item label="角色"><Tag color={user.user.role === 'admin' ? 'red' : 'blue'}>{user.user.role}</Tag></Descriptions.Item>
        <Descriptions.Item label="活跃"><Tag color={user.user.is_active ? 'green' : 'default'}>{user.user.is_active ? '是' : '否'}</Tag></Descriptions.Item>
	        <Descriptions.Item label="会员">
	          {adminUser?.role === 'admin' ? (
	            <Select size="small" value={membership} style={{ width: 140 }}
	              onChange={async (v) => { try { await api.put(`/admin/users/${id}/membership`, { tier: v }); setMembership(v); message.success('已更新'); } catch { message.error('更新失败'); } }}>
	              {Object.entries(tiers).map(([k, v]) => <Select.Option key={k} value={parseInt(k)}>{v as string}</Select.Option>)}
	            </Select>
	          ) : <Tag>{tiers[membership] || '🌱 体验'}</Tag>}
	        </Descriptions.Item>
      </Descriptions>
    </Card>
    <Card title="😊 情绪分布" style={{ marginBottom: 16 }}>
      {emotions.length > 0 ? (
        <div style={{ maxWidth: 400 }}>
          {emotions.map((e: any) => (
            <div key={e.emotion} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span>{EMOTION_LABELS[e.emotion] || e.emotion}</span>
                <span>{Math.round((parseInt(e.count) / total) * 100)}%</span>
              </div>
              <Progress percent={Math.round((parseInt(e.count) / total) * 100)} strokeColor={EMOTION_COLORS[e.emotion] || '#8c8c8c'} showInfo={false} />
            </div>
          ))}
        </div>
      ) : <Typography.Text type="secondary">暂无数据</Typography.Text>}
    </Card>
    <Card><Tabs items={[
      { key: 'logs', label: '对话记录', children: <Table columns={logCols} dataSource={logs} rowKey="id" size="small" pagination={{ current: logsPage, total: logsTotal, pageSize: 10, onChange: fetchLogs, showTotal: (t: number) => `共 ${t} 条` }} /> },
      { key: 'memories', label: '长期记忆', children: <Table columns={memCols} dataSource={memories} rowKey="id" size="small" /> },
      { key: 'summaries', label: '每日摘要', children: <Table columns={sumCols} dataSource={summaries} rowKey="id" size="small" /> },
    ]} /></Card>
  </>;
}
