import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import { RequireAuth } from './lib/auth';
import { AddressPage } from './pages/AddressPage';
import { DraftDetailPage, DraftsPage } from './pages/DraftsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LoginPage } from './pages/LoginPage';
import { Placeholder } from './pages/Placeholder';
import { RiskPage } from './pages/RiskPage';
import { SchedulePage } from './pages/SchedulePage';
import { AccountsPage, MembersPage } from './pages/SettingsPages';
import { TopicsPage } from './pages/TopicsPage';

interface NavItem {
  path: string;
  label: string;
  task: string;
  /** 只对这些角色显示（管理员总能看到）；不填则所有成员可见 */
  roles?: string[];
}

export const NAV: { group: string; items: NavItem[] }[] = [
  { group: '总览', items: [{ path: 'overview', label: '数据周报', task: 'M12' }] },
  {
    group: '内容',
    items: [
      { path: 'topics', label: '选题清单', task: 'M3' },
      { path: 'drafts', label: '稿件', task: 'M4、M6' },
      { path: 'schedule', label: '排期发布', task: 'M7' },
    ],
  },
  {
    group: '接待与客资',
    items: [
      { path: 'inbox', label: '收件箱', task: 'M8' },
      { path: 'leads', label: '线索库', task: 'M10' },
      { path: 'orders', label: '成交导入', task: 'M11' },
    ],
  },
  {
    group: '底座',
    items: [
      { path: 'risk', label: '内容风控', task: 'M5' },
      { path: 'kb', label: '品牌知识库', task: 'M2' },
    ],
  },
  {
    group: '设置',
    items: [
      { path: 'members', label: '成员与权限', task: 'M1', roles: ['ADMIN'] },
      { path: 'accounts', label: '平台账号', task: 'M1' },
    ],
  },
];

const built: Record<string, React.ReactNode> = {
  topics: <TopicsPage />,
  drafts: <DraftsPage />,
  schedule: <SchedulePage />,
  risk: <RiskPage />,
  kb: <KnowledgePage />,
  leads: <AddressPage />,
  members: <MembersPage />,
  accounts: <AccountsPage />,
};

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      ...NAV.flatMap((g) => g.items).map((i) => ({
        path: i.path,
        element: built[i.path] ?? <Placeholder title={i.label} task={i.task} />,
      })),
      { path: 'drafts/:id', element: <DraftDetailPage /> },
    ],
  },
]);
