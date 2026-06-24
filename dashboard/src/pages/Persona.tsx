import React, { useEffect, useState } from 'react';
import { Card, Slider, Typography, Button, Select, Row, Col, Alert, message, Spin } from 'antd';
import { SaveOutlined, SmileOutlined } from '@ant-design/icons';
import api from '../api/client';

const PARAM_LABELS: Record<string, string> = {
  talkativeness: '话多程度',
  warmth: '热情程度',
  reply_length: '回复长度',
  playfulness: '俏皮程度',
  patience: '耐心程度',
  affection: '亲密程度',
};

const PARAM_LEVELS: Record<string, [string, string, string]> = {
  talkativeness: ['少言', '适中', '话多'],
  warmth: ['冷淡', '温和', '热情'],
  reply_length: ['简短', '适中', '详细'],
  playfulness: ['严肃', '适度', '俏皮'],
  patience: ['不耐烦', '耐心', '非常耐心'],
  affection: ['疏远', '友好', '亲密'],
};

function describeLevel(param: string, val: number): string {
  const levels = PARAM_LEVELS[param] || ['低', '中', '高'];
  if (val < 0.3) return levels[0];
  if (val < 0.7) return levels[1];
  return levels[2];
}

function generatePreview(parameters: Record<string, number>, catchphrases: string[], attributes: any[]) {
  const lines: string[] = [];

  if (attributes?.length > 0) {
    lines.push(`【当前人格】${attributes.map((a: any) => a.name || a).join(', ')}`);
  }

  lines.push('\n【行为参数】');
  for (const [key, val] of Object.entries(parameters)) {
    const label = PARAM_LABELS[key] || key;
    lines.push(`- ${label}: ${describeLevel(key, val)} (${val.toFixed(1)})`);
  }

  if (catchphrases?.length > 0) {
    lines.push('\n【自定义口头禅】');
    catchphrases.forEach((p: string) => lines.push(`- ${p}`));
  }

  return lines.join('\n');
}

export default function Persona() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [persona, setPersona] = useState<any>(null);
  const [parameters, setParameters] = useState<Record<string, number>>({});
  const [catchphrases, setCatchphrases] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPersona();
  }, []);

  const fetchPersona = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/persona/current');
      setPersona(data);
      setParameters(data.parameters || {});
      setCatchphrases(data.catchphrases || []);
      setError(null);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/persona/update', { parameters, catchphrases });
      message.success('人格参数已保存，下次对话生效');
      setPersona((prev: any) => ({
        ...prev,
        parameters,
        catchphrases,
        updated_at: new Date().toISOString(),
      }));
    } catch (e: any) {
      message.error(e.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Card><Spin /><Typography.Text style={{ marginLeft: 12 }}>加载中...</Typography.Text></Card>;
  if (error) return <Card><Typography.Text type="danger">加载失败: {error}</Typography.Text></Card>;

  const attributes = persona?.attributes || [];
  const preview = generatePreview(parameters, catchphrases, attributes);
  const updatedAt = persona?.updated_at
    ? new Date(persona.updated_at).toLocaleString('zh-CN')
    : '未知';

  return (
    <>
      <Typography.Title level={4}><SmileOutlined /> 人格调校</Typography.Title>
      <Alert
        type="info"
        message="调整参数后点击保存，下一条微信消息即会生效。也可以在微信聊天中直接说「话太多」「热情点」来调整。"
        style={{ marginBottom: 16 }}
        showIcon
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="行为参数" size="small">
            {Object.entries(PARAM_LABELS).map(([key, label]) => (
              <div key={key} style={{ marginBottom: 20 }}>
                <Typography.Text>
                  {label}: <strong>{describeLevel(key, parameters[key] ?? 0.5)}</strong> ({((parameters[key] ?? 0.5) * 100).toFixed(0)}%)
                </Typography.Text>
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  value={parameters[key] ?? 0.5}
                  onChange={(v) => setParameters((p) => ({ ...p, [key]: v }))}
                  marks={{ 0: '低', 0.5: '中', 1: '高' }}
                />
              </div>
            ))}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title="预览" size="small" style={{ marginBottom: 16 }}>
            <Typography.Paragraph style={{
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              fontSize: 13,
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 6,
              maxHeight: 360,
              overflow: 'auto',
            }}>
              {preview}
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Card title="自定义口头禅" size="small" style={{ marginTop: 16 }}>
        <Select
          mode="tags"
          style={{ width: '100%' }}
          placeholder="输入口头禅后按回车添加"
          value={catchphrases}
          onChange={(vals) => setCatchphrases(vals)}
        />
      </Card>

      <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 16 }}>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={handleSave}
          loading={saving}
          size="large"
        >
          保存人格
        </Button>
        <Typography.Text type="secondary">
          上次更新: {updatedAt}
        </Typography.Text>
      </div>
    </>
  );
}
