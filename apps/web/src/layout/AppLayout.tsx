import { Layout, Menu, Typography } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NAV } from '../router';

export function AppLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const items = NAV.map((g) => ({
    type: 'group' as const,
    label: g.group,
    children: g.items.map((i) => ({ key: `/${i.path}`, label: i.label })),
  }));

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={0} width={216} theme="light">
        <div style={{ padding: '16px 20px' }}>
          <Typography.Title level={5} style={{ margin: 0 }}>好时节·AI工作台</Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>无花果产地直供 · 内部系统</Typography.Text>
        </div>
        <Menu mode="inline" selectedKeys={[pathname]} items={items} onClick={(e) => navigate(e.key)} />
      </Layout.Sider>
      <Layout.Content style={{ padding: 24 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
