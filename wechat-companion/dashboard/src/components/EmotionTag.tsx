import React from 'react';
import { Tag } from 'antd';

const MAP: Record<string, { label: string; color: string }> = { happy: { label: '😊 开心', color: 'orange' }, sad: { label: '😢 悲伤', color: 'blue' }, angry: { label: '😠 愤怒', color: 'red' }, anxious: { label: '😰 焦虑', color: 'purple' }, neutral: { label: '😐 中性', color: 'default' } };

export default function EmotionTag({ emotion }: { emotion: string | null }) {
  if (!emotion) return <Tag>未知</Tag>;
  const info = MAP[emotion] || { label: emotion, color: 'default' };
  return <Tag color={info.color}>{info.label}</Tag>;
}
