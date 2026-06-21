import React from 'react';
import { Card, Statistic } from 'antd';

export default function StatCard({ title, value, suffix, icon, color }: { title: string; value: number | string; suffix?: string; icon?: React.ReactNode; color?: string }) {
  return <Card bordered={false} style={{ borderTop: `3px solid ${color || '#1890ff'}` }}><Statistic title={title} value={value} suffix={suffix} prefix={icon} /></Card>;
}
