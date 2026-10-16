import { checkXhsDraft, textLength, XHS_LIMITS, type RiskHit } from '@hsj/shared';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Image,
  Input,
  List,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RiskHighlight } from '../components/RiskHighlight';
import { api, AUDIENCE_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DRAFT_STATUS, Topic, withWeekday } from '../lib/content';
import { AiModelNotice } from './TopicsPage';

interface DraftRow {
  id: string;
  status: string;
  createdAt: string;
  error: string | null;
  topic: Pick<Topic, 'id' | 'title' | 'audience' | 'category' | 'suggestedDate'>;
  versions: { id: string; title: string }[];
  _count: { versions: number };
}

interface Version {
  id: string;
  index: number;
  title: string;
  body: string;
  tags: string[];
  coverPrompt: string | null;
  imageTips: string[];
  chosen: boolean;
  modelName: string | null;
  note: string | null;
  createdAt: string;
  risk: { blocked: boolean; title: RiskHit[]; body: RiskHit[]; tags: RiskHit[] };
  problems: string[];
}

interface DraftDetail {
  id: string;
  status: string;
  error: string | null;
  rejectReason: string | null;
  topic: Topic;
  versions: Version[];
  assets: { id: string; title: string; url: string; kind: string; tags: string[] }[];
}

const statusTag = (s: string) => <Tag color={DRAFT_STATUS[s]?.color}>{DRAFT_STATUS[s]?.text ?? s}</Tag>;

export function DraftsPage() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<string>('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const navigate = useNavigate();

  const load = useCallback(
    () => api<DraftRow[]>(`/drafts${status ? `?status=${status}` : ''}`).then(setRows, (e) => message.error(e.message)),
    [status, message],
  );
  useEffect(() => void load(), [load]);
  const generating = rows.some((r) => r.status === 'GENERATING');
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [generating, load]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>稿件</Typography.Title>
        <Typography.Text type="secondary">选题确认后自动生成；在这里挑版本、改稿，提交审核在下一阶段（M6）上线</Typography.Text>
      </div>
      <AiModelNotice />
      <Select
        value={status}
        onChange={setStatus}
        style={{ width: 160 }}
        options={[{ value: '', label: '全部状态' }, ...Object.entries(DRAFT_STATUS).map(([value, s]) => ({ value, label: s.text }))]}
      />
      <Table<DraftRow>
        rowKey="id"
        dataSource={rows}
        scroll={{ x: 800 }}
        onRow={(r) => ({ onClick: () => navigate(`/drafts/${r.id}`), style: { cursor: 'pointer' } })}
        locale={{ emptyText: <Empty description="还没有稿件，先去选题清单确认选题" /> }}
        columns={[
          { title: '建议日期', key: 'date', width: 110, render: (_, r) => withWeekday(r.topic.suggestedDate) },
          { title: '选题', key: 'topic', render: (_, r) => r.topic.title },
          { title: '当前采用的标题', key: 'title', render: (_, r) => r.versions[0]?.title ?? '—' },
          { title: '客群', key: 'aud', width: 70, render: (_, r) => AUDIENCE_LABEL[r.topic.audience] },
          { title: '版本', key: 'n', width: 60, render: (_, r) => r._count.versions },
          { title: '状态', dataIndex: 'status', width: 100, render: statusTag },
        ]}
      />
    </Space>
  );
}

const REWRITES = [
  { key: 'rewrite', label: '整篇重写' },
  { key: 'tone', label: '改语气…', ask: '想要什么语气？', placeholder: '如：更活泼、更专业、像闺蜜聊天' },
  { key: 'shorter', label: '缩短' },
  { key: 'longer', label: '扩写' },
  { key: 'reject_reason', label: '按驳回原因重写…', ask: '驳回原因', placeholder: '如：开头太平淡，去掉功效表述' },
];

function Counter({ n, max }: { n: number; max: number }) {
  return <Typography.Text type={n > max ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{n}/{max}</Typography.Text>;
}

export function DraftDetailPage() {
  const { id } = useParams();
  const { message } = App.useApp();
  const { can } = useAuth();
  const [d, setD] = useState<DraftDetail | null>(null);
  const [viewId, setViewId] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<(typeof REWRITES)[number] | null>(null);
  const [instruction, setInstruction] = useState('');
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    const r = await api<DraftDetail>(`/drafts/${id}`);
    setD(r);
    return r;
  }, [id]);
  useEffect(() => void load().catch((e) => message.error(e.message)), [load, message]);
  useEffect(() => {
    if (d?.status !== 'GENERATING') return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [d?.status, load]);

  if (!d) return null;
  const v = d.versions.find((x) => x.id === viewId) ?? d.versions.find((x) => x.chosen) ?? d.versions[0];
  const editable = ['DRAFT', 'REJECTED'].includes(d.status);
  const canEdit = can('CONTENT') && editable;
  const canRewrite = can('CONTENT', 'REVIEWER') && editable;

  const act = async (fn: () => Promise<unknown>, ok: string, after?: (r: DraftDetail) => void) => {
    setBusy(true);
    try {
      await fn();
      message.success(ok);
      const r = await load();
      after?.(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const showNewest = (r: DraftDetail) => setViewId(r.versions[0]?.id);

  const rewrite = (mode: string, extra?: string) =>
    act(() => api(`/drafts/${d.id}/rewrite`, { method: 'POST', body: { mode, versionId: v.id, instruction: extra || undefined } }), 'AI 已改写，生成了新版本', showNewest);

  const saveEdit = async () => {
    const values = await form.validateFields();
    await act(() => api(`/drafts/${d.id}/versions/${v.id}`, { method: 'PATCH', body: values }), '已保存为新版本', (r) => { setEditing(false); showNewest(r); });
  };

  const copy = async () => {
    const text = `${v.title}\n\n${v.body}\n\n${v.tags.map((t) => `#${t}`).join(' ')}`;
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制标题、正文和标签');
    } catch {
      message.error('浏览器不允许复制，请手动选择文字');
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Link to="/drafts">← 稿件</Link>
        <Typography.Title level={4} style={{ margin: 0 }}>{d.topic.title}</Typography.Title>
        {statusTag(d.status)}
      </Space>
      <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
        <Descriptions.Item label="客群">{AUDIENCE_LABEL[d.topic.audience]}</Descriptions.Item>
        <Descriptions.Item label="类别">{d.topic.category}</Descriptions.Item>
        <Descriptions.Item label="建议日期">{withWeekday(d.topic.suggestedDate)}</Descriptions.Item>
        <Descriptions.Item label="平台">小红书</Descriptions.Item>
        {d.topic.reason && <Descriptions.Item label="选题理由" span="filled">{d.topic.reason}</Descriptions.Item>}
      </Descriptions>
      {d.status === 'GENERATING' && <Alert type="info" showIcon message="AI 正在生成，页面会自动刷新" />}
      {d.status === 'GENERATE_FAILED' && (
        <Alert type="error" showIcon message="生成失败" description={d.error}
          action={can('CONTENT') && <Button onClick={() => act(() => api(`/drafts/${d.id}/retry`, { method: 'POST' }), '已重新开始生成')}>重试</Button>} />
      )}
      {d.rejectReason && <Alert type="warning" showIcon message={`驳回原因：${d.rejectReason}`} />}

      {v && (
        <Row gutter={16}>
          <Col xs={24} md={7}>
            <Card size="small" title={`版本（${d.versions.length}）`}>
              <List
                dataSource={d.versions}
                renderItem={(x) => (
                  <List.Item
                    onClick={() => { setViewId(x.id); setEditing(false); }}
                    style={{ cursor: 'pointer', background: x.id === v.id ? '#F7F0F4' : undefined, padding: '8px 10px', borderRadius: 6 }}
                  >
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Space size={4} wrap>
                        <Typography.Text strong>版本 {x.index}</Typography.Text>
                        {x.chosen && <Tag color="purple">采用</Tag>}
                        {x.risk.blocked && <Tag color="red">含拦截词</Tag>}
                        {x.problems.length > 0 && <Tag color="orange">规格</Tag>}
                      </Space>
                      <Typography.Text ellipsis style={{ fontSize: 13 }}>{x.title}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {x.note ?? ''}{x.modelName ? ` · ${x.modelName}` : ''}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
          </Col>
          <Col xs={24} md={17}>
            <Card
              size="small"
              title={`版本 ${v.index}${v.chosen ? '（采用）' : ''}`}
              extra={
                <Space wrap>
                  {!editing && canEdit && !v.chosen && (
                    <Button loading={busy} onClick={() => act(() => api(`/drafts/${d.id}/versions/${v.id}/choose`, { method: 'POST' }), '已设为采用')}>设为采用</Button>
                  )}
                  {!editing && canRewrite && (
                    <Dropdown
                      disabled={busy}
                      menu={{
                        items: REWRITES.map((r) => ({ key: r.key, label: r.label })),
                        onClick: ({ key }) => {
                          const r = REWRITES.find((x) => x.key === key)!;
                          if (r.ask) { setInstruction(''); setAsk(r); } else void rewrite(r.key);
                        },
                      }}
                    >
                      <Button loading={busy}>AI 改写</Button>
                    </Dropdown>
                  )}
                  {!editing && canEdit && <Button onClick={() => setEditing(true)}>修改</Button>}
                  {!editing && <Button onClick={copy}>复制文案</Button>}
                  {editing && <Button onClick={() => setEditing(false)}>取消</Button>}
                  {editing && <Button type="primary" loading={busy} onClick={saveEdit}>保存为新版本</Button>}
                </Space>
              }
            >
              {editing ? (
                <Form form={form} layout="vertical" key={v.id} initialValues={{ ...v, coverPrompt: v.coverPrompt ?? '' }}>
                  <Form.Item noStyle shouldUpdate>
                    {({ getFieldsValue }) => {
                      const f = getFieldsValue();
                      const problems = checkXhsDraft({ title: f.title ?? '', body: f.body ?? '', tags: f.tags ?? [] });
                      return problems.length ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={problems.join('；')} /> : null;
                    }}
                  </Form.Item>
                  <Form.Item label={<Space>标题<Form.Item noStyle shouldUpdate>{({ getFieldValue }) => <Counter n={textLength(getFieldValue('title') ?? '')} max={XHS_LIMITS.title} />}</Form.Item></Space>} name="title" rules={[{ required: true, message: '请填写标题' }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item label={<Space>正文<Form.Item noStyle shouldUpdate>{({ getFieldValue }) => <Counter n={textLength(getFieldValue('body') ?? '')} max={XHS_LIMITS.body} />}</Form.Item></Space>} name="body" rules={[{ required: true, message: '请填写正文' }]}>
                    <Input.TextArea autoSize={{ minRows: 8, maxRows: 24 }} />
                  </Form.Item>
                  <Form.Item label={`话题标签（${XHS_LIMITS.tagsMin}–${XHS_LIMITS.tagsMax} 个）`} name="tags"><Select mode="tags" /></Form.Item>
                  <Form.Item label="首图提示词" name="coverPrompt"><Input.TextArea rows={2} /></Form.Item>
                  <Form.Item label="配图建议" name="imageTips"><Select mode="tags" /></Form.Item>
                </Form>
              ) : (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {v.risk.blocked && <Alert type="error" showIcon message="含拦截级风险词，需要修改后才能提交审核。把鼠标放在标红的词上可以看替换建议。" />}
                  {v.problems.length > 0 && <Alert type="warning" showIcon message={v.problems.join('；')} />}
                  <div>
                    <Space><Typography.Text type="secondary">标题</Typography.Text><Counter n={textLength(v.title)} max={XHS_LIMITS.title} /></Space>
                    <Typography.Title level={5} style={{ margin: '4px 0 0' }}><RiskHighlight text={v.title} hits={v.risk.title} /></Typography.Title>
                  </div>
                  <div>
                    <Space><Typography.Text type="secondary">正文</Typography.Text><Counter n={textLength(v.body)} max={XHS_LIMITS.body} /></Space>
                    <RiskHighlight text={v.body} hits={v.risk.body} />
                  </div>
                  <div>
                    <Typography.Text type="secondary">话题标签</Typography.Text>
                    <div>{v.tags.map((t) => <Tag key={t} color={v.risk.tags.some((h) => t.includes(h.matched)) ? 'red' : undefined}>#{t}</Tag>)}</div>
                  </div>
                  {v.coverPrompt && (
                    <div>
                      <Typography.Text type="secondary">首图提示词</Typography.Text>
                      <Typography.Paragraph copyable style={{ margin: 0 }}>{v.coverPrompt}</Typography.Paragraph>
                    </div>
                  )}
                  {v.imageTips.length > 0 && (
                    <div>
                      <Typography.Text type="secondary">配图建议</Typography.Text>
                      <ol style={{ margin: 0, paddingLeft: 20 }}>{v.imageTips.map((t) => <li key={t}>{t}</li>)}</ol>
                    </div>
                  )}
                </Space>
              )}
            </Card>
            <Card size="small" title="推荐素材" style={{ marginTop: 16 }}>
              {d.assets.length ? (
                <Space wrap>
                  {d.assets.map((a) => (
                    <div key={a.id} style={{ width: 120 }}>
                      {a.kind === 'image' ? <Image src={a.url} width={120} height={120} style={{ objectFit: 'cover', borderRadius: 6 }} /> : <Tag>视频</Tag>}
                      <Typography.Text ellipsis style={{ display: 'block', fontSize: 12 }}>{a.title}</Typography.Text>
                    </div>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">素材库里没有标签匹配的素材。给素材打上类别或话题标签后会出现在这里。</Typography.Text>
              )}
            </Card>
          </Col>
        </Row>
      )}

      <Modal
        title={ask?.label.replace('…', '')}
        open={!!ask}
        okText="开始改写"
        okButtonProps={{ disabled: !instruction.trim() }}
        onCancel={() => setAsk(null)}
        onOk={() => { const r = ask!; setAsk(null); void rewrite(r.key, instruction.trim()); }}
      >
        <Typography.Paragraph type="secondary">{ask?.ask}</Typography.Paragraph>
        <Input.TextArea rows={3} value={instruction} placeholder={ask?.placeholder} onChange={(e) => setInstruction(e.target.value)} />
      </Modal>
    </Space>
  );
}
