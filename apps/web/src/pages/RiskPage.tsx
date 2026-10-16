import { RiskEngine, type RiskHit } from '@hsj/shared';
import { Card, Input, Space, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';

const engine = new RiskEngine();
const LEVEL: Record<string, { color: string; text: string }> = {
  block: { color: 'red', text: '拦截' },
  warn: { color: 'orange', text: '警告' },
  pass: { color: 'green', text: '放行' },
};

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

export function RiskPage() {
  const [text, setText] = useState('每天吃两个，润 肠 通便，秋天最好的伴手礼！想要的加我VX。');
  const hits = useMemo(() => engine.scan(text), [text]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={3} style={{ margin: 0 }}>内容风控</Typography.Title>
      <Card title="风控试一试">
        <Input.TextArea id="risk-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ marginTop: 12 }}>
          <Highlighted text={text} hits={hits} />
        </div>
      </Card>
      <Card title={`命中 ${hits.length} 处`}>
        <Table
          rowKey={(h) => `${h.start}-${h.word}`}
          pagination={false}
          dataSource={hits}
          columns={[
            { title: '命中', dataIndex: 'matched' },
            { title: '类别', dataIndex: 'category' },
            { title: '级别', dataIndex: 'level', render: (l: string) => <Tag color={LEVEL[l].color}>{LEVEL[l].text}</Tag> },
            { title: '建议改为', dataIndex: 'suggestion', render: (s?: string) => s ?? '—' },
          ]}
        />
      </Card>
    </Space>
  );
}
