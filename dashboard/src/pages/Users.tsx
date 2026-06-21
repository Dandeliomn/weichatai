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
    { title: '用户名', dataIndex: 'email', ellipsis: true },
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
