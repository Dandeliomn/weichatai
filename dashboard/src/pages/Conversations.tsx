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
