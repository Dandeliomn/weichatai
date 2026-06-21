import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, message, Grid } from 'antd';
import { UserOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { useAuth } from '../hooks/useAuth';
import api from '../api/client';

const { useBreakpoint } = Grid;

export default function Login() {
  const [loading, setLoading] = useState(false);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const fetchCaptcha = async () => {
    const { data } = await api.get('/auth/captcha?format=json');
    setCaptchaSvg(data.svg); setCaptchaId(data.captchaId); setNeedCaptcha(true);
  };

  const handleSubmit = async (values: { email: string; password: string; captcha?: string }) => {
    setLoading(true);
    try {
      await login(values.email, values.password, captchaId, values.captcha);
      message.success('登录成功'); navigate('/');
    } catch (err: any) { message.error(err.response?.data?.error || '登录失败'); if (err.response?.data?.error?.includes('验证码')) fetchCaptcha(); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      minHeight: '100vh', background: '#f0f2f5',
      padding: isMobile ? 16 : 0,
    }}>
      <Card style={{
        width: '100%', maxWidth: 400,
        margin: isMobile ? '0 auto' : undefined,
      }} title={<Typography.Title level={isMobile ? 4 : 3} style={{ textAlign: 'center', margin: 0 }}>💬 情感陪伴AI 管理后台</Typography.Title>}>
        <Form onFinish={handleSubmit} size={isMobile ? "middle" : "large"}>
          <Form.Item name="email" rules={[{ required: true, message: '请输入账号' }]}><Input prefix={<UserOutlined />} placeholder="账号" /></Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} placeholder="密码" /></Form.Item>
          {needCaptcha && <>
            <Form.Item name="captcha" rules={[{ required: true, message: '请输入验证码' }]}><Input prefix={<SafetyOutlined />} placeholder="验证码" /></Form.Item>
            <div dangerouslySetInnerHTML={{ __html: captchaSvg }} style={{ marginBottom: 16, cursor: 'pointer', maxWidth: '100%', overflow: 'hidden' }} onClick={fetchCaptcha} />
          </>}
          <Form.Item><Button type="primary" htmlType="submit" loading={loading} block>登录</Button></Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: isMobile ? 13 : 14 }}>没有账号？<Link to="/register">去注册</Link></Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
