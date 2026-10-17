import { addDays, nextMonday, type SeasonNode } from '@hsj/shared';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Slider,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CrudTable } from '../components/CrudTable';
import { AUDIENCE_LABEL, api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DRAFT_STATUS, Topic, TOPIC_SOURCE, TOPIC_STATUS, withWeekday, ymd } from '../lib/content';

interface Category { id: string; audience: 'C' | 'B'; name: string }
interface Settings { weeklyQuota: { XHS: number }; cRatio: number; seasonNodes: SeasonNode[]; autoGenerate: boolean }
interface Weekly { weekOf: string; weekEnd: string; confirmed: boolean; seasonNodes: SeasonNode[]; topics: Topic[] }

function useCategories() {
  const [cats, setCats] = useState<Category[]>([]);
  const load = useCallback(() => api<Category[]>('/topics/categories').then(setCats, () => undefined), []);
  useEffect(() => void load(), [load]);
  return { cats, reload: load };
}

/** 选题表单，清单和选题库共用。 */
function TopicFields({ cats }: { cats: Category[] }) {
  return (
    <>
      <Form.Item label="选题标题" name="title" rules={[{ required: true, message: '请填写选题标题' }]}><Input /></Form.Item>
      <Space size={12} style={{ display: 'flex' }}>
        <Form.Item label="客群" name="audience" style={{ width: 120 }}>
          <Select options={[{ value: 'C', label: 'C 端' }, { value: 'B', label: 'B 端' }]} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(a, b) => a.audience !== b.audience}>
          {({ getFieldValue }) => (
            <Form.Item label="类别" name="category" rules={[{ required: true, message: '请选择类别' }]} style={{ minWidth: 200 }}>
              <Select options={cats.filter((c) => c.audience === getFieldValue('audience')).map((c) => ({ value: c.name, label: c.name }))} />
            </Form.Item>
          )}
        </Form.Item>
      </Space>
      <Form.Item label="建议发布日期" name="suggestedDate" rules={[{ pattern: /^\d{4}-\d{2}-\d{2}$/, message: '格式为 YYYY-MM-DD' }]}>
        <Input placeholder="YYYY-MM-DD" />
      </Form.Item>
      <Form.Item label="季节节点" name="seasonTag"><Input placeholder="如：中秋、错峰上市期" /></Form.Item>
      <Form.Item label="选题理由" name="reason"><Input.TextArea rows={2} /></Form.Item>
    </>
  );
}

function WeeklyList() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('CONTENT');
  const navigate = useNavigate();
  const { cats } = useCategories();
  const [weekOf, setWeekOf] = useState(nextMonday());
  const [data, setData] = useState<Weekly | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Topic | 'new' | null>(null);
  const [initial, setInitial] = useState<Record<string, unknown>>({});
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    const w = await api<Weekly>(`/topics/weekly?weekOf=${weekOf}`);
    setData(w);
    setSelected(w.topics.filter((t) => t.status === 'PROPOSED').map((t) => t.id));
  }, [weekOf]);
  useEffect(() => void load().catch((e) => message.error(e.message)), [load, message]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) message.success(ok);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const proposed = data?.topics.filter((t) => t.status === 'PROPOSED') ?? [];
  const generate = (replace: boolean) =>
    run('gen', () => api('/topics/weekly/generate', { method: 'POST', body: { weekOf, replace } }), 'AI 已生成选题清单');

  const confirm = () =>
    modal.confirm({
      title: `确认 ${selected.length} 个选题并生成稿件？`,
      content: '没勾选的选题会归档。每个选题生成 2 个小红书版本，生成完可在“稿件审核”里查看。',
      onOk: () => run('confirm', () => api('/topics/weekly/confirm', { method: 'POST', body: { weekOf, topicIds: selected } }), '已确认，正在生成稿件'),
    });

  const save = async () => {
    const v = await form.validateFields();
    const body = { ...v, suggestedDate: v.suggestedDate || null, seasonTag: v.seasonTag || null, reason: v.reason || null };
    try {
      if (editing === 'new') await api('/topics', { method: 'POST', body: { ...body, weekOf } });
      else await api(`/topics/${(editing as Topic).id}`, { method: 'PATCH', body });
      setEditing(null);
      message.success('已保存');
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.errors?.length) form.setFields(e.errors.map((x) => ({ name: x.field.split('.'), errors: [x.message] })));
      else message.error((e as Error).message);
    }
  };

  const columns = [
    { title: '建议日期', dataIndex: 'suggestedDate', width: 110, render: withWeekday },
    { title: '客群', dataIndex: 'audience', width: 70, render: (a: string) => <Tag color={a === 'B' ? 'geekblue' : 'magenta'}>{AUDIENCE_LABEL[a]}</Tag> },
    { title: '类别', dataIndex: 'category', width: 130 },
    {
      title: '选题', dataIndex: 'title',
      render: (t: string, r: Topic) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{t}</Typography.Text>
          {r.reason && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.reason}</Typography.Text>}
        </Space>
      ),
    },
    { title: '节点', dataIndex: 'seasonTag', width: 100, render: (s: string | null) => (s ? <Tag>{s}</Tag> : '—') },
    {
      title: '状态', key: 'status', width: 150,
      render: (_: unknown, r: Topic) =>
        r.status === 'PROPOSED' ? (
          <Tag color="gold">待确认 · {TOPIC_SOURCE[r.source]}</Tag>
        ) : (
          <Space size={4} wrap>
            {r.drafts?.map((d) => (
              <Link key={d.id} to={`/drafts/${d.id}`}><Tag color={DRAFT_STATUS[d.status]?.color}>{DRAFT_STATUS[d.status]?.text}</Tag></Link>
            ))}
          </Space>
        ),
    },
    ...(canEdit
      ? [{
          title: '操作', key: 'ops', width: 130,
          render: (_: unknown, r: Topic) =>
            r.status === 'PROPOSED' && (
              <Space size={0}>
                <Button type="link" size="small" onClick={() => { setInitial({ ...r, suggestedDate: ymd(r.suggestedDate) }); setEditing(r); }}>改</Button>
                <Button type="link" size="small" loading={busy === r.id} onClick={() => run(r.id, () => api(`/topics/${r.id}/replace`, { method: 'POST' }), '已换一个')}>换一个</Button>
              </Space>
            ),
        }]
      : []),
  ];

  if (!data) return null;
  const generating = data.topics.some((t) => t.drafts?.some((d) => d.status === 'GENERATING'));
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Button onClick={() => setWeekOf(addDays(weekOf, -7))}>上一周</Button>
          <Typography.Text strong>{data.weekOf} 至 {data.weekEnd}</Typography.Text>
          <Button onClick={() => setWeekOf(addDays(weekOf, 7))}>下一周</Button>
          {weekOf !== nextMonday() && <Button type="link" onClick={() => setWeekOf(nextMonday())}>回到下周</Button>}
          {data.seasonNodes.map((n) => <Tag key={n.name} color="volcano">{n.name}</Tag>)}
        </Space>
        {canEdit && (
          <Space wrap>
            {proposed.length > 0 && (
              <Button onClick={() => modal.confirm({ title: '重新生成会替换所有待确认的选题，确定吗？', onOk: () => generate(true) })} loading={busy === 'gen'}>
                重新生成
              </Button>
            )}
            {data.topics.length === 0 && <Button type="primary" onClick={() => generate(false)} loading={busy === 'gen'}>AI 生成选题清单</Button>}
            {data.topics.length > 0 && <Button onClick={() => { setInitial({ audience: 'C' }); setEditing('new'); }}>追加选题</Button>}
            {proposed.length > 0 && (
              <Button type="primary" disabled={!selected.length} loading={busy === 'confirm'} onClick={confirm}>
                确认并生成稿件（{selected.length}）
              </Button>
            )}
          </Space>
        )}
      </Space>
      {data.confirmed && (
        <Alert
          type="success" showIcon
          message={generating ? '清单已确认，稿件正在生成…' : '清单已确认，稿件已生成'}
          action={<Button size="small" onClick={() => navigate('/drafts')}>去看稿件</Button>}
        />
      )}
      {generating && <AutoRefresh onTick={load} />}
      {data.topics.length === 0 ? (
        <Card><Empty description={canEdit ? '这周还没有选题清单。每周四 9 点会自动生成下周清单，也可以现在手动生成。' : '这周还没有选题清单'} /></Card>
      ) : (
        <Table<Topic>
          rowKey="id"
          size="middle"
          pagination={false}
          dataSource={data.topics}
          columns={columns}
          scroll={{ x: 900 }}
          rowSelection={
            canEdit && proposed.length
              ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), getCheckboxProps: (r) => ({ disabled: r.status !== 'PROPOSED' }) }
              : undefined
          }
        />
      )}
      <Modal title={editing === 'new' ? '追加选题' : '修改选题'} open={editing !== null} onOk={save} onCancel={() => setEditing(null)} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false} initialValues={initial}>
          <TopicFields cats={cats} />
        </Form>
      </Modal>
    </Space>
  );
}

/** 有稿件在生成时每 3 秒刷新一次。 */
function AutoRefresh({ onTick }: { onTick: () => Promise<unknown> }) {
  useEffect(() => {
    const t = setInterval(() => void onTick().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [onTick]);
  return null;
}

function Library() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const { cats } = useCategories();
  const [status, setStatus] = useState<string>('IDLE,SCHEDULED,PUBLISHED');
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const listPath = useMemo(() => `/topics?status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`, [status, q]);

  return (
    <CrudTable<Topic>
      entity="选题"
      listPath={listPath}
      basePath="/topics"
      canEdit={can('CONTENT')}
      initialValues={{ audience: 'C' }}
      toForm={(t) => ({ ...t, suggestedDate: ymd(t.suggestedDate) })}
      toBody={(v) => ({ ...v, suggestedDate: v.suggestedDate || null, seasonTag: v.seasonTag || null, reason: v.reason || null })}
      extra={
        <>
          <Select value={status} onChange={setStatus} style={{ width: 140 }} options={[
            { value: 'IDLE,SCHEDULED,PUBLISHED', label: '在用' },
            { value: 'IDLE', label: '待用' },
            { value: 'SCHEDULED', label: '已排期' },
            { value: 'PUBLISHED', label: '已发布' },
            { value: 'ARCHIVED', label: '归档' },
          ]} />
          <Input.Search placeholder="搜索选题" allowClear onSearch={setQ} style={{ width: 200 }} />
        </>
      }
      rowActions={(t) =>
        can('CONTENT') && t.status === 'IDLE' && (
          <Button type="link" size="small" onClick={async () => {
            try {
              const d = await api<{ id: string }>('/drafts', { method: 'POST', body: { topicId: t.id } });
              message.success('正在生成稿件');
              navigate(`/drafts/${d.id}`);
            } catch (e) { message.error((e as Error).message); }
          }}>生成稿件</Button>
        )
      }
      columns={[
        { title: '选题', dataIndex: 'title' },
        { title: '客群', dataIndex: 'audience', width: 70, render: (a: string) => AUDIENCE_LABEL[a] },
        { title: '类别', dataIndex: 'category', width: 130 },
        { title: '节点', dataIndex: 'seasonTag', width: 100, render: (s: string | null) => s ?? '—' },
        { title: '来源', dataIndex: 'source', width: 90, render: (s: string) => TOPIC_SOURCE[s] },
        { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={TOPIC_STATUS[s]?.color}>{TOPIC_STATUS[s]?.text}</Tag> },
        { title: '稿件', key: 'drafts', width: 60, render: (_, t) => t._count?.drafts ?? 0 },
      ]}
      form={<TopicFields cats={cats} />}
    />
  );
}

function SettingsTab() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('CONTENT');
  const { cats, reload } = useCategories();
  const [form] = Form.useForm<Settings>();
  const [ready, setReady] = useState(false);
  const [newCat, setNewCat] = useState<{ C: string; B: string }>({ C: '', B: '' });

  useEffect(() => {
    api<Settings>('/topics/settings').then((s) => { form.setFieldsValue(s); setReady(true); }, (e) => message.error(e.message));
  }, [form, message]);

  const save = async () => {
    try {
      await api('/topics/settings', { method: 'PUT', body: await form.validateFields() });
      message.success('已保存');
    } catch (e) {
      if (e instanceof ApiError && e.errors?.length) form.setFields(e.errors.map((x) => ({ name: x.field.split('.') as never, errors: [x.message] })));
      else if (e instanceof Error) message.error(e.message);
    }
  };

  const addCat = async (audience: 'C' | 'B') => {
    if (!newCat[audience].trim()) return;
    try {
      await api('/topics/categories', { method: 'POST', body: { audience, name: newCat[audience] } });
      setNewCat({ ...newCat, [audience]: '' });
      void reload();
    } catch (e) { message.error((e as Error).message); }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 760 }}>
      <Card title="每周选题清单" extra={canEdit && <Button type="primary" onClick={save} disabled={!ready}>保存</Button>}>
        <Form form={form} layout="vertical" disabled={!canEdit}>
          <Space size={32} wrap>
            <Form.Item label="小红书每周篇数" name={['weeklyQuota', 'XHS']}><InputNumber min={0} max={30} /></Form.Item>
            <Form.Item noStyle shouldUpdate>
              {({ getFieldValue }) => {
                const n = getFieldValue(['weeklyQuota', 'XHS']) ?? 0;
                const c = Math.round(n * (getFieldValue('cRatio') ?? 0));
                return (
                  <Form.Item label={`C 端占比（C 端 ${c} 篇、B 端 ${n - c} 篇）`} name="cRatio" style={{ width: 280 }}>
                    <Slider min={0} max={1} step={0.1} tooltip={{ formatter: (v) => `${Math.round((v ?? 0) * 100)}%` }} />
                  </Form.Item>
                );
              }}
            </Form.Item>
            <Form.Item label="每周四 9 点自动生成下周清单" name="autoGenerate" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <div style={{ marginTop: 8 }}><Typography.Text strong>季节节点</Typography.Text></div>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 8px' }}>
            生成选题时会参考临近的节点。错峰上市期请按产地实际采收期填写。
          </Typography.Paragraph>
          <Form.List name="seasonNodes">
            {(fields, { add, remove }) => (
              <>
                {fields.map((f) => (
                  <Space key={f.key} align="baseline" wrap>
                    <Form.Item name={[f.name, 'name']} rules={[{ required: true, message: '名称' }]}><Input placeholder="名称" style={{ width: 140 }} /></Form.Item>
                    <Form.Item name={[f.name, 'start']} rules={[{ required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, message: 'YYYY-MM-DD' }]}><Input placeholder="开始 YYYY-MM-DD" style={{ width: 150 }} /></Form.Item>
                    <Form.Item name={[f.name, 'end']} rules={[{ required: true, pattern: /^\d{4}-\d{2}-\d{2}$/, message: 'YYYY-MM-DD' }]}><Input placeholder="结束 YYYY-MM-DD" style={{ width: 150 }} /></Form.Item>
                    {canEdit && <Button type="link" danger onClick={() => remove(f.name)}>删除</Button>}
                  </Space>
                ))}
                {canEdit && <Button onClick={() => add({ name: '', start: '', end: '' })}>添加节点</Button>}
              </>
            )}
          </Form.List>
        </Form>
      </Card>
      <Card title="选题类别">
        {(['C', 'B'] as const).map((a) => (
          <div key={a} style={{ marginBottom: 12 }}>
            <Typography.Text strong style={{ marginRight: 8 }}>{AUDIENCE_LABEL[a]}</Typography.Text>
            {cats.filter((c) => c.audience === a).map((c) => (
              <Tag key={c.id} closable={canEdit} style={{ marginBottom: 6 }} onClose={async (e) => {
                e.preventDefault();
                await api(`/topics/categories/${c.id}`, { method: 'DELETE' }).catch((er) => message.error(er.message));
                void reload();
              }}>{c.name}</Tag>
            ))}
            {canEdit && (
              <Input size="small" style={{ width: 140 }} placeholder="新增类别，回车" value={newCat[a]}
                onChange={(e) => setNewCat({ ...newCat, [a]: e.target.value })} onPressEnter={() => addCat(a)} />
            )}
          </div>
        ))}
      </Card>
    </Space>
  );
}

export function TopicsPage() {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>选题清单</Typography.Title>
        <Typography.Text type="secondary">AI 结合季节节点、作品数据和私信问题出下周选题，确认后批量生成小红书稿件</Typography.Text>
      </div>
      <AiModelNotice />
      <Tabs items={[
        { key: 'week', label: '每周清单', children: <WeeklyList /> },
        { key: 'lib', label: '选题库', children: <Library /> },
        { key: 'settings', label: '配额与类别', children: <SettingsTab /> },
      ]} />
    </Space>
  );
}

/** 没配置真实模型时提醒：当前输出是演示数据。 */
export function AiModelNotice() {
  const [mock, setMock] = useState(false);
  useEffect(() => void api<{ mock: boolean }>('/ai/status').then((s) => setMock(s.mock), () => undefined), []);
  return mock ? <Alert type="info" showIcon message="当前为演示模型：AI 输出是固定的示例内容。配置国内大模型的接口地址和密钥后会换成真实生成。" /> : null;
}
