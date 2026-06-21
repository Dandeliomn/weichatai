import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, message, Grid } from 'antd';
import { UserOutlined, LockOutlined, SafetyOutlined, KeyOutlined } from '@ant-design/icons';
import api from '../api/client';

const { useBreakpoint } = Grid;

export default function Register() {
  const [loading, setLoading] = useState(false);
  const [captchaSvg, setCaptchaSvg] = useState('');
  const [captchaId, setCaptchaId] = useState('');
  const navigate = useNavigate();
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  const fetchCaptcha = async () => {
    const { data } = await api.get('/auth/captcha?format=json');
    setCaptchaSvg(data.svg); setCaptchaId(data.captchaId);
  };

  const handleSubmit = async (values: any) => {
    setLoading(true);
    try {
      await api.post('/auth/register', {
        email: values.username,
        password: values.password,
        inviteCode: values.inviteCode,
        captchaId,
        captchaAnswer: values.captcha,
      });
      message.success('注册成功！请登录');
      navigate('/login');
    } catch (err: any) {
      message.error(err.response?.data?.error || '注册失败');
      fetchCaptcha();
    } finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: '#f0f2f5', padding: isMobile ? 16 : 0 }}>
      <Card style={{ width: '100%', maxWidth: 400 }} title={<Typography.Title level={isMobile ? 4 : 3} style={{ textAlign: 'center', margin: 0 }}>📝 注册账号</Typography.Title>}>
        <Form onFinish={handleSubmit} size={isMobile ? "middle" : "large"} initialValues={{ captchaId: '' }}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, min: 6, message: '密码至少6位' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Form.Item name="inviteCode" rules={[{ required: true, message: '请输入邀请码' }]}>
            <Input prefix={<KeyOutlined />} placeholder="邀请码" />
          </Form.Item>
          <Form.Item name="captcha" rules={[{ required: true, message: '请输入验证码' }]}>
            <Input prefix={<SafetyOutlined />} placeholder="验证码" onFocus={() => !captchaSvg && fetchCaptcha()} />
          </Form.Item>
          {captchaSvg && (
            <div dangerouslySetInnerHTML={{ __html: captchaSvg }} style={{ marginBottom: 16, cursor: 'pointer', maxWidth: '100%', overflow: 'hidden' }} onClick={fetchCaptcha} />
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>注册</Button>
          </Form.Item>
          <Typography.Text type="secondary">已有账号？<Link to="/login">去登录</Link></Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
