import { Alert, Button, Card, Divider, Form, Input, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, tokenStore } from '../lib/api';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [opts, setOpts] = useState<{ wecom: boolean; devLogin: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 企业微信回调把令牌放在 #token= 里
  useEffect(() => {
    const m = window.location.hash.match(/token=([^&]+)/);
    if (m) {
      tokenStore.set(decodeURIComponent(m[1]));
      window.history.replaceState(null, '', '/login');
      void refresh().then(() => navigate('/', { replace: true }));
    }
    api<{ wecom: boolean; devLogin: boolean }>('/auth/options').then(setOpts, () => setError('连不上后端服务'));
  }, [refresh, navigate]);

  if (me) return <Navigate to="/" replace />;

  const devLogin = async ({ wecomId }: { wecomId: string }) => {
    setBusy(true);
    setError('');
    try {
      const { token } = await api<{ token: string }>('/auth/dev-login', { method: 'POST', body: { wecomId } });
      tokenStore.set(token);
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#F7F3F0', padding: 16 }}>
      <Card style={{ width: 380, maxWidth: '100%' }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>好时节·AI工作台</Typography.Title>
            <Typography.Text type="secondary">仅限管理员已添加的成员登录</Typography.Text>
          </div>
          {error && <Alert type="error" showIcon message={error} />}
          {opts?.wecom && (
            <Button type="primary" size="large" block href="/api/auth/wecom/login">企业微信扫码登录</Button>
          )}
          {opts && !opts.wecom && !opts.devLogin && (
            <Alert type="warning" showIcon message="还没有配置企业微信登录，请联系管理员" />
          )}
          {opts?.devLogin && (
            <>
              {opts.wecom && <Divider plain>开发环境</Divider>}
              <Form layout="vertical" onFinish={devLogin}>
                <Form.Item label="企业微信成员账号" name="wecomId" rules={[{ required: true, message: '请填写成员账号' }]}>
                  <Input id="wecomId" />
                </Form.Item>
                <Button htmlType="submit" block loading={busy}>开发登录</Button>
              </Form>
            </>
          )}
        </Space>
      </Card>
    </div>
  );
}
