import React, { useEffect, useState } from 'react';
import { Table, Typography } from 'antd';
import api from '../api/client';

export default function AdminLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchLogs = async (p: number) => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/logs', { params: { page: p, limit: 50 } });
      setLogs(data.logs); setTotal(data.total); setPage(p);
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchLogs(1); }, []);

  return <>
    <Typography.Title level={4}>操作日志</Typography.Title>
    <Table columns={[
      { title: '时间', dataIndex: 'created_at', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
      { title: '管理员', dataIndex: 'admin_email', width: 150 },
      { title: '操作', dataIndex: 'action', width: 120 },
      { title: '目标', dataIndex: 'target_type', width: 80 },
      { title: '详情', dataIndex: 'details', ellipsis: true },
      { title: 'IP', dataIndex: 'ip_address', width: 120 },
    ]} dataSource={logs} rowKey="id" loading={loading}
      pagination={{ current: page, total, pageSize: 50, onChange: fetchLogs, showTotal: (t: number) => `共 ${t} 条` }} />
  </>;
}
