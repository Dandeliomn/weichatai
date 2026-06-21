import React, { useEffect, useState, useRef } from 'react';
import { Typography, Card, Tag, Space, Button, Grid, Popconfirm, message, Select, Empty } from 'antd';
import { PlusOutlined, ReloadOutlined, DeleteOutlined, StopOutlined, SwapOutlined, LinkOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';

const { Title, Text } = Typography;
const { useBreakpoint } = Grid;

interface CharacterBrief {
  id: number;
  name: string;
  tagline: string | null;
}

interface BotInfo {
  id: number;
  bot_id: string;
  nickname: string | null;
  is_active: boolean;
  last_active_at: string;
  created_at: string;
  character: CharacterBrief | null;
}

export default function BridgePage() {
  const { user } = useAuth();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const [bots, setBots] = useState<BotInfo[]>([]);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [selectedCharId, setSelectedCharId] = useState<number | undefined>(undefined);
  const [characters, setCharacters] = useState<CharacterBrief[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [changingId, setChangingId] = useState<number | null>(null);
  const [qrTs, setQrTs] = useState(Date.now());
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const notifiedRef = useRef(false);
  const prevBotIds = useRef<Set<number>>(new Set());

  // 加载可用角色列表
  const loadCharacters = async () => {
    try {
      const { data } = await api.get('/characters/list/mine');
      setCharacters(data?.characters || []);
    } catch { /* ignore */ }
  };

  // 加载 Bot 列表
  const fetchBots = async () => {
    try {
      const { data } = await api.get('/bridge/bots');
      const newBots: BotInfo[] = data?.bots || [];
      setBots(newBots);

      // 检测新 Bot：自动绑定选中的角色
      const currentIds = new Set(newBots.map(b => b.id));
      if (selectedCharId) {
        for (const bot of newBots) {
          if (!prevBotIds.current.has(bot.id) && !bot.character) {
            prevBotIds.current.add(bot.id); // 先标记，防止 handleChangeChar → fetchBots 死循环
            handleChangeChar(bot.id, selectedCharId);
          }
        }
      }
      prevBotIds.current = currentIds; // 清理已删除的 bot

      if (newBots.some(b => b.is_active) && !notifiedRef.current) {
        notifiedRef.current = true;
        setShowAddPanel(false);
        message.success('🎉 Bot 连接成功！');
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadCharacters();
    fetchBots();
    pollingRef.current = setInterval(fetchBots, 5000);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  // 换角色
  const handleChangeChar = async (botId: number, characterId: number) => {
    setChangingId(botId);
    try {
      await api.put(`/bridge/bots/${botId}/character`, { character_id: characterId });
      message.success('角色已更新');
      fetchBots();
    } catch (err: any) {
      message.error(err.response?.data?.error || '更换失败');
    }
    setChangingId(null);
  };

  // 停用
  const handleDeactivate = async (botId: number) => {
    setTogglingId(botId);
    try {
      await api.delete(`/bridge/bots/${botId}?permanent=false`);
      message.success('已停用');
      fetchBots();
    } catch (err: any) {
      message.error(err.response?.data?.error || '操作失败');
    }
    setTogglingId(null);
  };

  // 删除
  const handleDelete = async (botId: number) => {
    setDeletingId(botId);
    try {
      await api.delete(`/bridge/bots/${botId}?permanent=true`);
      message.success('已删除');
      notifiedRef.current = false;
      fetchBots();
    } catch (err: any) {
      message.error(err.response?.data?.error || '删除失败');
    }
    setDeletingId(null);
  };

  const botActions = (bot: BotInfo) => (
    <Space size="small" wrap>
      <Select
        size="small"
        style={{ minWidth: 110 }}
        placeholder="换角色"
        value={bot.character?.id}
        loading={changingId === bot.id}
        onChange={(cid) => handleChangeChar(bot.id, cid)}
        options={characters.map(c => ({ value: c.id, label: c.name }))}
        suffixIcon={<SwapOutlined />}
      />
      {bot.is_active && (
        <Popconfirm
          title="停用后将不再处理该 Bot 的消息"
          onConfirm={() => handleDeactivate(bot.id)}
          okText="确定停用" cancelText="取消"
        >
          <Button size="small" icon={<StopOutlined />} loading={togglingId === bot.id}>
            停用
          </Button>
        </Popconfirm>
      )}
      <Popconfirm
        title="永久删除此 Bot？此操作不可恢复"
        onConfirm={() => handleDelete(bot.id)}
        okText="永久删除" cancelText="取消"
        okButtonProps={{ danger: true }}
      >
        <Button size="small" danger icon={<DeleteOutlined />} loading={deletingId === bot.id} />
      </Popconfirm>
    </Space>
  );

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={isMobile ? 5 : 4} style={{ margin: 0 }}>
          <LinkOutlined style={{ marginRight: 8 }} />My Bots ({bots.length})
        </Title>
        <Button type="primary" icon={<PlusOutlined />}
          onClick={() => { setShowAddPanel(!showAddPanel); loadCharacters(); }}>
          添加 Bot
        </Button>
      </div>

      {/* 添加面板 */}
      {showAddPanel && (
        <Card size="small" style={{ marginBottom: 16, background: '#f6ffed' }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <Text strong>① 选择角色：</Text>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选一个角色给这个 Bot"
                value={selectedCharId}
                onChange={setSelectedCharId}
                options={characters.map(c => ({
                  value: c.id,
                  label: `${c.name}${c.tagline ? ' — ' + c.tagline : ''}`,
                }))}
                allowClear
              />
            </div>
            <div style={{ textAlign: 'center' }}>
              <Text strong>② 扫描二维码：</Text>
              <div style={{ margin: '8px 0', background: '#fff', borderRadius: 8, padding: 8 }}>
                <img src={`/qr.svg?t=${qrTs}`} alt="微信扫码"
                  style={{ width: 220, height: 220 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => setQrTs(Date.now())}>
                刷新二维码
              </Button>
              <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                扫码后约 30 秒内自动检测并连接
              </Text>
            </div>
            <Button block onClick={() => { setShowAddPanel(false); setSelectedCharId(undefined); }}>
              取消
            </Button>
          </Space>
        </Card>
      )}

      {/* Bot 列表 */}
      {bots.length === 0 && !showAddPanel ? (
        <Card style={{ textAlign: 'center' }}>
          <Empty description="还没有 Bot，点上方「添加 Bot」开始" />
        </Card>
      ) : (
        bots.map(bot => (
          <Card key={bot.id} size="small" style={{ marginBottom: 8 }}
            title={
              <Space>
                <Text strong>{bot.character?.name || '未分配角色'}</Text>
                <Tag color={bot.is_active ? 'green' : 'default'}>
                  {bot.is_active ? 'Active' : 'Inactive'}
                </Tag>
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 11 }}>
                {bot.last_active_at ? new Date(bot.last_active_at).toLocaleString('zh-CN') : ''}
              </Text>
            }
          >
            <div style={{ marginBottom: 4 }}>
              <Text code style={{ fontSize: 11 }} copyable>{bot.bot_id}</Text>
            </div>
            {bot.character?.tagline && (
              <Text type="secondary" style={{ fontSize: 12 }}>{bot.character.tagline}</Text>
            )}
            <div style={{ marginTop: 8 }}>
              {botActions(bot)}
            </div>
          </Card>
        ))
      )}

      {/* 后备 QR（无 Bot 且面板未开时） */}
      {bots.length === 0 && !showAddPanel && (
        <Card style={{ textAlign: 'center', marginTop: 16, background: '#fafafa' }}>
          <img src={`/qr.svg?t=${qrTs}`} alt="QR" style={{ width: 180, height: 180 }} />
          <br />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setQrTs(Date.now())}>刷新</Button>
        </Card>
      )}
    </div>
  );
}
