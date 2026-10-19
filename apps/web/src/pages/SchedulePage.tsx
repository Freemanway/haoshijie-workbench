import { draftText } from '@hsj/shared';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, AUDIENCE_LABEL, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DRAFT_STATUS } from '../lib/content';

export interface ScheduleItem {
  id: string;
  publishAt: string;
  publishedAt: string | null;
  remindedAt: string | null;
  postUrl: string | null;
  failedReason: string | null;
  reads: number | null;
  likes: number | null;
  saves: number | null;
  comments: number | null;
  account: { id: string; name: string; dailyPostCap: number };
  draft: {
    id: string;
    status: string;
    topic: { id: string; title: string; audience: string; category: string };
    version: { id: string; title: string; body: string; tags: string[] } | null;
  };
  metrics: { checkpoint: string; reads: number; likes: number; saves: number; comments: number }[];
  due?: string[];
}
interface Account { id: string; name: string; platform: string; dailyPostCap: number }
interface DraftRow { id: string; status: string; topic: { title: string; audience: string }; versions: { title: string }[] }

const COLORS = ['#A0457A', '#2F7D6D', '#C77B30', '#3D6FB6', '#7A5BB0', '#B5484B'];
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const CHECKPOINT: Record<string, string> = { '24h': '24 小时', '7d': '7 天' };

/** 周一开始的日期。 */
const mondayOf = (d: Dayjs) => d.startOf('day').subtract((d.day() + 6) % 7, 'day');

function itemState(i: ScheduleItem) {
  if (i.publishedAt) return { text: '已发布', color: 'green' };
  if (i.failedReason) return { text: '发布失败', color: 'red' };
  if (dayjs(i.publishAt).isBefore(dayjs())) return { text: '待发布', color: 'gold' };
  return { text: '已排期', color: 'purple' };
}

/** 一条排期上能做的事：复制文案、下载素材包、回填链接、标记失败、回填数据、删除。 */
function useItemActions(reload: () => void) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      reload();
    } catch (e) {
      message.error((e as Error).message);
      throw e;
    }
  };

  return {
    copy: async (i: ScheduleItem) => {
      if (!i.draft.version) return message.error('稿件还没有采用的版本');
      try {
        await navigator.clipboard.writeText(draftText(i.draft.version));
        message.success('已复制标题、正文和话题');
      } catch {
        message.error('浏览器不允许复制，请到稿件详情里手动复制');
      }
    },
    pack: (i: ScheduleItem) => download(`/schedule/${i.id}/package`, '素材包.zip').catch((e) => message.error(e.message)),
    publish: (i: ScheduleItem) => {
      modal.confirm({
        title: `回填作品链接 · ${i.account.name}`,
        icon: null,
        content: (
          <Form form={form} preserve={false} layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item name="postUrl" label="小红书作品链接" rules={[{ required: true, type: 'url', message: '请粘贴完整链接（https://…）' }]}>
              <Input placeholder="https://www.xiaohongshu.com/explore/…" />
            </Form.Item>
          </Form>
        ),
        okText: '标记已发布',
        onOk: async () => {
          const v = await form.validateFields();
          await run(() => api(`/schedule/${i.id}/publish`, { method: 'POST', body: v }), '已标记为已发布');
        },
      });
    },
    fail: (i: ScheduleItem) => {
      modal.confirm({
        title: '标记发布失败',
        icon: null,
        content: (
          <Form form={form} preserve={false} layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item name="reason" label="失败原因" rules={[{ required: true, message: '请填写失败原因' }]}>
              <Input.TextArea rows={2} placeholder="如：平台审核不通过、账号被限流" />
            </Form.Item>
            <Typography.Text type="secondary">处理好后在日历里把它拖到新的日期即可重新排期。</Typography.Text>
          </Form>
        ),
        okText: '标记失败',
        okButtonProps: { danger: true },
        onOk: async () => {
          const v = await form.validateFields();
          await run(() => api(`/schedule/${i.id}/fail`, { method: 'POST', body: v }), '已标记为发布失败');
        },
      });
    },
    metrics: (i: ScheduleItem, checkpoint = i.due?.[0] ?? '24h') => {
      const prev = i.metrics.find((m) => m.checkpoint === checkpoint);
      modal.confirm({
        title: `回填数据 · ${i.draft.topic.title}`,
        icon: null,
        width: 460,
        content: (
          <Form form={form} preserve={false} layout="vertical" style={{ marginTop: 12 }} initialValues={{ checkpoint, ...(prev ?? {}) }}>
            <Form.Item name="checkpoint" label="时间点">
              <Segmented options={[{ value: '24h', label: '发布 24 小时' }, { value: '7d', label: '发布 7 天' }]} />
            </Form.Item>
            <Space wrap>
              {[['reads', '阅读'], ['likes', '点赞'], ['saves', '收藏'], ['comments', '评论']].map(([k, l]) => (
                <Form.Item key={k} name={k} label={l} rules={[{ required: true, message: '必填' }]}>
                  <InputNumber min={0} precision={0} style={{ width: 90 }} />
                </Form.Item>
              ))}
            </Space>
          </Form>
        ),
        okText: '保存',
        onOk: async () => {
          const v = await form.validateFields();
          await run(() => api(`/schedule/${i.id}/metrics`, { method: 'POST', body: v }), '数据已保存');
        },
      });
    },
    remove: (i: ScheduleItem) => run(() => api(`/schedule/${i.id}`, { method: 'DELETE' }), '已取消排期'),
    move: (i: ScheduleItem, publishAt: Dayjs) => run(() => api(`/schedule/${i.id}`, { method: 'PATCH', body: { publishAt: publishAt.toISOString() } }), `已改到 ${publishAt.format('M月D日 HH:mm')}`),
  };
}

export function SchedulePage() {
  const { message } = App.useApp();
  const { can } = useAuth();
  const canEdit = can('CONTENT');
  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => dayjs());
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [today, setToday] = useState<ScheduleItem[]>([]);
  const [due, setDue] = useState<ScheduleItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState<ScheduleItem | null>(null);
  const [creating, setCreating] = useState<Dayjs | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const days = useMemo(() => {
    const start = view === 'week' ? mondayOf(anchor) : mondayOf(anchor.startOf('month'));
    const n = view === 'week' ? 7 : Math.ceil((anchor.endOf('month').diff(start, 'day') + 1) / 7) * 7;
    return Array.from({ length: n }, (_, k) => start.add(k, 'day'));
  }, [view, anchor]);

  const load = useCallback(() => {
    const from = days[0];
    const to = days.at(-1)!.add(1, 'day');
    Promise.all([
      api<ScheduleItem[]>(`/schedule?from=${from.toISOString()}&to=${to.toISOString()}`).then(setItems),
      api<ScheduleItem[]>('/schedule/today').then(setToday),
      api<ScheduleItem[]>('/schedule/metrics-due').then(setDue),
    ]).catch((e) => message.error(e.message));
  }, [days, message]);
  useEffect(() => load(), [load]);
  useEffect(() => void api<Account[]>('/accounts').then(setAccounts), []);

  const act = useItemActions(() => {
    setOpen(null);
    load();
  });
  const color = (accountId: string) => COLORS[Math.max(0, accounts.findIndex((a) => a.id === accountId)) % COLORS.length];

  const byDay = useMemo(() => {
    const m = new Map<string, ScheduleItem[]>();
    for (const i of items) {
      const k = dayjs(i.publishAt).format('YYYY-MM-DD');
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return m;
  }, [items]);

  const onDrop = (day: Dayjs, id: string) => {
    setOver(null);
    const i = items.find((x) => x.id === id);
    if (!i) return;
    const t = dayjs(i.publishAt);
    const next = day.hour(t.hour()).minute(t.minute());
    if (next.isSame(t, 'day')) return;
    void act.move(i, next).catch(() => undefined);
  };

  const title = view === 'week' ? `${days[0].format('M月D日')} – ${days[6].format('M月D日')}` : anchor.format('YYYY年M月');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>排期发布</Typography.Title>
        <Typography.Text type="secondary">
          一期为半自动发布：到点企业微信提醒，运营复制文案、下载素材包，在小红书 App 里发布后回填链接；发布满 24 小时和 7 天回填数据。
        </Typography.Text>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Card size="small" title={<Space>今日待发<Badge count={today.length} color="#A0457A" /></Space>}>
          <List
            dataSource={today}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天没有待发的内容" /> }}
            renderItem={(i) => (
              <List.Item
                actions={canEdit ? [
                  <Button key="c" size="small" onClick={() => act.copy(i)}>复制文案</Button>,
                  <Button key="p" size="small" onClick={() => act.pack(i)}>素材包</Button>,
                  <Button key="u" size="small" type="primary" onClick={() => act.publish(i)}>回填链接</Button>,
                  <Button key="f" size="small" type="text" danger onClick={() => act.fail(i)}>失败</Button>,
                ] : []}
              >
                <List.Item.Meta
                  title={<Space size={6} wrap><span style={{ color: color(i.account.id) }}>●</span>{dayjs(i.publishAt).format('HH:mm')} {i.account.name}{dayjs(i.publishAt).isBefore(dayjs().startOf('day')) && <Tag color="red">已过期</Tag>}</Space>}
                  description={<Link to={`/drafts/${i.draft.id}`}>{i.draft.version?.title ?? i.draft.topic.title}</Link>}
                />
              </List.Item>
            )}
          />
        </Card>
        <Card size="small" title={<Space>待回填数据<Badge count={due.length} color="#C77B30" /></Space>}>
          <List
            dataSource={due}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有需要回填的数据" /> }}
            renderItem={(i) => (
              <List.Item actions={canEdit ? [<Button key="m" size="small" onClick={() => act.metrics(i)}>回填</Button>] : []}>
                <List.Item.Meta
                  title={<Space size={6} wrap><span style={{ color: color(i.account.id) }}>●</span>{i.account.name}{i.due!.map((c) => <Tag key={c}>{CHECKPOINT[c]}</Tag>)}</Space>}
                  description={<>发布于 {dayjs(i.publishedAt).format('M月D日 HH:mm')} · <a href={i.postUrl!} target="_blank" rel="noreferrer">{i.draft.version?.title ?? i.draft.topic.title}</a></>}
                />
              </List.Item>
            )}
          />
        </Card>
      </div>

      <Card
        size="small"
        title={
          <Space wrap>
            <Button size="small" onClick={() => setAnchor(anchor.subtract(1, view))}>‹</Button>
            <Typography.Text strong>{title}</Typography.Text>
            <Button size="small" onClick={() => setAnchor(anchor.add(1, view))}>›</Button>
            <Button size="small" onClick={() => setAnchor(dayjs())}>今天</Button>
          </Space>
        }
        extra={
          <Space wrap>
            <Segmented size="small" value={view} onChange={(v) => setView(v as 'week' | 'month')} options={[{ value: 'week', label: '周' }, { value: 'month', label: '月' }]} />
            {canEdit && <Button size="small" type="primary" onClick={() => setCreating(dayjs().add(1, 'day').hour(12).minute(0).second(0))}>新建排期</Button>}
          </Space>
        }
      >
        <Space wrap size={12} style={{ marginBottom: 8 }}>
          {accounts.map((a) => <Space key={a.id} size={4}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color(a.id) }} /><Typography.Text style={{ fontSize: 12 }}>{a.name}（每日最多 {a.dailyPostCap} 篇）</Typography.Text></Space>)}
          {canEdit && <Typography.Text type="secondary" style={{ fontSize: 12 }}>拖动卡片可以改期，双击空白处新建</Typography.Text>}
        </Space>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(110px, 1fr))', minWidth: 770, border: '1px solid #f0f0f0', borderRadius: 6 }}>
            {WEEK.map((w) => <div key={w} style={{ padding: '4px 8px', fontSize: 12, color: '#8c8c8c', background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>周{w}</div>)}
            {days.map((day) => {
              const k = day.format('YYYY-MM-DD');
              const list = byDay.get(k) ?? [];
              const isToday = day.isSame(dayjs(), 'day');
              const dim = view === 'month' && !day.isSame(anchor, 'month');
              return (
                <div
                  key={k}
                  data-day={k}
                  onDragOver={(e) => { if (canEdit) { e.preventDefault(); setOver(k); } }}
                  onDragLeave={() => setOver((o) => (o === k ? null : o))}
                  onDrop={(e) => onDrop(day, e.dataTransfer.getData('text/plain'))}
                  onDoubleClick={() => canEdit && !day.isBefore(dayjs(), 'day') && setCreating(day.hour(12).minute(0).second(0))}
                  style={{
                    minHeight: view === 'week' ? 260 : 110,
                    padding: 6,
                    borderRight: '1px solid #f0f0f0',
                    borderBottom: '1px solid #f0f0f0',
                    background: over === k ? '#F7F0F4' : dim ? '#fcfcfc' : undefined,
                  }}
                >
                  <div style={{ fontSize: 12, marginBottom: 4, color: dim ? '#bfbfbf' : isToday ? '#A0457A' : '#595959', fontWeight: isToday ? 600 : 400 }}>
                    {day.format(day.date() === 1 ? 'M月D日' : 'D')}{isToday && ' 今天'}
                  </div>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    {list.map((i) => {
                      const s = itemState(i);
                      const draggable = canEdit && !i.publishedAt;
                      return (
                        <div
                          key={i.id}
                          draggable={draggable}
                          onDragStart={(e) => e.dataTransfer.setData('text/plain', i.id)}
                          onClick={() => setOpen(i)}
                          title={`${i.account.name} · ${i.draft.topic.title}`}
                          style={{
                            cursor: draggable ? 'grab' : 'pointer',
                            borderLeft: `3px solid ${color(i.account.id)}`,
                            background: `${color(i.account.id)}14`,
                            borderRadius: 4,
                            padding: '3px 6px',
                            fontSize: 12,
                            lineHeight: 1.4,
                            opacity: i.publishedAt ? 0.7 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dayjs(i.publishAt).format('HH:mm')} {i.account.name}</span>
                            {s.text !== '已排期' && <span style={{ flexShrink: 0, color: s.color === 'gold' ? '#d48806' : s.color }}>{s.text}</span>}
                          </div>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.draft.version?.title ?? i.draft.topic.title}</div>
                        </div>
                      );
                    })}
                  </Space>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <ItemModal item={open} canEdit={canEdit} act={act} onClose={() => setOpen(null)} />
      <CreateModal at={creating} accounts={accounts} onClose={() => setCreating(null)} onDone={() => { setCreating(null); load(); }} />
    </Space>
  );
}

function ItemModal({ item: i, canEdit, act, onClose }: { item: ScheduleItem | null; canEdit: boolean; act: ReturnType<typeof useItemActions>; onClose: () => void }) {
  const [when, setWhen] = useState<Dayjs | null>(null);
  useEffect(() => setWhen(i ? dayjs(i.publishAt) : null), [i]);
  if (!i) return null;
  const s = itemState(i);
  const live = !i.publishedAt;
  return (
    <Modal open title={i.draft.topic.title} onCancel={onClose} footer={null} width={520}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <Tag color={s.color}>{s.text}</Tag>
          <Typography.Text>{i.account.name}</Typography.Text>
          <Typography.Text type="secondary">{AUDIENCE_LABEL[i.draft.topic.audience]} · {i.draft.topic.category}</Typography.Text>
          <Tag color={DRAFT_STATUS[i.draft.status]?.color}>稿件{DRAFT_STATUS[i.draft.status]?.text}</Tag>
        </Space>
        {i.failedReason && <Alert type="error" showIcon message={`失败原因：${i.failedReason}`} description="改到新的时间就会重新进入待发布。" />}
        <Typography.Text strong>{i.draft.version?.title}</Typography.Text>
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{i.draft.version?.body}</Typography.Paragraph>
        <Link to={`/drafts/${i.draft.id}`}>查看稿件</Link>
        {i.publishedAt ? (
          <Space direction="vertical" size={4}>
            <Typography.Text>发布于 {dayjs(i.publishedAt).format('YYYY-MM-DD HH:mm')} · <a href={i.postUrl!} target="_blank" rel="noreferrer">打开作品</a></Typography.Text>
            {i.metrics.map((m) => (
              <Typography.Text key={m.checkpoint} type="secondary">
                {CHECKPOINT[m.checkpoint]}：阅读 {m.reads} · 点赞 {m.likes} · 收藏 {m.saves} · 评论 {m.comments}
              </Typography.Text>
            ))}
            {canEdit && <Space><Button size="small" onClick={() => act.metrics(i, '24h')}>回填 24 小时数据</Button><Button size="small" onClick={() => act.metrics(i, '7d')}>回填 7 天数据</Button></Space>}
          </Space>
        ) : (
          <Space wrap>
            <Typography.Text type="secondary">发布时间</Typography.Text>
            <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" value={when} onChange={setWhen} disabled={!canEdit} allowClear={false} />
            {canEdit && when && !when.isSame(dayjs(i.publishAt), 'minute') && <Button type="primary" onClick={() => act.move(i, when)}>改期</Button>}
          </Space>
        )}
        {canEdit && live && (
          <Space wrap>
            <Button onClick={() => act.copy(i)}>复制文案</Button>
            <Button onClick={() => act.pack(i)}>下载素材包</Button>
            {!i.failedReason && <Button type="primary" onClick={() => act.publish(i)}>回填链接</Button>}
            {!i.failedReason && <Button danger onClick={() => act.fail(i)}>标记失败</Button>}
            <Popconfirm title="取消这条排期？" onConfirm={() => act.remove(i)}><Button type="text" danger>取消排期</Button></Popconfirm>
          </Space>
        )}
      </Space>
    </Modal>
  );
}

/** 新建排期：选一篇已通过的稿件、一个或多个账号、发布时间。稿件详情页也用它。 */
export function CreateModal({ at, accounts, draftId, onClose, onDone }: { at: Dayjs | null; accounts: Account[]; draftId?: string; onClose: () => void; onDone: () => void }) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (at && !draftId) void api<DraftRow[]>('/drafts?status=APPROVED,SCHEDULED,PUBLISH_FAILED').then(setDrafts);
  }, [at, draftId]);
  if (!at) return null;

  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const r = await api<{ warning: string | null }>('/schedule', { method: 'POST', body: { draftId: draftId ?? v.draftId, accountIds: v.accountIds, publishAt: v.publishAt.toISOString() } });
      message.success('已排期');
      if (r.warning) modal.warning({ title: '注意做差异化', content: r.warning });
      onDone();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="新建排期" okText="排期" confirmLoading={busy} onOk={submit} onCancel={onClose} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ publishAt: at, accountIds: accounts.length === 1 ? [accounts[0].id] : [] }}>
        {!draftId && (
          <Form.Item name="draftId" label="稿件" rules={[{ required: true, message: '请选择稿件' }]} extra="只能选审核通过的稿件">
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择稿件"
              notFoundContent="没有审核通过的稿件"
              options={drafts.map((d) => ({ value: d.id, label: `${d.versions[0]?.title ?? d.topic.title}（${AUDIENCE_LABEL[d.topic.audience]} · ${DRAFT_STATUS[d.status]?.text}）` }))}
            />
          </Form.Item>
        )}
        <Form.Item name="accountIds" label="发布账号" rules={[{ required: true, message: '至少选择一个账号' }]} extra="同一篇发到多个账号时，记得每个账号改写标题和开头、换封面">
          <Select mode="multiple" placeholder="选择账号" notFoundContent="先到“平台账号”里添加账号" options={accounts.filter((a) => a.platform === 'XHS').map((a) => ({ value: a.id, label: a.name }))} />
        </Form.Item>
        <Form.Item name="publishAt" label="发布时间" rules={[{ required: true, message: '请选择发布时间' }]}>
          <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" disabledDate={(d) => d.isBefore(dayjs(), 'day')} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
