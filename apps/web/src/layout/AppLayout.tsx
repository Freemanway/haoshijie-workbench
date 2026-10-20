import { MenuOutlined } from '@ant-design/icons';
import { Button, Drawer, Grid, Layout, Menu, Space, Typography } from 'antd';
import { useState } from 'react';
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
  // 手机和窄屏：侧边栏收进抽屉，点了菜单就关上，正文不被挤窄
  const wide = Grid.useBreakpoint().lg !== false;
  const [open, setOpen] = useState(false);
  const brand = (
    <div style={{ padding: '16px 20px' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>好时节·AI工作台</Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>无花果产地直供 · 内部系统</Typography.Text>
    </div>
  );
  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[`/${pathname.split('/')[1]}`]}
      items={items}
      onClick={(e) => {
        setOpen(false);
        navigate(e.key);
      }}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {wide ? (
        <Layout.Sider width={216} theme="light">
          {brand}
          {menu}
        </Layout.Sider>
      ) : (
        <Drawer open={open} onClose={() => setOpen(false)} placement="left" width={240} closable={false} styles={{ body: { padding: 0 } }}>
          {brand}
          {menu}
        </Drawer>
      )}
      <Layout>
        <Layout.Header style={{ background: '#fff', padding: wide ? '0 24px' : '0 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          {wide ? <span /> : <Button type="text" icon={<MenuOutlined />} aria-label="打开菜单" onClick={() => setOpen(true)} />}
          <Space>
            <Typography.Text>{me?.name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {me?.roles.map((r) => ROLE_LABEL[r] ?? r).join('、')}
            </Typography.Text>
            <Button size="small" onClick={() => { logout(); navigate('/login'); }}>退出</Button>
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: wide ? 24 : 16, minWidth: 0 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
