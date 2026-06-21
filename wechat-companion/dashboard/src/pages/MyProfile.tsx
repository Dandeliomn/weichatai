import React, { useEffect, useState } from 'react';
import { Card, Descriptions, Table, Tabs, Typography, Tag, Form, Select, Button, message, Statistic, Row, Col, Space, InputNumber, Input } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import EmotionTag from '../components/EmotionTag';
import api from '../api/client';

export default function MyProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage] = useState(1);
  const [memories, setMemories] = useState<any[]>([]);
  const [aiPrefs, setAiPrefs] = useState<any>({});
  const [credits, setCredits] = useState(0);
  const [membership, setMembership] = useState<any>({});
  const [myCodes, setMyCodes] = useState<any[]>([]);
  const [genCount, setGenCount] = useState(1);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = () => {
    setLoading(true);
    Promise.all([
      api.get('/user/profile'), api.get('/user/stats'),
      api.get('/user/conversations?page=1&limit=10'), api.get('/user/memories'),
      api.get('/user/credits'),
    ]).then(([p, s, l, m, c]) => {
      setProfile(p.data); setStats(s.data.stats);
      setLogs(l.data.logs || []); setLogsTotal(l.data.total || 0);
      setMemories(m.data.memories || []);
      setCredits(c.data.credits || 0);
      setMembership(c.data.tier || c.data.membership || {});
    }).finally(() => setLoading(false));
    api.get('/user/profile').then(({ data }) => {
      setAiPrefs({ tone: data.profile?.preferred_tone || 'friendly', verbosity: data.profile?.verbosity || 'medium' });
    }).catch(() => {});
    api.get('/user/invite-codes').then(({ data }) => { setMyCodes(data.codes || []); }).catch(() => {});
  };
  useEffect(() => { fetchData(); }, []);

  const handleUpgrade = async (tier: number) => {
    setUpgradeLoading(true);
    try {
      const { data } = await api.post('/user/upgrade', { tier });
      message.success(data.message);
      const c = await api.get('/user/credits');
      setCredits(c.data.credits);
      setMembership(c.data.tier);
    } catch (err: any) { message.error(err.response?.data?.error || '升级失败'); }
    finally { setUpgradeLoading(false); }
  };

  const generateCodes = async () => {
    try {
      const { data } = await api.post('/user/invite-codes', { count: genCount });
      message.success(data.message);
      api.get('/user/credits').then(({ data: c }) => setCredits(c.credits));
      api.get('/user/invite-codes').then(({ data }) => { setMyCodes(data.codes || []); }).catch(() => {});
    } catch (err: any) { message.error(err.response?.data?.error || '生成失败'); }
  };

  const fetchLogs = async (p: number) => {
    const { data } = await api.get('/user/conversations', { params: { page: p, limit: 10 } });
    setLogs(data.logs || []); setLogsTotal(data.total || 0); setLogsPage(p);
  };

  const saveAiPrefs = async () => {
    try {
      await api.put('/user/ai-prefs', aiPrefs);
      message.success('偏好已保存');
    } catch { message.error('保存失败'); }
  };

  if (loading) return <Card loading />;

  const logCols = [
    { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
    { title: '', dataIndex: 'role', width: 40, render: (r: string) => r === 'user' ? '👤' : '🤖' },
    { title: '内容', dataIndex: 'content', ellipsis: true },
    { title: '情绪', dataIndex: 'emotion', width: 100, render: (e: string) => <EmotionTag emotion={e} /> },
  ];
  const memCols = [
    { title: '摘要', dataIndex: 'summary_text', ellipsis: true },
    { title: '关键词', dataIndex: 'keywords', render: (k: string[]) => (k || []).join(', ') },
    { title: '重要性', dataIndex: 'importance' },
    { title: '情绪', dataIndex: 'emotion', render: (e: string) => <EmotionTag emotion={e} /> },
  ];

  const tabs = [
    {
      key: 'recharge', label: '充值',
      children: <Card style={{ maxWidth: 400 }}>
        <Typography.Paragraph>输入充值码获取积分，可用于购买会员。</Typography.Paragraph>
        <Space.Compact style={{ width: '100%' }}>
          <Input placeholder="输入充值码" id="redeemCode" />
          <Button type="primary" onClick={async () => {
            const code = (document.getElementById('redeemCode') as any)?.value;
            if (!code) { message.warning('请输入充值码'); return; }
            try {
              const { data } = await api.post('/user/redeem', { code });
              message.success(data.message);
              const c = await api.get('/user/credits'); setCredits(c.data.credits);
            } catch (err: any) { message.error(err.response?.data?.error || '兑换失败'); }
          }}>兑换</Button>
        </Space.Compact>
      </Card>,
    },
    {
      key: 'membership', label: '会员等级',
      children: <div>
        <Card style={{ marginBottom: 16, background: membership.icon === '👑' ? '#fff7e6' : '#fafafa' }}>
          <Statistic title="当前等级" value={`${membership.icon || '🌱'} ${membership.name || '体验会员'}`} />
          <Typography.Text type="secondary">每日 {membership.dailyCredits || 10} 积分，{membership.charSlots || 1} 个角色位</Typography.Text>
        </Card>
        <Typography.Title level={5}>升级会员</Typography.Title>
        <Row gutter={[12, 12]}>
          {[2,3,4].map(t => {
            const info = ({} as any)[t];
            const tiers: any = { 2: { name: '普通会员', icon: '⭐', price: 500, daily: 50, slots: 3, invite: 5 },
              3: { name: '高级会员', icon: '💎', price: 2000, daily: 200, slots: 10, invite: 20 },
              4: { name: '至尊会员', icon: '👑', price: 5000, daily: '不限', slots: '不限', invite: 50 } };
            const ti = tiers[t];
            const canAfford = credits >= ti.price;
            const tooHigh = (membership.membership || 1) >= t;
            return (
              <Col span={8} key={t}>
                <Card size="small" title={`${ti.icon} ${ti.name}`}
                  extra={tooHigh ? <Tag>已达成</Tag> : null}>
                  <p>每日 {ti.daily} 积分 | {ti.slots} 角色位</p>
                  <p>邀请 {ti.invite} 人 或 {ti.price} 积分</p>
                  <Button size="small" type={canAfford && !tooHigh ? 'primary' : 'default'}
                    disabled={tooHigh || !canAfford} loading={upgradeLoading}
                    onClick={() => handleUpgrade(t)}>
                    {tooHigh ? '当前等级' : canAfford ? `${ti.price} 积分购买` : `需要 ${ti.price} 积分`}
                  </Button>
                </Card>
              </Col>
            );
          })}
        </Row>
      </div>,
    },
    {
      key: 'info', label: '基本信息',
      children: <Card>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="登录名">{profile?.email}</Descriptions.Item>
          <Descriptions.Item label="显示名">{profile?.display_name}</Descriptions.Item>
          <Descriptions.Item label="角色"><Tag color={profile?.role === 'admin' ? 'red' : 'blue'}>{profile?.role}</Tag></Descriptions.Item>
          <Descriptions.Item label="微信">{profile?.wechat_id || '未绑定'}</Descriptions.Item>
        </Descriptions>
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={6}><Statistic title="总消息" value={stats?.totalMessages || 0} /></Col>
          <Col span={6}><Statistic title="💎 积分" value={credits} suffix="条" /></Col>
        </Row>
      </Card>,
    },
    {
      key: 'invite', label: '邀请好友',
      children: <Card title="🎁 邀请好友，双方获积分" style={{ maxWidth: 500 }}>
        <Typography.Paragraph>
          每邀请一位好友注册，你将获得 <Tag color="gold">100 积分</Tag>，好友获得 <Tag color="green">50 积分</Tag>。<br/>
          邀请码可重复使用，免费生成。
        </Typography.Paragraph>
        <Space style={{ marginBottom: 16 }}>
          <InputNumber min={1} max={10} value={genCount} onChange={v => setGenCount(v || 1)} />
          <Button type="primary" onClick={generateCodes}>生成邀请码</Button>
        </Space>
        {myCodes.length > 0 && (
          <Table dataSource={myCodes} rowKey="id" size="small" pagination={false}
            columns={[
              { title: '邀请码', dataIndex: 'code', render: (v: string) => <Typography.Text copyable code>{v}</Typography.Text> },
              { title: '使用', render: (_: any, r: any) => r.max_uses >= 999 ? `${r.use_count}/不限` : `${r.use_count}/${r.max_uses}` },
            ]}
          />
        )}
      </Card>,
    },
    { key: 'logs', label: '我的对话', children: <Table columns={logCols} dataSource={logs} rowKey="id" size="small" pagination={{ current: logsPage, total: logsTotal, pageSize: 10, onChange: fetchLogs, showTotal: (t: number) => `共 ${t} 条` }} /> },
    { key: 'memories', label: 'AI 记忆', children: <Table columns={memCols} dataSource={memories} rowKey="id" size="small" /> },
    {
      key: 'prefs', label: 'AI 偏好',
      children: <Card style={{ maxWidth: 400 }}>
        <Form layout="vertical" onFinish={saveAiPrefs}>
          <Form.Item label="回复语气">
            <Select value={aiPrefs.tone} onChange={v => setAiPrefs({ ...aiPrefs, tone: v })}>
              <Select.Option value="friendly">😊 友好</Select.Option>
              <Select.Option value="concise">⚡ 简洁</Select.Option>
              <Select.Option value="warm">🫂 温暖</Select.Option>
              <Select.Option value="humorous">😄 幽默</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="回复长度">
            <Select value={aiPrefs.verbosity} onChange={v => setAiPrefs({ ...aiPrefs, verbosity: v })}>
              <Select.Option value="short">短</Select.Option>
              <Select.Option value="medium">中</Select.Option>
              <Select.Option value="long">长</Select.Option>
            </Select>
          </Form.Item>
          <Button type="primary" htmlType="submit">保存偏好</Button>
        </Form>
      </Card>,
    },
  ];

  return <>
    <Typography.Title level={4}>我的</Typography.Title>
    <Tabs items={tabs} />
  </>;
}
