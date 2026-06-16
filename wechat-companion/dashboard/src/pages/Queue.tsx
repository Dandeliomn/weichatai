import React, { useEffect, useState, useRef } from 'react';
import { Card, Row, Col, Statistic, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, ClockCircleOutlined, PauseCircleOutlined } from '@ant-design/icons';
import axios from 'axios';
import api from '../api/client';

export default function Queue() {
  const [queue, setQueue] = useState<any>({}); const [health, setHealth] = useState<any>({});
  const timer = useRef<any>(null);

  useEffect(() => {
    const fetch = async () => { try { const [q, h] = await Promise.all([api.get('/admin/queue'), axios.get('/health')]); setQueue(q.data); setHealth(h.data); } catch {} };
    fetch(); timer.current = setInterval(fetch, 5000);
    return () => clearInterval(timer.current);
  }, []);

  return <>
    <Typography.Title level={4}>队列监控</Typography.Title>
    <Typography.Text type="secondary">每5秒自动刷新</Typography.Text>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={4}><Card><Statistic title="⏳ 等待中" value={queue.waiting || 0} prefix={<ClockCircleOutlined />} /></Card></Col>
      <Col span={4}><Card><Statistic title="🔄 处理中" value={queue.active || 0} prefix={<SyncOutlined spin={queue.active > 0} />} valueStyle={{ color: queue.active > 0 ? '#1890ff' : undefined }} /></Card></Col>
      <Col span={4}><Card><Statistic title="⏸️ 延迟" value={queue.delayed || 0} prefix={<PauseCircleOutlined />} /></Card></Col>
      <Col span={4}><Card><Statistic title="✅ 已完成" value={queue.completed || 0} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} /></Card></Col>
      <Col span={4}><Card><Statistic title="❌ 失败" value={queue.failed || 0} prefix={<CloseCircleOutlined />} valueStyle={{ color: queue.failed ? '#ff4d4f' : undefined }} /></Card></Col>
    </Row>
    <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
      <Col span={24}><Card title="服务状态">
        <p>Redis: {health?.services?.redis || '-'} | PG: {health?.services?.postgres || '-'} | Queue: {health?.services?.queue?.status || '-'} | Overall: {health?.status || '-'}</p>
      </Card></Col>
    </Row>
  </>;
}
