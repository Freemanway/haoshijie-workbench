import { Card, Form, Image, Input, List, Select, Space, Tabs, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { CrudTable } from '../components/CrudTable';
import { api, AUDIENCE_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

const KIND_LABEL: Record<string, string> = {
  variety: '品种',
  origin: '产地',
  season: '上市时间',
  price: '价格规格',
  compliance: '合规口径',
};
const FAQ_CATEGORIES = ['价格规格', '品种区别', '上市时间', '发货与配送范围', '保存方法', '售后', '企业采购', '代理政策'];
/** antd 的 Select 选项不能用 null，用占位值代表“通用” */
const ANY = 'ANY';
const required = (message: string) => [{ required: true, message }];
const clip = (s: string) => <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0, maxWidth: 480 }}>{s}</Typography.Paragraph>;

interface Item { id: string; kind: string; title: string; content: string }
interface Faq { id: string; category: string; question: string; answer: string; audience: string | null }
interface Asset { id: string; title: string; url: string; kind: string; tags: string[] }

function Items({ canEdit }: { canEdit: boolean }) {
  const [kind, setKind] = useState<string>();
  return (
    <CrudTable<Item>
      entity="知识条目"
      listPath={`/knowledge/items${kind ? `?kind=${kind}` : ''}`}
      basePath="/knowledge/items"
      canEdit={canEdit}
      initialValues={{ kind: kind ?? 'variety' }}
      extra={
        <Select allowClear placeholder="全部分类" value={kind} onChange={setKind} style={{ width: 140 }}
          options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
      }
      columns={[
        { title: '分类', dataIndex: 'kind', width: 100, render: (k: string) => <Tag>{KIND_LABEL[k] ?? k}</Tag> },
        { title: '标题', dataIndex: 'title', width: 200 },
        { title: '内容', dataIndex: 'content', render: clip },
      ]}
      form={
        <>
          <Form.Item label="分类" name="kind">
            <Select options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item label="标题" name="title" rules={required('请填写标题')}><Input /></Form.Item>
          <Form.Item label="内容" name="content" rules={required('请填写内容')}><Input.TextArea rows={6} /></Form.Item>
        </>
      }
    />
  );
}

function Faqs({ canEdit }: { canEdit: boolean }) {
  const [category, setCategory] = useState<string>();
  return (
    <CrudTable<Faq>
      entity="FAQ"
      listPath={`/knowledge/faqs${category ? `?category=${encodeURIComponent(category)}` : ''}`}
      basePath="/knowledge/faqs"
      canEdit={canEdit}
      initialValues={{ category: category ?? FAQ_CATEGORIES[0], audience: ANY }}
      toForm={(f) => ({ ...f, audience: f.audience ?? ANY })}
      toBody={(v) => ({ ...v, audience: v.audience === ANY ? null : v.audience })}
      extra={
        <Select allowClear placeholder="全部类别" value={category} onChange={setCategory} style={{ width: 160 }}
          options={FAQ_CATEGORIES.map((c) => ({ value: c, label: c }))} />
      }
      columns={[
        { title: '类别', dataIndex: 'category', width: 120 },
        { title: '问题', dataIndex: 'question', width: 220 },
        { title: '答案', dataIndex: 'answer', render: clip },
        { title: '适用', dataIndex: 'audience', width: 80, render: (a: string | null) => (a ? AUDIENCE_LABEL[a] : '通用') },
      ]}
      form={
        <>
          <Form.Item label="类别" name="category">
            <Select options={FAQ_CATEGORIES.map((c) => ({ value: c, label: c }))} />
          </Form.Item>
          <Form.Item label="问题" name="question" rules={required('请填写问题')}><Input /></Form.Item>
          <Form.Item label="标准答案" name="answer" rules={required('请填写答案')}><Input.TextArea rows={5} /></Form.Item>
          <Form.Item label="适用客户" name="audience">
            <Select options={[{ value: ANY, label: '通用' }, { value: 'C', label: 'C 端' }, { value: 'B', label: 'B 端' }]} />
          </Form.Item>
        </>
      }
    />
  );
}

function Assets({ canEdit }: { canEdit: boolean }) {
  const [tag, setTag] = useState('');
  return (
    <CrudTable<Asset>
      entity="素材"
      listPath={`/knowledge/assets${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`}
      basePath="/knowledge/assets"
      canEdit={canEdit}
      initialValues={{ kind: 'image', tags: [] }}
      extra={<Input.Search placeholder="按标签筛选" allowClear onSearch={setTag} style={{ width: 200 }} />}
      columns={[
        {
          title: '预览', dataIndex: 'url', width: 90,
          render: (u: string, r) => (r.kind === 'image' ? <Image src={u} width={64} height={64} style={{ objectFit: 'cover' }} /> : <Tag>视频</Tag>),
        },
        { title: '名称', dataIndex: 'title' },
        { title: '标签', dataIndex: 'tags', render: (t: string[]) => t.map((x) => <Tag key={x}>{x}</Tag>) },
      ]}
      form={
        <>
          <Form.Item label="名称" name="title" rules={required('请填写素材名称')}><Input /></Form.Item>
          <Form.Item label="地址" name="url" rules={required('请填写素材地址')}>
            <Input placeholder="对象存储上的图片或视频地址（上传功能后续接入）" />
          </Form.Item>
          <Form.Item label="类型" name="kind">
            <Select options={[{ value: 'image', label: '图片' }, { value: 'video', label: '视频' }]} />
          </Form.Item>
          <Form.Item label="标签" name="tags">
            <Select mode="tags" placeholder="如：波姬红、果园、开箱" />
          </Form.Item>
        </>
      }
    />
  );
}

/** 检索：AI 生成和自动回复取依据的同一个入口，运营可以先在这里查口径。 */
function Search() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ items: Item[]; faqs: Faq[] }>({ items: [], faqs: [] });
  useEffect(() => {
    if (!q) return setRes({ items: [], faqs: [] });
    api<typeof res>(`/knowledge/search?q=${encodeURIComponent(q)}`).then(setRes, () => undefined);
  }, [q]);
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Input.Search placeholder="输入客户会问的话，如：能放几天" enterButton="检索" onSearch={(v) => setQ(v.trim())} style={{ maxWidth: 480 }} />
      {q && (
        <>
          <Card size="small" title={`知识条目 ${res.items.length}`}>
            <List dataSource={res.items} locale={{ emptyText: '没有匹配' }}
              renderItem={(i) => <List.Item><List.Item.Meta title={<><Tag>{KIND_LABEL[i.kind]}</Tag>{i.title}</>} description={i.content} /></List.Item>} />
          </Card>
          <Card size="small" title={`FAQ ${res.faqs.length}`}>
            <List dataSource={res.faqs} locale={{ emptyText: '没有匹配' }}
              renderItem={(f) => <List.Item><List.Item.Meta title={f.question} description={f.answer} /></List.Item>} />
          </Card>
        </>
      )}
    </Space>
  );
}

export function KnowledgePage() {
  const { can } = useAuth();
  const canEdit = can('CONTENT');
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>品牌知识库</Typography.Title>
        <Typography.Text type="secondary">AI 写稿和自动回复只用这里的内容作依据{canEdit ? '' : '，你当前只能查看'}</Typography.Text>
      </div>
      <Tabs
        items={[
          { key: 'items', label: '知识条目', children: <Items canEdit={canEdit} /> },
          { key: 'faqs', label: 'FAQ', children: <Faqs canEdit={canEdit} /> },
          { key: 'assets', label: '素材库', children: <Assets canEdit={canEdit} /> },
          { key: 'search', label: '检索', children: <Search /> },
        ]}
      />
    </Space>
  );
}
