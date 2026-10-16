import { Result } from 'antd';

export function Placeholder({ title, task }: { title: string; task: string }) {
  return <Result status="info" title={title} subTitle={`开发中，对应研发任务 ${task}。交互参考一期原型。`} />;
}
