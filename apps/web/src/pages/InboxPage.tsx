import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Radio,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, AUDIENCE_LABEL, PLATFORM_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Account { id: string; name: string; platform: string; audience: string; inboxMode: string }
interface Message {
  id: string;
  sender: 'customer' | 'ai' | 'agent' | 'system';
  text: string;
  blockedText: string | null;
  delivery: string | null;
  meta: { audience?: string; intent?: string; matched?: boolean; handoff?: string; aiReply?: string | null; offHours?: boolean; riskWords?: string[] } | null;
  authorName?: string;
  createdAt: string;
}
interface Conversation {
  id: string;
  nickname: string | null;
  kind: 'dm' | 'comment';
  sourcePostUrl: string | null;
  status: string;
  audience: 'C' | 'B' | null;
  intent: string | null;
  handoffReason: string | null;
  summary: string | null;
  waitingSince: string | null;
  escalatedAt: string | null;
  lastMessageAt: string;
  account: Account;
  agent: { id: string; name: string } | null;
  lead?: { id: string; status: string } | null;
  last?: Message | null;
  messages?: Message[];
}
interface Settings {
  autoReply: boolean;
  workHours: { days: number[]; start: string; end: string };
  slaMinutes: number;
  handoffText: string;
  offHoursText: string;
  diversion: { C: string; B: string };
}

export const CONV_STATUS: Record<string, { text: string; color: string }> = {
  AI_HANDLING: { text: 'AI 接待中', color: 'blue' },
  WAITING_AGENT: { text: '待人工', color: 'red' },
  AGENT_HANDLING: { text: '人工接待中', color: 'purple' },
  DIVERTED: { text: '已引流', color: 'green' },
  CLOSED: { text: '已关闭', color: 'default' },
};
const INTENT: Record<string, string> = { high: '高意向', medium: '中意向', low: '低意向' };
const AGENT_ROLES = ['CS', 'BIZ'];

function since(iso: string) {
  const m = dayjs().diff(dayjs(iso), 'minute');
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} 小时前`;
  return dayjs(iso).format('M月D日');
}

function usePolling(fn: () => void, ms = 5000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** 会话列表的一行：昵称、来源账号、最后一条消息、状态。电脑端和手机端共用。 */
function ConvItem({ c, active, onClick }: { c: Conversation; active?: boolean; onClick: () => void }) {
  const s = CONV_STATUS[c.status];
  const waiting = c.status === 'WAITING_AGENT' && c.waitingSince;
  return (
    <div
      onClick={onClick}
      style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 8, background: active ? '#F7F0F4' : undefined, borderBottom: '1px solid #f5f5f5' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <Space size={6} style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ maxWidth: 120 }}>{c.nickname ?? '客户'}</Typography.Text>
          {c.kind === 'comment' && <Tag style={{ marginInlineEnd: 0 }}>评论</Tag>}
          {c.audience && <Tag color={c.audience === 'B' ? 'gold' : 'cyan'} style={{ marginInlineEnd: 0 }}>{AUDIENCE_LABEL[c.audience]}</Tag>}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{since(c.lastMessageAt)}</Typography.Text>
      </div>
      <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 13 }}>
        {c.last ? `${c.last.sender === 'customer' ? '' : c.last.sender === 'system' ? '[系统] ' : '[回复] '}${c.last.text}` : '—'}
      </Typography.Text>
      <Space size={6} style={{ marginTop: 2 }}>
        <Tag color={s?.color} style={{ marginInlineEnd: 0 }}>{s?.text ?? c.status}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{c.account.name}</Typography.Text>
        {waiting && <Typography.Text type={c.escalatedAt ? 'danger' : 'warning'} style={{ fontSize: 12 }}>等待 {dayjs().diff(dayjs(c.waitingSince), 'minute')} 分钟</Typography.Text>}
      </Space>
    </div>
  );
}

function Bubble({ m, canSend, onSent }: { m: Message; canSend: boolean; onSent: () => void }) {
  const { message } = App.useApp();
  if (m.sender === 'system') {
    return (
      <div style={{ textAlign: 'center', margin: '8px 0' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{dayjs(m.createdAt).format('HH:mm')} {m.text}</Typography.Text>
      </div>
    );
  }
  const mine = m.sender !== 'customer';
  const copyAndMark = async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      message.success('已复制，粘贴到小红书发送');
    } catch {
      message.warning('浏览器不允许复制，请手动选择文字');
    }
  };
  const markSent = async () => {
    try {
      await api(`/inbox/messages/${m.id}/sent`, { method: 'PATCH' });
      onSent();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <div style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '8px 0' }}>
      <div style={{ maxWidth: '78%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', textAlign: mine ? 'right' : 'left' }}>
          {m.sender === 'ai' ? 'AI' : m.sender === 'agent' ? m.authorName ?? '客服' : '客户'} · {dayjs(m.createdAt).format('M/D HH:mm')}
          {m.meta?.intent && m.sender === 'ai' && ` · ${INTENT[m.meta.intent] ?? ''}`}
        </Typography.Text>
        <div
          style={{
            whiteSpace: 'pre-wrap',
            padding: '8px 12px',
            borderRadius: 10,
            background: mine ? (m.sender === 'ai' ? '#EEF4FF' : '#F3E8EE') : '#f5f5f5',
            border: m.delivery === 'to_send' || m.delivery === 'failed' ? '1px dashed #d48806' : '1px solid transparent',
          }}
        >
          {m.text}
        </div>
        {m.blockedText && (
          <Typography.Text type="danger" style={{ fontSize: 12, display: 'block' }}>
            风控拦下的原回复：{m.blockedText}
          </Typography.Text>
        )}
        {m.meta?.aiReply && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>AI 原本想回：{m.meta.aiReply}</Typography.Text>}
        {(m.delivery === 'to_send' || m.delivery === 'failed') && (
          <Space size={4} style={{ marginTop: 4, float: 'right' }}>
            <Typography.Text type="warning" style={{ fontSize: 12 }}>{m.delivery === 'failed' ? '自动发送失败，' : ''}需要到小红书里发送</Typography.Text>
            {canSend && <Button size="small" onClick={copyAndMark}>复制</Button>}
            {canSend && <Button size="small" type="primary" ghost onClick={markSent}>已发送</Button>}
          </Space>
        )}
      </div>
    </div>
  );
}

/** 一个会话：客户摘要、消息、建议回复、回复框和接管操作。电脑端右栏和手机端整页共用。 */
export function ConversationView({ id, compact, onChanged }: { id: string; compact?: boolean; onChanged?: () => void }) {
  const { message, modal } = App.useApp();
  const { me, can } = useAuth();
  const canAct = can(...AGENT_ROLES);
  const [c, setC] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggest, setSuggest] = useState<{ summary: string; suggestedReply: string | null; blockedWords: string[] } | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const count = useRef(0);

  const load = useCallback(() => api<Conversation>(`/inbox/conversations/${id}`).then(setC, (e) => message.error(e.message)), [id, message]);
  useEffect(() => {
    setC(null);
    setSuggest(null);
    setText('');
    setRiskError(null);
    count.current = 0;
    void load();
  }, [load]);
  usePolling(() => void load());
  useEffect(() => {
    const n = c?.messages?.length ?? 0;
    if (n !== count.current) bottom.current?.scrollIntoView({ block: 'end' });
    count.current = n;
  }, [c?.messages?.length]);

  if (!c) return <Card loading />;

  const act = async (fn: () => Promise<Conversation | unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'messages' in r) setC(r as Conversation);
      else await load();
      if (ok) message.success(ok);
      onChanged?.();
      return true;
    } catch (e) {
      message.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    setRiskError(null);
    setBusy(true);
    try {
      const r = await api<Conversation>(`/inbox/conversations/${c.id}/messages`, { method: 'POST', body: { text } });
      setC(r);
      setText('');
      setSuggest(null);
      onChanged?.();
      if (c.account.inboxMode !== 'api') message.info('已记录，请复制到小红书发送');
    } catch (e) {
      setRiskError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copyWecomLink = async () => {
    try {
      const r = await api<{ url: string; channel: { name: string } }>(`/wecom/conversation-link/${c.id}`);
      try {
        await navigator.clipboard.writeText(r.url);
        message.success(`已复制「${r.channel.name}」的专属加微链接`);
      } catch {
        modal.info({ title: '专属加微链接', content: <Typography.Paragraph copyable>{r.url}</Typography.Paragraph> });
      }
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const loadSuggest = () =>
    act(async () => {
      const r = await api<{ summary: string; suggestedReply: string | null; blockedWords: string[] }>(`/inbox/conversations/${c.id}/summary`, { method: 'POST' });
      setSuggest(r);
    });

  const others = c.status === 'AGENT_HANDLING' && c.agent && c.agent.id !== me?.id;
  const closed = c.status === 'CLOSED';

  return (
    <Card
      size="small"
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12, padding: compact ? 12 : undefined } }}
      title={
        <Space wrap size={6}>
          <span>{c.nickname ?? '客户'}</span>
          <Tag color={CONV_STATUS[c.status]?.color}>{CONV_STATUS[c.status]?.text}</Tag>
          {c.audience && <Tag>{AUDIENCE_LABEL[c.audience]}</Tag>}
          {c.intent && <Tag>{INTENT[c.intent]}</Tag>}
        </Space>
      }
      extra={!compact && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{PLATFORM_LABEL[c.account.platform]} · {c.account.name}{c.kind === 'comment' ? ' · 评论区' : ''}</Typography.Text>}
    >
      {c.lead && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已建线索：<Link to={`/leads?id=${c.lead.id}`}>查看线索</Link>
        </Typography.Text>
      )}
      {c.sourcePostUrl && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          来源作品：<a href={c.sourcePostUrl} target="_blank" rel="noreferrer">{c.sourcePostUrl}</a>
        </Typography.Text>
      )}
      {c.handoffReason && ['WAITING_AGENT', 'AGENT_HANDLING'].includes(c.status) && (
        <Alert type={c.status === 'WAITING_AGENT' ? 'error' : 'info'} showIcon message={`转人工原因：${c.handoffReason}`} description={c.agent ? `${c.agent.name} 接待中` : undefined} />
      )}
      {(c.summary || suggest) && (
        <Alert
          type="info"
          message="客户摘要"
          description={
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <span>{suggest?.summary ?? c.summary}</span>
              {suggest?.suggestedReply && (
                <div>
                  <Typography.Text type="secondary">建议回复：</Typography.Text>
                  {suggest.suggestedReply}
                  {canAct && !closed && <Button size="small" type="link" onClick={() => setText(suggest.suggestedReply!)}>用这句</Button>}
                </div>
              )}
              {suggest && !suggest.suggestedReply && <Typography.Text type="warning">建议回复命中风控（{suggest.blockedWords.join('、')}），请自己写。</Typography.Text>}
            </Space>
          }
        />
      )}

      <div style={{ maxHeight: compact ? undefined : 'calc(100vh - 470px)', minHeight: 200, overflowY: 'auto', padding: '0 4px' }}>
        {c.messages?.map((m) => <Bubble key={m.id} m={m} canSend={canAct} onSent={() => void load()} />)}
        <div ref={bottom} />
      </div>

      {canAct && !closed && (
        <>
          {others && <Alert type="warning" showIcon message={`${c.agent!.name} 正在接待这位客户`} />}
          {riskError && <Alert type="error" showIcon message={riskError} closable onClose={() => setRiskError(null)} />}
          <Input.TextArea
            rows={compact ? 3 : 3}
            value={text}
            maxLength={1000}
            disabled={!!others}
            placeholder={c.status === 'AI_HANDLING' ? '发送后会自动接管，AI 停止回复' : '回复客户（发出前会过风控）'}
            onChange={(e) => setText(e.target.value)}
          />
          <Space wrap>
            <Button type="primary" loading={busy} disabled={!text.trim() || !!others} onClick={send}>发送</Button>
            <Button loading={busy} onClick={loadSuggest}>AI 摘要和建议回复</Button>
            {c.status === 'WAITING_AGENT' && <Button loading={busy} onClick={() => act(() => api(`/inbox/conversations/${c.id}/claim`, { method: 'POST' }), '已接管')}>接管</Button>}
            {c.status === 'AI_HANDLING' && <Button loading={busy} onClick={() => act(() => api(`/inbox/conversations/${c.id}/handoff`, { method: 'POST', body: {} }), '已转人工')}>转人工</Button>}
            {['WAITING_AGENT', 'AGENT_HANDLING'].includes(c.status) && !others && (
              <Button loading={busy} onClick={() => act(() => api(`/inbox/conversations/${c.id}/release`, { method: 'POST' }), '已交还 AI')}>交还 AI</Button>
            )}
            <Tooltip title="复制带这条会话参数的获客助手链接，客户点开加企业微信后，线索自动和这条会话对上。请按平台规则使用，小红书优先用主页的官方组件">
              <Button loading={busy} onClick={copyWecomLink}>专属加微链接</Button>
            </Tooltip>
            <Button loading={busy} onClick={() => act(() => api(`/inbox/conversations/${c.id}/status`, { method: 'POST', body: { status: 'DIVERTED' } }), '已标记为已引流')}>已引流</Button>
            <Popconfirm title="关闭这个会话？客户再发消息会重新打开" onConfirm={() => act(() => api(`/inbox/conversations/${c.id}/status`, { method: 'POST', body: { status: 'CLOSED' } }), '已关闭')}>
              <Button type="text" loading={busy}>关闭</Button>
            </Popconfirm>
          </Space>
        </>
      )}
    </Card>
  );
}

const TABS = [
  { value: 'WAITING_AGENT', label: '待人工' },
  { value: 'mine', label: '我接待的' },
  { value: 'AI_HANDLING', label: 'AI 接待中' },
  { value: 'AGENT_HANDLING', label: '人工接待中' },
  { value: 'DIVERTED,CLOSED', label: '已结束' },
  { value: '', label: '全部' },
];

function useConversations(tab: string, accountId?: string, q?: string) {
  const { message } = App.useApp();
  const [data, setData] = useState<{ items: Conversation[]; counts: Record<string, number> }>({ items: [], counts: {} });
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (tab === 'mine') p.set('mine', 'true');
    else if (tab) p.set('status', tab);
    if (accountId) p.set('accountId', accountId);
    if (q) p.set('q', q);
    return api<typeof data>(`/inbox/conversations?${p}`).then(setData, (e) => message.error(e.message));
  }, [tab, accountId, q, message]);
  useEffect(() => void load(), [load]);
  usePolling(() => void load());
  return { ...data, load };
}

export function InboxPage() {
  const { can } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState(can(...AGENT_ROLES) ? 'WAITING_AGENT' : '');
  const [accountId, setAccountId] = useState<string>();
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pasting, setPasting] = useState(false);
  const [setting, setSetting] = useState(false);
  const { items, counts, load } = useConversations(tab, accountId, q);
  useEffect(() => void api<Account[]>('/accounts').then(setAccounts, () => undefined), []);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>收件箱</Typography.Title>
          <Typography.Text type="secondary">
            小红书私信和咨询评论统一接待：AI 先回，按规则转人工。半自动账号的回复需要复制到小红书发送。手机上用企业微信打开 <Link to="/m/inbox">手机版</Link>。
          </Typography.Text>
        </div>
        <Space wrap>
          {can(...AGENT_ROLES) && <Button type="primary" onClick={() => setPasting(true)}>贴入客户消息</Button>}
          {can('ADMIN') && <Button onClick={() => setSetting(true)}>接待设置</Button>}
        </Space>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }} className="inbox-grid">
        <Card size="small" styles={{ body: { padding: 8 } }}>
          <Space direction="vertical" size={8} style={{ width: '100%', padding: 4 }}>
            <Segmented
              size="small"
              block
              value={tab}
              onChange={(v) => setTab(v as string)}
              options={TABS.slice(0, 3).map((t) => ({ value: t.value, label: <Badge size="small" count={t.value === 'WAITING_AGENT' ? counts.WAITING_AGENT : 0} offset={[8, -2]}>{t.label}</Badge> }))}
            />
            <Space.Compact block>
              <Select
                size="small"
                style={{ width: 120 }}
                value={TABS.slice(3).some((t) => t.value === tab) ? tab : undefined}
                placeholder="更多状态"
                onChange={setTab}
                options={TABS.slice(3)}
              />
              <Select size="small" style={{ flex: 1 }} allowClear placeholder="全部账号" value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.id, label: a.name }))} />
            </Space.Compact>
            <Input.Search size="small" allowClear placeholder="搜昵称或消息" onSearch={setQ} />
          </Space>
          <div style={{ maxHeight: 'calc(100vh - 330px)', overflowY: 'auto', marginTop: 4 }}>
            {items.length ? (
              items.map((c) => <ConvItem key={c.id} c={c} active={c.id === id} onClick={() => navigate(`/inbox/${c.id}`)} />)
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tab === 'WAITING_AGENT' ? '没有等待人工的客户' : '没有会话'} />
            )}
          </div>
        </Card>
        {id ? (
          <ConversationView id={id} onChanged={() => void load()} />
        ) : (
          <Card><Empty description="从左边选一个会话" /></Card>
        )}
      </div>
      <style>{`@media (max-width: 900px) { .inbox-grid { grid-template-columns: 1fr !important; } }`}</style>

      <PasteModal open={pasting} accounts={accounts} onClose={() => setPasting(false)} onDone={(c) => { setPasting(false); setTab(c.status); void load(); navigate(`/inbox/${c.id}`); }} />
      <SettingsModal open={setting} onClose={() => setSetting(false)} />
    </Space>
  );
}

/** 半自动接入：把小红书里客户发来的话贴进来，AI 立刻给出回复。 */
function PasteModal({ open, accounts, onClose, onDone }: { open: boolean; accounts: Account[]; onClose: () => void; onDone: (c: Conversation) => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const r = await api<Conversation>('/inbox/manual', { method: 'POST', body: v });
      message.success(r.status === 'WAITING_AGENT' ? '已转人工' : 'AI 已回复，复制到小红书发送');
      form.resetFields(['text']);
      onDone(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const xhs = accounts.filter((a) => a.platform === 'XHS');
  return (
    <Modal open={open} title="贴入客户消息" okText="让 AI 回复" confirmLoading={busy} onOk={submit} onCancel={onClose} destroyOnHidden>
      <Typography.Paragraph type="secondary">同一个昵称的消息会归到同一个会话里，AI 会结合之前的对话回复。</Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ kind: 'dm', accountId: xhs.length === 1 ? xhs[0].id : undefined }}>
        <Form.Item name="accountId" label="账号" rules={[{ required: true, message: '请选择账号' }]}>
          <Select options={xhs.map((a) => ({ value: a.id, label: a.name }))} notFoundContent="先到“平台账号”里添加账号" />
        </Form.Item>
        <Form.Item name="kind" label="来自">
          <Radio.Group options={[{ value: 'dm', label: '私信' }, { value: 'comment', label: '作品评论' }]} />
        </Form.Item>
        <Form.Item name="nickname" label="客户昵称" rules={[{ required: true, message: '请填写客户昵称' }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="text" label="客户的消息" rules={[{ required: true, message: '请粘贴客户消息' }]}>
          <Input.TextArea rows={4} maxLength={2000} showCount />
        </Form.Item>
        <Form.Item name="postUrl" label="来源作品链接（选填）" rules={[{ type: 'url', message: '链接格式不对' }]}>
          <Input placeholder="https://www.xiaohongshu.com/explore/…" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const DAYS = ['一', '二', '三', '四', '五', '六', '日'].map((d, i) => ({ value: i + 1, label: `周${d}` }));

function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [values, setValues] = useState<Settings | null>(null);
  useEffect(() => {
    if (open) void api<Settings>('/inbox/settings').then(setValues, (e) => message.error(e.message));
    else setValues(null);
  }, [open, message]);
  const save = async () => {
    const v = await form.validateFields();
    try {
      await api('/inbox/settings', {
        method: 'PUT',
        body: { ...v, workHours: { days: v.days, start: v.hours[0].format('HH:mm'), end: v.hours[1].format('HH:mm') }, days: undefined, hours: undefined },
      });
      message.success('已保存');
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <Modal open={open && !!values} title="接待设置" okText="保存" onOk={save} onCancel={onClose} destroyOnHidden width={600}>
      {values && (
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{ ...values, days: values.workHours.days, hours: [dayjs(values.workHours.start, 'HH:mm'), dayjs(values.workHours.end, 'HH:mm')] }}
        >
          <Form.Item name="autoReply" label="AI 自动应答" valuePropName="checked" extra="关闭后新消息全部进“待人工”">
            <Switch />
          </Form.Item>
          <Form.Item name="days" label="人工工作日" rules={[{ required: true, message: '至少选一天' }]}>
            <Checkbox.Group options={DAYS} />
          </Form.Item>
          <Space wrap align="start">
            <Form.Item name="hours" label="人工工作时间（北京时间）" rules={[{ required: true }]}>
              <TimePicker.RangePicker format="HH:mm" minuteStep={15} />
            </Form.Item>
            <Form.Item name="slaMinutes" label="响应时限（分钟）" extra="工作时间内超时会提醒客服和管理员">
              <InputNumber min={1} max={120} />
            </Form.Item>
          </Space>
          <Form.Item name="handoffText" label="转人工时回复客户" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="offHoursText" label="非工作时间回复客户" extra="{hours} 会换成工作时间" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="小红书私信和自动回复里不能出现微信号、电话、二维码，引流只用主页留资卡、群聊卡片等官方组件。" />
          <Form.Item name={['diversion', 'C']} label="C 端引流话术" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name={['diversion', 'B']} label="B 端引流话术" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

/** 手机端接待（企业微信内打开）：待人工 / 我接待的列表，点进去整页回复。 */
export function MobileInbox() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [tab, setTab] = useState('WAITING_AGENT');
  const { items, counts, load } = useConversations(tab);
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 12, minHeight: '100vh', background: '#fafafa' }}>
      {id ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Button type="link" style={{ padding: 0 }} onClick={() => navigate('/m/inbox')}>← 返回列表</Button>
          <ConversationView id={id} compact onChanged={() => void load()} />
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Title level={4} style={{ margin: 0 }}>好时节 · 接待</Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{me?.name}</Typography.Text>
          </div>
          <Segmented
            block
            value={tab}
            onChange={(v) => setTab(v as string)}
            options={[
              { value: 'WAITING_AGENT', label: `待人工${counts.WAITING_AGENT ? `（${counts.WAITING_AGENT}）` : ''}` },
              { value: 'mine', label: '我接待的' },
            ]}
          />
          <Card size="small" styles={{ body: { padding: 4 } }}>
            {items.length ? (
              <List dataSource={items} renderItem={(c) => <ConvItem key={c.id} c={c} onClick={() => navigate(`/m/inbox/${c.id}`)} />} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有需要接待的客户" />
            )}
          </Card>
          <Link to="/inbox" style={{ fontSize: 12 }}>打开电脑版</Link>
        </Space>
      )}
    </div>
  );
}
