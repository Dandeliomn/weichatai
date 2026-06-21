import React, { useEffect, useState, useRef } from 'react';
import { Typography, Card, Alert, Tag, Space, Button, Grid, Table, Popconfirm, message } from 'antd';
import { ReloadOutlined, CheckCircleOutlined, SyncOutlined, LinkOutlined, DeleteOutlined, StopOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';

const { Title, Text, Paragraph } = Typography;
const { useBreakpoint } = Grid;


interface BotInfo {
  id: number;
  bot_id: string;
  wechat_id: string | null;
  nickname: string | null;
  bot_index: number;
  is_active: boolean;
  last_active_at: string;
}

function QrCodeView() {
  const [connected, setConnected] = useState(false);
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [deleting, setDeleting] = useState<number | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'confirmed'>('idle');
  const notifioedRef = useRef(false); // 确保首次连接通知只弹一次
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const [qrTs, setQrTs] = useState(Date.now());

  const scanStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBots = async () => {
    try {
      const { data } = await api.get('/bridge/bots');
      const newBots: BotInfo[] = data?.bots || [];
      const hasActive = newBots.some((b: BotInfo) => b.is_active);

      setBots(newBots);
      setConnected(hasActive);

      // 首次从无→有 的连接，通知一次
      if (hasActive && !notifioedRef.current) {
        notifioedRef.current = true;
        setScanStatus('confirmed');
        message.success('🎉 微信扫码登录成功！');
        if (scanStatusTimerRef.current) clearTimeout(scanStatusTimerRef.current);
        scanStatusTimerRef.current = setTimeout(() => setScanStatus('idle'), 3000);
      }
    } catch {
      console.warn('[Bridge] fetchBots failed');
    }
  };

  const handleDelete = async (botId: number, permanent: boolean) => {
    setDeleting(botId);
    try {
      const { data } = await api.delete(`/bridge/bots/${botId}?permanent=${permanent}`);
      if (data.ok) {
        message.success(data.message || '操作成功');
        notifioedRef.current = false;
        // 刷新并检查是否还有活跃 bot
        const { data: fresh } = await api.get('/bridge/bots');
        setBots(fresh?.bots || []);
        if (!fresh?.bots?.some((b: BotInfo) => b.is_active)) {
          setConnected(false);
          setQrTs(Date.now());
          setScanStatus('idle');
        }
      } else {
        message.error(data?.message || '操作失败');
      }
    } catch (err: any) {
      message.error(err.response?.data?.error || '操作失败，请确保已登录');
    }
    setDeleting(null);
  };

  useEffect(() => {
    notifioedRef.current = false;
    fetchBots();
    pollingRef.current = setInterval(fetchBots, 5000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (scanStatusTimerRef.current) clearTimeout(scanStatusTimerRef.current);
    };
  }, []);

  // --- 已连接：显示 Bot 列表 + 管理（可添加新 Bot） ---
  if (connected && bots.length > 0) {
    return (
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        <Card style={{ marginBottom: 16, textAlign: 'center' }}>
          <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a' }} />
          <Title level={4} style={{ marginTop: 8 }}>✅ 微信已连接</Title>
          <Paragraph type="secondary">AI 情感陪伴服务已就绪，消息自动转发</Paragraph>
          {scanStatus === 'confirmed' && (
            <Tag icon={<CheckCircleOutlined />} color="success" style={{ fontSize: 14, padding: '4px 12px' }}>
              扫码登录成功！
            </Tag>
          )}
        </Card>

        <Card title={<Space><LinkOutlined /> Bot 账号管理</Space>}
          extra={<Space>
            <Button icon={<SyncOutlined />} onClick={() => { setQrTs(Date.now()); fetchBots(); }} size="small">
              检测新 Bot
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => fetchBots()} size="small">刷新</Button>
          </Space>}>
          <Table
            dataSource={bots}
            rowKey="id"
            pagination={false}
            size={isMobile ? 'small' : 'middle'}
            columns={[
              {
                title: 'Bot ID', dataIndex: 'bot_id', key: 'bot_id',
                render: (v: string) => <Text code copyable style={{ fontSize: 12 }}>{v}</Text>
              },
              {
                title: '状态', dataIndex: 'is_active', key: 'status', width: 80,
                render: (v: boolean) => v
                  ? <Tag color="green">活跃</Tag>
                  : <Tag color="default">已停用</Tag>
              },
              {
                title: '最后活跃', dataIndex: 'last_active_at', key: 'time', width: 140,
                render: (v: string) => v ? <Text style={{ fontSize: 12 }}>{new Date(v).toLocaleString('zh-CN')}</Text> : '-'
              },
              {
                title: '操作', key: 'actions', width: 180,
                render: (_: any, record: BotInfo) => (
                  <Space size="small">
                    {record.is_active && (
                      <Popconfirm
                        title="停用后将不会再接收该账号的消息"
                        onConfirm={() => handleDelete(record.id, false)}
                        okText="确定停用" cancelText="取消"
                      >
                        <Button
                          size="small"
                          icon={<StopOutlined />}
                          loading={deleting === record.id}
                        >
                          停用
                        </Button>
                      </Popconfirm>
                    )}
                    <Popconfirm
                      title={record.is_active ? '该 Bot 正在活跃，确定永久删除？' : '确定永久删除此 Bot？'}
                      onConfirm={() => handleDelete(record.id, true)}
                      okText="永久删除" cancelText="取消"
                      okButtonProps={{ danger: true }}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        loading={deleting === record.id}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>

        {/* 添加新 Bot：显示二维码 info */}
        <Card size="small" style={{ marginTop: 12, textAlign: 'center', background: '#fafafa' }}>
          <Space>
            <SyncOutlined spin />
            <Text type="secondary">
              需要添加新微信账号？
              <Button type="link" size="small" onClick={() => setQrTs(Date.now())}>
                使用 WeClaw 登录新 Bot
              </Button>
              （扫码后约 30 秒内自动检测）
            </Text>
          </Space>
        </Card>
      </div>
    );
  }

  // --- 未连接：显示 QR SVG ---
  return (
    <div style={{ display: 'flex', justifyContent: 'center', minHeight: '50vh' }}>
      <Card style={{ textAlign: 'center', maxWidth: 520, width: '100%' }}>
        <Title level={isMobile ? 4 : 3}>
          <LinkOutlined style={{ marginRight: 8 }} />
          连接微信
        </Title>
        <Paragraph type="secondary">请使用微信扫描下方二维码登录 Bot</Paragraph>

        <div style={{ margin: '16px 0', display: 'flex', justifyContent: 'center', background: '#fff', borderRadius: 8, padding: 8 }}>
          <img
            src={`/qr.svg?t=${qrTs}`}
            alt="微信扫码"
            style={{ width: isMobile ? 240 : 300, height: isMobile ? 240 : 300 }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        </div>

        {scanStatus === 'confirmed' ? (
          <Tag icon={<CheckCircleOutlined />} color="success">✅ 登录成功！</Tag>
        ) : (
          <Tag icon={<SyncOutlined spin />} color="processing">等待扫码...</Tag>
        )}

        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
          <Button icon={<ReloadOutlined />} onClick={() => { setQrTs(Date.now()); }} block>刷新二维码</Button>
          <Button type="link" onClick={() => fetchBots()}>手动检测连接状态</Button>
          <Text type="secondary" style={{ fontSize: 12 }}>扫码后等待几秒自动连接</Text>
        </Space>
      </Card>
    </div>
  );
}

/** 管理员 - 打开 OpeniLink Hub 管理界面 */
function AdminBridgeView() {
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const hubUrl = window.location.protocol + '//' + window.location.hostname + ':9800';

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
      <Card style={{ textAlign: 'center', maxWidth: 600, width: '100%' }}>
        <Title level={isMobile ? 4 : 3}>
          <LinkOutlined style={{ marginRight: 8 }} />
          OpeniLink Hub 管理
        </Title>
        <Paragraph type="secondary">
          微信桥接的完整管理界面，支持多账号管理、消息查看、连接状态监控
        </Paragraph>
        <div style={{ margin: '24px 0' }}>
          <Alert
            message="OpeniLink Hub 无法在页面内嵌显示，请在浏览器新标签页中打开"
            type="info"
            showIcon
            style={{ textAlign: 'left', marginBottom: 16 }}
          />
          <Button type="primary" size="large" icon={<LinkOutlined />} href={hubUrl} target="_blank" block>
            在新标签页中打开 OpeniLink Hub
          </Button>
        </div>
        <Card size="small" style={{ textAlign: 'left', background: '#fafafa' }}>
          <Text strong>账号信息</Text>
          <div style={{ marginTop: 8, fontSize: 13, color: '#666' }}>
            <div>用户名: <Text code>companion</Text></div>
            <div>密 码: <Text code>admin123</Text></div>
            <div style={{ marginTop: 4 }}>首次登录请在 OpeniLink Hub 页面使用上方账号登录</div>
          </div>
        </Card>
      </Card>
    </div>
  );
}

export default function BridgePage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [showAdmin, setShowAdmin] = useState(false);

  return (
    <div>
      {isAdmin && (
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <Button
            type={showAdmin ? 'default' : 'primary'}
            onClick={() => setShowAdmin(!showAdmin)}
            style={{ marginRight: 8 }}
          >
            {showAdmin ? '📱 显示二维码' : '🔧 管理界面'}
          </Button>
        </div>
      )}
      {showAdmin ? <AdminBridgeView /> : <QrCodeView />}
    </div>
  );
}
