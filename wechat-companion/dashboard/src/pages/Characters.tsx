import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Tag, Button, Typography, message, Space } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import api from '../api/client';
import { useAuth } from '../hooks/useAuth';

export default function Characters() {
  const { user } = useAuth();
  const [chars, setChars] = useState<any[]>([]);
  const [myChars, setMyChars] = useState<any[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [list, mine] = await Promise.all([
        api.get('/characters'),
        api.get('/characters/list/mine').catch(() => ({ data: { characters: [] } })),
      ]);
      setChars(list.data.characters || []);
      const mc = mine.data?.characters || [];
      setMyChars(mc);
      const active = mc.find((c: any) => c.is_active);
      if (active) setActiveId(active.template_id || active.id);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleDelete = async (charId: number, charName: string) => {
    try {
      await api.delete(`/characters/${charId}`);
      message.success(`已删除角色: ${charName}`);
      fetchData();
    } catch (err: any) { message.error(err.response?.data?.error || '删除失败'); }
  };

  const handleActivate = async (charId: number, charName: string) => {
    try {
      await api.post(`/characters/${charId}/activate`, {
        wechatId: user?.wechatId || '',
      });
      message.success(`已激活: ${charName}`);
      fetchData();
    } catch (err: any) { message.error(err.response?.data?.error || '激活失败'); }
  };

  const tagColors = ['blue', 'green', 'orange', 'purple', 'cyan', 'magenta'];

  return (
    <>
      <Typography.Title level={4}>AI 角色管理</Typography.Title>
      <Typography.Text type="secondary">
        选择一个角色来改变 AI 的聊天风格。激活后，微信聊天会自动应用角色设定。
      </Typography.Text>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {chars.map((c) => {
          const isActive = activeId === c.id;
          return (
            <Col key={c.id} span={8}>
              <Card
                title={c.name}
                extra={c.is_official ? <Tag color="gold">官方</Tag> : null}
                style={isActive ? { border: '2px solid #52c41a' } : undefined}
                actions={[
                  <Button
                    type={isActive ? 'default' : 'primary'}
                    danger={isActive}
                    onClick={() => handleActivate(c.id, c.name)}
                    loading={loading}
                  >
                    {isActive ? '✅ 当前使用' : '激活'}
                  </Button>,
                  ...(c.category !== 'preset' ? [
                    <Button danger onClick={() => handleDelete(c.id, c.name)}>删除</Button>
                  ] : []),
                ]}
              >
                <p>{c.tagline}</p>
                <Space wrap>
                  {(c.tags || []).map((t: string, i: number) => (
                    <Tag key={t} color={tagColors[i % tagColors.length]}>{t}</Tag>
                  ))}
                </Space>
              </Card>
            </Col>
          );
        })}
      </Row>
    </>
  );
}
