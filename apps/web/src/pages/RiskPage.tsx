import type { RiskHit } from '@hsj/shared';
import { App, Card, Form, Input, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { CrudTable } from '../components/CrudTable';
import { api, PLATFORM_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

const LEVEL: Record<string, { color: string; text: string }> = {
  block: { color: 'red', text: '拦截' },
  warn: { color: 'orange', text: '警告' },
  pass: { color: 'green', text: '放行' },
};
const levelTag = (l: string) => <Tag color={LEVEL[l]?.color}>{LEVEL[l]?.text ?? l}</Tag>;
/** antd 的 Select 选项不能用 null，用占位值代表“全部平台” */
const ALL = 'ALL';
const platformOptions = Object.entries(PLATFORM_LABEL).map(([value, label]) => ({ value, label }));

interface RiskWord {
  id: string;
  word: string;
  category: string;
  level: string;
  platform: string | null;
  whitelist: boolean;
  suggestion: string | null;
}

function Highlighted({ text, hits }: { text: string; hits: RiskHit[] }) {
  const parts: React.ReactNode[] = [];
  let i = 0;
  hits.forEach((h, k) => {
    parts.push(text.slice(i, h.start));
    parts.push(
      <mark key={k} style={{ background: h.level === 'block' ? '#FBE4E2' : '#FBF0DC', padding: '0 2px' }}>
        {h.matched}
      </mark>,
    );
    i = h.end;
  });
  parts.push(text.slice(i));
  return <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.9 }}>{parts}</div>;
}

/** 用后端词库实时检测，与稿件和自动回复走同一套规则。 */
function Tester() {
  const [text, setText] = useState('每天吃两个，润 肠 通便，富含膳食纤维，秋天最好的伴手礼！想要的加我VX。');
  const [platform, setPlatform] = useState('XHS');
  const [result, setResult] = useState<{ blocked: boolean; hits: RiskHit[] }>({ blocked: false, hits: [] });

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ blocked: boolean; hits: RiskHit[] }>('/risk/check', { method: 'POST', body: { text, platform } }).then(
        setResult,
        () => undefined,
      );
    }, 300);
    return () => clearTimeout(t);
  }, [text, platform]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="风控试一试"
        extra={<Select size="small" value={platform} onChange={setPlatform} options={platformOptions} style={{ width: 100 }} />}
      >
        <Input.TextArea id="risk-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ marginTop: 12 }}>
          <Highlighted text={text} hits={result.hits} />
        </div>
      </Card>
      <Card title={result.blocked ? `命中 ${result.hits.length} 处，含拦截词，不能发布` : `命中 ${result.hits.length} 处`}>
        <Table
          rowKey={(h) => `${h.start}-${h.word}`}
          pagination={false}
          dataSource={result.hits}
          columns={[
            { title: '命中', dataIndex: 'matched' },
            { title: '类别', dataIndex: 'category' },
            { title: '级别', dataIndex: 'level', render: levelTag },
            { title: '建议改为', dataIndex: 'suggestion', render: (s?: string) => s ?? '—' },
          ]}
        />
      </Card>
    </Space>
  );
}

function Words() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  return (
    <CrudTable<RiskWord>
      entity="风控词"
      listPath={`/risk/words${q ? `?q=${encodeURIComponent(q)}` : ''}`}
      basePath="/risk/words"
      canEdit={can('REVIEWER')}
      extra={<Input.Search placeholder="搜索词" allowClear onSearch={setQ} style={{ width: 200 }} />}
      initialValues={{ level: 'warn', platform: ALL, whitelist: false }}
      toForm={(w) => ({ ...w, platform: w.platform ?? ALL })}
      toBody={(v) => ({ ...v, platform: v.platform === ALL ? null : v.platform, suggestion: v.suggestion || undefined })}
      columns={[
        { title: '词', dataIndex: 'word' },
        { title: '类别', dataIndex: 'category' },
        { title: '级别', dataIndex: 'level', render: levelTag },
        { title: '平台', dataIndex: 'platform', render: (p: string | null) => (p ? PLATFORM_LABEL[p] : '全部') },
        { title: '白名单', dataIndex: 'whitelist', render: (w: boolean) => (w ? <Tag color="green">白名单</Tag> : '—') },
        { title: '建议改为', dataIndex: 'suggestion', render: (s: string | null) => s ?? '—' },
      ]}
      form={
        <>
          <Form.Item label="词" name="word" rules={[{ required: true, message: '请填写词' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="类别" name="category" rules={[{ required: true, message: '请填写类别' }]}>
            <Input placeholder="如：医疗功效、极限用语、导流" />
          </Form.Item>
          <Form.Item label="级别" name="level">
            <Select options={Object.entries(LEVEL).map(([value, l]) => ({ value, label: l.text }))} />
          </Form.Item>
          <Form.Item label="适用平台" name="platform">
            <Select options={[{ value: ALL, label: '全部平台' }, ...platformOptions]} />
          </Form.Item>
          <Form.Item label="白名单（包含它的句子不再被其他词拦截）" name="whitelist" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="建议改为" name="suggestion">
            <Input />
          </Form.Item>
        </>
      }
    />
  );
}

function TopWords() {
  const { message } = App.useApp();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<{ word: string; level: string; category: string; count: number }[]>([]);
  useEffect(() => {
    api<typeof rows>(`/risk/stats/top-words?days=${days}`).then(setRows, (e) => message.error(e.message));
  }, [days, message]);
  return (
    <>
      <Select
        value={days}
        onChange={setDays}
        style={{ marginBottom: 12, width: 120 }}
        options={[7, 30, 90].map((d) => ({ value: d, label: `近 ${d} 天` }))}
      />
      <Table
        rowKey={(r) => `${r.word}-${r.level}`}
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: '这段时间没有命中记录' }}
        columns={[
          { title: '词', dataIndex: 'word' },
          { title: '类别', dataIndex: 'category' },
          { title: '级别', dataIndex: 'level', render: levelTag },
          { title: '命中次数', dataIndex: 'count' },
        ]}
      />
    </>
  );
}

export function RiskPage() {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>内容风控</Typography.Title>
      <Tabs
        items={[
          { key: 'test', label: '试一试', children: <Tester /> },
          { key: 'words', label: '词库', children: <Words /> },
          { key: 'top', label: '高频命中', children: <TopWords /> },
        ]}
      />
    </Space>
  );
}
