import React, { useEffect, useState, useCallback } from 'react';
import { Card, Table, Button, Modal, Input, InputNumber, Select, Typography, Space, message, Tabs, Tag, Form } from 'antd';
import { PlusOutlined, SaveOutlined, LockOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';

function RechargeCodes() {
  const [codes, setCodes] = useState<any[]>([]);
  const [count, setCount] = useState(1);
  const [credits, setCr] = useState(100);
  const [loading, setLoading] = useState(false);

  const fetch = async () => {
    try { const { data } = await api.get('/admin/recharge-codes'); setCodes(data.codes); } catch {}
  };
  useEffect(() => { fetch(); }, []);

  const generate = async () => {
    setLoading(true);
    try {
      await api.post('/admin/recharge-codes', { count, credits });
      message.success(`已生成 ${count} 个充值码`);
      fetch();
    } catch { message.error('生成失败'); }
    finally { setLoading(false); }
  };

  return <div>
    <Space style={{ marginBottom: 16 }}>
      <InputNumber min={1} max={20} value={count} onChange={v => setCount(v || 1)} />
      <InputNumber min={10} max={99999} value={credits} onChange={v => setCr(v || 100)} addonAfter="积分" />
      <Button type="primary" onClick={generate} loading={loading}>生成充值码</Button>
    </Space>
    <Table dataSource={codes} rowKey="id" size="small" pagination={false}
      columns={[
        { title: '充值码', dataIndex: 'code', render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
        { title: '积分', dataIndex: 'credits' },
        { title: '创建者', dataIndex: 'creator_email' },
        { title: '使用者', dataIndex: 'used_by_email', render: (v: string) => v || '-' },
        { title: '状态', dataIndex: 'is_used', render: (v: boolean) => v ? <Tag color="default">已用</Tag> : <Tag color="green">可用</Tag> },
      ]}
    />
  </div>;
}

function InviteCodes() {
  const [codes, setCodes] = useState<any[]>([]);
  const [genCount, setGenCount] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchCodes = useCallback(async () => {
    try { const { data } = await api.get('/admin/invite-codes'); setCodes(data.codes); } catch {}
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  const generate = async () => {
    setLoading(true);
    try {
      await api.post('/admin/invite-codes', { count: genCount, maxUses: 1 });
      message.success(`已生成 ${genCount} 个邀请码`);
      fetchCodes();
    } catch { message.error('生成失败'); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <InputNumber min={1} max={50} value={genCount} onChange={v => setGenCount(v || 1)} />
        <Button type="primary" onClick={generate} loading={loading}>生成邀请码</Button>
      </Space>
      <Table dataSource={codes} rowKey="id" size="small" pagination={false}
        columns={[
          { title: '邀请码', dataIndex: 'code', width: 180, render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
          { title: '创建者', dataIndex: 'creator_email', width: 120 },
          { title: '使用', dataIndex: 'use_count', width: 60, render: (v: number, r: any) => `${v}/${r.max_uses}` },
          { title: '状态', dataIndex: 'is_active', width: 60, render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '有效' : '禁用'}</Tag> },
          { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
        ]}
      />
    </div>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const [templates, setTemplates] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);

  useEffect(() => { api.get('/admin/care-templates').catch(() => {}).then(({ data }: any) => setTemplates(data?.templates || [])); }, []);

  const handleSave = async (t: any) => {
    try { await api.put('/admin/care-templates', { templates: [t] }); message.success('保存成功'); setModalVisible(false); api.get('/admin/care-templates').then(({ data }: any) => setTemplates(data?.templates || [])); }
    catch { message.error('保存失败'); }
  };

  const handleChangePwd = async (values: { oldPassword: string; newPassword: string }) => {
    setPwdLoading(true);
    try {
      await api.put('/user/password', values);
      message.success('密码修改成功');
    } catch (err: any) { message.error(err.response?.data?.error || '修改失败'); }
    finally { setPwdLoading(false); }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '时段', dataIndex: 'schedule_type', width: 100, render: (v: string) => ({ morning: '🌅 早安', afternoon: '☀️ 午间', evening: '🌙 晚间' } as any)[v] || v },
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '排序', dataIndex: 'sort_order', width: 60 },
    { title: '状态', dataIndex: 'is_active', width: 60, render: (v: boolean) => v ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag> },
    { title: '操作', width: 80, render: (_: any, r: any) => <Button type="link" onClick={() => { setEditing(r); setModalVisible(true); }}>编辑</Button> },
  ];

  const items = [];

  // 个人设置 (所有用户可见)
  items.push({
    key: 'profile', label: '个人设置',
    children: (
      <Card title="🔒 修改密码" style={{ maxWidth: 400 }}>
        <Form onFinish={handleChangePwd} layout="vertical">
          <Form.Item label="登录名"><Input value={user?.email || ''} disabled /></Form.Item>
          <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: '请输入原密码' }]}>
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 6, message: '至少6位' }]}>
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Form.Item><Button type="primary" htmlType="submit" loading={pwdLoading}>修改密码</Button></Form.Item>
        </Form>
      </Card>
    ),
  });

  // 管理员专属
  if (user?.role === 'admin') {
    items.push({
      key: 'care', label: '关怀文案',
      children: (
        <>
          <Space style={{ marginBottom: 16 }}><Button icon={<PlusOutlined />} onClick={() => { setEditing({ schedule_type: 'morning', content: '', sort_order: 0, is_active: true }); setModalVisible(true); }}>新增文案</Button></Space>
          <Table columns={columns} dataSource={templates} rowKey="id" size="small" />
        </>
      ),
    });
    items.push({
      key: 'invites', label: '邀请码',
      children: <InviteCodes />,
    });
    items.push({
      key: 'recharge', label: '充值码',
      children: <RechargeCodes />,
    });
    items.push({ key: 'system', label: '系统信息', children: <Card><Typography.Paragraph>版本: 2.0 | 模式: Docker Compose | API: /api</Typography.Paragraph></Card> });
  }

  return <>
    <Typography.Title level={4}>系统设置</Typography.Title>
    <Tabs items={items} />
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
