import { Button, Layout, Menu, Space, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { NAV } from '../router';

export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { me, logout, can } = useAuth();
  const items = NAV.map((g) => ({
    type: 'group' as const,
    label: g.group,
    children: g.items
      .filter((i) => !i.roles || can(...i.roles))
      .map((i) => ({ key: `/${i.path}`, label: i.label })),
  })).filter((g) => g.children.length);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0} width={216} theme="light">
        <div style={{ padding: '16px 20px' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>好时节·AI工作台</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>无花果产地直供 · 内部系统</Typography.Text>
        </div>
        <Menu mode="inline" selectedKeys={[pathname]} items={items} onClick={(e) => navigate(e.key)} />
      </Layout.Sider>
      <Layout>
        <Layout.Header style={{ background: '#fff', padding: '0 24px', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <Space>
            <Typography.Text>{me?.name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {me?.roles.map((r) => ROLE_LABEL[r] ?? r).join('、')}
            </Typography.Text>
            <Button size="small" onClick={() => { logout(); navigate('/login'); }}>退出</Button>
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
