import React, { useEffect, useState } from 'react';
import { Card, Upload, Button, Typography, message, Image, Row, Col, Empty, Popconfirm, Checkbox, Space, Badge } from 'antd';
import { UploadOutlined, DeleteOutlined, CheckSquareOutlined, BorderOutlined } from '@ant-design/icons';
import api from '../api/client';

export default function Stickers() {
  const [stickers, setStickers] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const fetchStickers = async () => {
    try { const { data } = await api.get('/user/stickers'); setStickers(data.stickers || []); } catch {}
  };

  useEffect(() => { fetchStickers(); }, []);

  const handleUpload = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.append('stickers', file);
    try {
      await api.post('/user/stickers', fd);
      message.success('上传成功');
      fetchStickers();
    } catch (err: any) { message.error(err.response?.data?.error || '上传失败'); }
    setUploading(false);
    return false;
  };

  const toggleSelect = (url: string) => {
    const next = new Set(selected);
    if (next.has(url)) next.delete(url); else next.add(url);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(stickers));
  const deselectAll = () => setSelected(new Set());

  const deleteSelected = async () => {
    if (selected.size === 0) { message.warning('请先选择要删除的表情包'); return; }
    setDeleting(true);
    try {
      const { data } = await api.delete('/user/stickers', { data: { files: [...selected] } });
      message.success(data.message || `已删除 ${data.deleted} 个表情`);
      setSelected(new Set());
      fetchStickers();
    } catch (err: any) { message.error(err.response?.data?.error || '删除失败'); }
    setDeleting(false);
  };

  const deleteAll = async () => {
    setDeleting(true);
    try {
      const { data } = await api.delete('/user/stickers', { data: { all: true } });
      message.success(data.message || `已删除全部表情`);
      setSelected(new Set());
      fetchStickers();
    } catch (err: any) { message.error(err.response?.data?.error || '删除失败'); }
    setDeleting(false);
  };

  const allSelected = stickers.length > 0 && selected.size === stickers.length;

  return <>
    <Typography.Title level={4}>我的表情包</Typography.Title>
    <Typography.Paragraph type="secondary">上传 GIF/PNG/JPG 表情包，AI 聊天时自动匹配发送。支持 zip 批量上传。</Typography.Paragraph>

    <Card style={{ marginBottom: 16 }}>
      <Space wrap size="middle">
        <Upload beforeUpload={handleUpload} showUploadList={false} accept=".gif,.png,.jpg,.jpeg,.webp,.zip" multiple>
          <Button icon={<UploadOutlined />} loading={uploading} size="large">上传表情包</Button>
        </Upload>

        {stickers.length > 0 && (
          <>
            <Button
              icon={allSelected ? <BorderOutlined /> : <CheckSquareOutlined />}
              onClick={allSelected ? deselectAll : selectAll}
            >
              {allSelected ? '取消全选' : '全选'}
            </Button>

            <Popconfirm
              title={`确定删除选中的 ${selected.size} 个表情？`}
              onConfirm={deleteSelected}
              okText="确定删除" cancelText="取消"
              disabled={selected.size === 0}
            >
              <Button
                danger
                icon={<DeleteOutlined />}
                disabled={selected.size === 0}
                loading={deleting && selected.size > 0}
              >
                删除选中
                {selected.size > 0 && <Badge count={selected.size} style={{ marginLeft: 4 }} color="#ff4d4f" />}
              </Button>
            </Popconfirm>

            <Popconfirm
              title={`确定删除全部 ${stickers.length} 个表情包？此操作不可恢复！`}
              onConfirm={deleteAll}
              okText="全部删除" cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<DeleteOutlined />} loading={deleting && selected.size === 0}>
                一键删除全部
              </Button>
            </Popconfirm>
          </>
        )}
      </Space>
    </Card>

    {stickers.length === 0 ? <Empty description="还没有表情包" /> : (
      <Row gutter={[12, 12]}>
        {stickers.map((url, i) => {
          const isSelected = selected.has(url);
          return (
            <Col key={i} span={4}>
              <Card
                size="small"
                hoverable
                onClick={() => toggleSelect(url)}
                style={isSelected ? { border: '2px solid #1677ff', boxShadow: '0 0 8px rgba(22,119,255,0.3)' } : {}}
                cover={
                  <div style={{ position: 'relative' }}>
                    <Image src={url} alt="sticker" style={{ maxHeight: 120, objectFit: 'contain' }} preview={{ mask: null }} />
                    <Checkbox
                      checked={isSelected}
                      style={{ position: 'absolute', top: 4, right: 4, zIndex: 1 }}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelect(url)}
                    />
                  </div>
                }
              />
            </Col>
          );
        })}
      </Row>
    )}
  </>;
}
