import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import { AddressPage } from './pages/AddressPage';
import { Placeholder } from './pages/Placeholder';
import { RiskPage } from './pages/RiskPage';

export const NAV = [
  { group: '总览', items: [{ path: 'overview', label: '数据周报', task: 'M12' }] },
  {
    group: '内容',
    items: [
      { path: 'topics', label: '选题清单', task: 'M3' },
      { path: 'drafts', label: '稿件审核', task: 'M4、M6' },
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
];

const built: Record<string, React.ReactNode> = { risk: <RiskPage />, leads: <AddressPage /> };

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      ...NAV.flatMap((g) => g.items).map((i) => ({
        path: i.path,
        element: built[i.path] ?? <Placeholder title={i.label} task={i.task} />,
      })),
    ],
  },
]);
