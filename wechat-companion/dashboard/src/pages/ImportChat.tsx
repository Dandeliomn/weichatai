import React, { useState, useEffect } from 'react';
import { Card, Upload, Button, Typography, message, Table, Tag, Space, Modal, Input, Progress, Row, Col, Alert } from 'antd';
import { UploadOutlined, RobotOutlined, DeleteOutlined, CloudUploadOutlined, EditOutlined, SaveOutlined, SwapOutlined } from '@ant-design/icons';
import api from '../api/client';

const { Text: AntText } = Typography;

const { TextArea } = Input;
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024;

interface ChatProfile {
  aiName: string;
  userName: string;
  relationship: string;
  personality: string;
  speakingStyle: string;
  catchphrases: string;
  emotionalPattern: string;
  notes: string;
}

const defaultProfile: ChatProfile = {
  aiName: '', userName: '', relationship: '', personality: '',
  speakingStyle: '', catchphrases: '', emotionalPattern: '', notes: '',
};

export default function ImportChat() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState('');
  const [editing, setEditing] = useState<{ taskId: number; profile: ChatProfile; senders: string[] } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/import/tasks').then(({ data }: any) => {
      setTasks((data.tasks || []).map((t: any) => ({
        id: t.id, seq: t.seq, filename: t.filename, status: t.status,
        message_count: t.message_count || t.messageCount || 0,
        meta: t.meta || {},
      })));
    }).catch(() => {});
  }, []);

  /* ---- 上传 (统一走普通上传，nginx已配大超时) ---- */
  const handleUpload = async (file: File) => {
    setUploading(true); setUploadProgress(0);
    setUploadLabel(`上传中 (${(file.size/1024/1024).toFixed(0)}MB)...`);

    // 用 XMLHttpRequest 获得上传进度
    try {
      const fd = new FormData(); fd.append('chatfile', file);
      const token = localStorage.getItem('access_token') || '';

      const result: any = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
        });
        xhr.addEventListener('load', () => {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error(`HTTP ${xhr.status}`)); }
        });
        xhr.addEventListener('error', () => reject(new Error('网络错误')));
        xhr.open('POST', '/api/import/upload');
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.timeout = 7200000; // 2小时
        xhr.send(fd);
      });

      message.success(`上传成功: ${result.message}`);
      setTasks(prev => [{ id: result.taskId, filename: file.name, status: 'pending', message_count: 0, meta: result.stats || {} }, ...prev]);
      setTimeout(() => checkTask(result.taskId), 1000);
    } catch (err: any) {
      message.error(err.response?.data?.error || err.message || '上传失败');
      setUploading(false); setUploadProgress(0);
    }
    return false;
  };

  const checkTask = async (taskId: number) => {
    try {
      const { data } = await api.get(`/import/status/${taskId}`);
      const t = data.task || data;
      setTasks(prev => {
        const old = prev.find(x => x.id === taskId);
        const item = { id: taskId, seq: old?.seq, filename: t.filename, status: t.status, message_count: t.messageCount || t.message_count || 0, meta: t.meta || {} };
        const idx = prev.findIndex(x => x.id === taskId);
        if (idx >= 0) { const n = [...prev]; n[idx] = item; return n; }
        return [...prev, item];
      });
      if (t.status === 'processing' || t.status === 'pending') setTimeout(() => checkTask(taskId), 3000);
      else { setUploading(false); setUploadProgress(0); }
    } catch { setUploading(false); }
  };

  /* ---- 分析 + 编辑 ---- */
  const handleAnalyze = async (taskId: number) => {
    message.loading({ content: 'AI 分析中...', key: 'analyze', duration: 0 });
    try {
      const { data } = await api.get(`/import/analysis/${taskId}`);
      message.destroy('analyze');
      const profile = (data.profile && Object.keys(data.profile).length > 0)
        ? { ...defaultProfile, ...data.profile }
        : { ...defaultProfile, aiName: data.aiName || '' };
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, analysis: data.analysis, profile, senders: data.senders } : t));
      // 自动弹出编辑框
      setEditing({ taskId, profile, senders: data.senders || [] });
    } catch (err: any) {
      message.destroy('analyze');
      message.error(err.response?.data?.error || '分析失败');
    }
  };

  const handleSwapIdentity = () => {
    if (!editing) return;
    const p = editing.profile;
    setEditing({
      ...editing,
      profile: {
        ...p,
        aiName: p.userName,
        userName: p.aiName,
        relationship: p.relationship,
        personality: '',
        speakingStyle: '',
        catchphrases: '',
        emotionalPattern: '',
        notes: p.notes ? `${p.notes}\n[已交换身份，请重新点击"AI分析"获取正确性格]` : '[已交换身份，请重新点击"AI分析"获取正确性格]',
      },
    });
    message.info('身份已交换！保存后如性格描述不对，可重新点击"AI分析"');
  };

  const handleSaveProfile = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await api.post('/import/apply', { taskId: editing.taskId, profile: editing.profile });
      message.success('AI 陪伴配置已应用！');
      setEditing(null);
    } catch (err: any) {
      message.error(err.response?.data?.error || '保存失败');
    }
    setSaving(false);
  };

  const handleCreateCharacter = async (official: boolean) => {
    if (!editing) return;
    const p = editing.profile;
    setSaving(true);
    try {
      const payload = {
        name: p.aiName || '导入角色',
        tagline: p.relationship || '',
        personality: [p.personality, p.speakingStyle, p.emotionalPattern].filter(Boolean).join('\n'),
        description: `从聊天记录导入。${p.relationship ? '关系: ' + p.relationship : ''}`,
        tags: ['导入', '聊天分析'].concat(p.relationship ? [p.relationship] : []),
        prompt: [
          `你是${p.aiName}，正在和${p.userName}聊天。`,
          p.relationship ? `关系：${p.relationship}` : '',
          `性格：${p.personality}`,
          `风格：${p.speakingStyle}`,
          p.catchphrases ? `口头禅：${p.catchphrases}` : '',
        ].filter(Boolean).join('\n'),
        category: official ? 'official' : 'custom',
      };
      const { data } = await api.post('/characters/custom', payload);
      // 自动激活
      if (data.character?.id) {
        await api.post(`/characters/${data.character.id}/activate`, {}).catch(() => {});
      }
      message.success(official ? `已创建并激活角色"${payload.name}"` : `角色"${payload.name}"已创建并激活！`);
      setEditing(null);
    } catch (err: any) {
      message.error(err.response?.data?.error || '创建失败');
    }
    setSaving(false);
  };

  const handleDelete = async (taskId: number) => {
    try {
      await api.delete(`/import/${taskId}`);
      message.success('已删除');
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch { message.error('删除失败'); }
  };

  const statusTag = (s: string) => {
    const m: any = { uploading: <Tag color="orange">上传中</Tag>, pending: <Tag>等待处理</Tag>, processing: <Tag color="blue">处理中</Tag>, done: <Tag color="green">完成</Tag>, error: <Tag color="red">失败</Tag> };
    return m[s] || <Tag>{s}</Tag>;
  };

  const updateProfile = (key: keyof ChatProfile, value: string) => {
    if (!editing) return;
    setEditing({ ...editing, profile: { ...editing.profile, [key]: value } });
  };

  const profileFields: { key: keyof ChatProfile; label: string; placeholder: string; rows?: number }[] = [
    { key: 'aiName', label: 'AI 是谁（对方）', placeholder: '对方的昵称或称呼' },
    { key: 'userName', label: '用户是谁（你）', placeholder: '你的名字或昵称' },
    { key: 'relationship', label: '你们的关系', placeholder: '如：情侣 / 朋友 / 同事 / 家人' },
    { key: 'personality', label: '性格特征', placeholder: '对方的性格描述', rows: 3 },
    { key: 'speakingStyle', label: '说话风格', placeholder: '如：温柔细腻、爱用表情包', rows: 2 },
    { key: 'catchphrases', label: '口头禅 / 常用语', placeholder: '逗号分隔，如：笑死, 好家伙, 嗯嗯' },
    { key: 'emotionalPattern', label: '情绪模式', placeholder: '如：乐观积极 / 容易焦虑 / 温柔体贴' },
    { key: 'notes', label: '其他备注', placeholder: '其他想让 AI 知道的特征或注意事项', rows: 2 },
  ];

  return <>
    <Typography.Title level={4}>聊天记录导入</Typography.Title>
    <Typography.Paragraph type="secondary">
      上传微信聊天记录，AI 分析对话风格并生成角色。支持大文件，显示上传进度。
    </Typography.Paragraph>

    <Card style={{ marginBottom: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Upload beforeUpload={handleUpload} showUploadList={false}
          accept=".html,.txt,.csv,.json,.zip,.gz,.tgz" disabled={uploading}>
          <Button icon={uploading ? <CloudUploadOutlined /> : <UploadOutlined />}
            loading={uploading && uploadProgress === 0} size="large">
            {uploading ? uploadLabel || '上传中...' : '上传聊天记录文件'}
          </Button>
        </Upload>
        {uploading && uploadProgress > 0 && (
          <Progress percent={uploadProgress} status="active" strokeColor={{ from: '#108ee9', to: '#87d068' }} />
        )}
      </Space>
    </Card>

    {tasks.length > 0 && (
      <Table dataSource={tasks} rowKey="id" columns={[
        { title: '#', width: 50, render: (_: any, __: any, idx: number) => idx + 1 },
        { title: '文件名', dataIndex: 'filename', ellipsis: true },
        { title: '状态', dataIndex: 'status', width: 90, render: statusTag },
        { title: '消息', dataIndex: 'message_count', width: 70 },
        { title: '表情', width: 70, render: (_: any, r: any) => r.meta?.stickers > 0 ? <Tag color="purple">{r.meta.stickers}</Tag> : '-' },
        {
          title: '操作', width: 220, render: (_: any, r: any) => (
            <Space size="small">
              {r.status === 'done' && !r.profile && (
                <Button size="small" icon={<RobotOutlined />} onClick={() => handleAnalyze(r.id)}>AI 分析</Button>
              )}
              {r.profile && (
                <Button size="small" type="primary" icon={<EditOutlined />}
                  onClick={() => setEditing({ taskId: r.id, profile: r.profile, senders: r.senders || [] })}>
                  微调
                </Button>
              )}
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(r.id)}>删除</Button>
            </Space>
          ),
        },
      ]} pagination={false} />
    )}

    {/* ---- 微调编辑弹窗 ---- */}
    <Modal
      title={<Space><EditOutlined /> 微调 AI 角色设定</Space>}
      open={!!editing}
      onCancel={() => setEditing(null)}
      width={640}
      footer={[
        <Button key="swap" icon={<SwapOutlined />} onClick={handleSwapIdentity}
          style={{ borderColor: '#faad14', color: '#d48806' }}>
          身份反了？互换
        </Button>,
        <Button key="cancel" onClick={() => setEditing(null)}>取消</Button>,
        <Button key="save" icon={<SaveOutlined />} loading={saving} onClick={handleSaveProfile}>
          保存并应用
        </Button>,
        <Button key="createChar" type="primary" icon={<RobotOutlined />} loading={saving}
          onClick={() => handleCreateCharacter(false)}>
          创建为角色
        </Button>,
      ]}
    >
      {editing && (
        <>
          <Alert type="info" showIcon style={{ marginBottom: 16 }}
            message="以下是 AI 自动分析的结果，你可以修改任何字段后再保存。" />

          <Row gutter={[16, 12]}>
            {profileFields.map(f => (
              <Col span={f.key === 'personality' || f.key === 'notes' ? 24 : 12} key={f.key}>
                <div style={{ marginBottom: 4 }}>
                  <AntText strong style={{ fontSize: 13 }}>{f.label}</AntText>
                </div>
                {f.rows ? (
                  <TextArea
                    value={editing.profile[f.key]}
                    onChange={e => updateProfile(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    rows={f.rows}
                    style={{ fontSize: 13 }}
                  />
                ) : (
                  <Input
                    value={editing.profile[f.key]}
                    onChange={e => updateProfile(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    style={{ fontSize: 13 }}
                  />
                )}
              </Col>
            ))}
          </Row>

          {editing.senders.length > 0 && (
            <div style={{ marginTop: 12, color: '#888', fontSize: 12 }}>
              聊天参与者：{editing.senders.join('、')}
            </div>
          )}
        </>
      )}
    </Modal>
  </>;
}
