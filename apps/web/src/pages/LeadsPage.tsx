import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
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
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, download, PLATFORM_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

type Audience = 'C' | 'B';
interface Owner { id: string; name: string }
interface Lead {
  id: string;
  audience: Audience;
  status: string;
  intent: string | null;
  intentDetail: Record<string, string | null> | null;
  nickname: string | null;
  name: string | null;
  phone: string | null;
  wechat: string | null;
  sourcePlatform: string | null;
  sourceAccount: string | null;
  sourcePostUrl: string | null;
  conversationId: string | null;
  owner: Owner | null;
  ownerId: string | null;
  nextFollowAt: string | null;
  lastFollowAt: string | null;
  createdAt: string;
  editedFields: string[];
  counts: { sources: number; addresses: number; followUps: number };
  canEdit: boolean;
}
interface Source { id: string; kind: string; platform: string | null; accountName: string | null; postUrl: string | null; conversationId: string | null; createdAt: string }
interface Address { id: string; name: string; phone: string; province: string; city: string; district: string; detail: string; confirmed: boolean; source: string; createdAt: string }
interface FollowUp { id: string; note: string; createdAt: string; user: Owner }
interface LeadDetail extends Lead {
  sources: Source[];
  addresses: Address[];
  followUps: FollowUp[];
  conversation: { id: string; status: string; summary: string | null; account: { name: string } } | null;
  wecomContacts: { staffId: string; name: string | null; addedAt: string; removedAt: string | null; channel: { name: string } | null }[];
}
interface Settings { noShip: string[]; privacyNotice: string; staleHours: number }
interface Parsed { name: string; phone: string; province: string; city: string; district: string; detail: string; ok: boolean; outOfRange: boolean; message: string }

export const LEAD_STATUS: Record<string, { text: string; color?: string }> = {
  NEW: { text: '新线索', color: 'blue' },
  ADDED_WECOM: { text: '已加微', color: 'cyan' },
  FOLLOWING: { text: '跟进中', color: 'gold' },
  WON: { text: '已成交', color: 'green' },
  LOST: { text: '已流失' },
};
const INTENT: Record<string, { text: string; color?: string }> = { high: { text: '高意向', color: 'red' }, medium: { text: '中意向', color: 'orange' }, low: { text: '低意向' } };
const DETAIL_FIELDS: Record<Audience, [string, string, string][]> = {
  C: [['scene', '购买场景', '自吃 / 送礼 / 企业采购'], ['quantity', '数量', '如 3 盒、10 斤']],
  B: [['city', '所在城市', ''], ['channel', '渠道类型', '水果店 / 商超 / 社区团购 / 电商'], ['volume', '预计采购量', ''], ['mode', '合作方式', '批发 / 代理 / 长期供货']],
};
const SOURCE_KIND: Record<string, string> = { conversation: '私信咨询', wecom: '加企业微信', manual: '手动录入', import: '导入' };
const options = (m: Record<string, { text: string }>) => Object.entries(m).map(([value, v]) => ({ value, label: v.text }));

function useAction() {
  const { message } = App.useApp();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    try {
      const r = await fn();
      if (ok) message.success(ok);
      return r;
    } catch (e) {
      message.error((e as Error).message);
      return undefined;
    }
  };
}

// ---------- 详情 ----------

function LeadForm({ lead, owners, onDone, onCancel }: { lead: LeadDetail | 'new'; owners: Owner[]; onDone: (l: LeadDetail | Lead) => void; onCancel: () => void }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const isNew = lead === 'new';
  const [audience, setAudience] = useState<Audience>(isNew ? (can('BIZ') && !can('CS') ? 'B' : 'C') : lead.audience);
  const initial = isNew
    ? { audience }
    : { ...lead, phone: undefined, nextFollowAt: lead.nextFollowAt ? dayjs(lead.nextFollowAt) : null, detail: lead.intentDetail ?? {} };
  const save = async () => {
    const v = await form.validateFields();
    const { detail, ...rest } = v;
    const body = {
      ...rest,
      nextFollowAt: v.nextFollowAt ? v.nextFollowAt.toISOString() : null,
      intentDetail: { ...(isNew ? {} : (lead.intentDetail ?? {})), ...Object.fromEntries(Object.entries(detail ?? {}).map(([k, x]) => [k, (x as string) || null])) },
      ...(v.phone ? { phone: v.phone } : { phone: undefined }),
    };
    setSaving(true);
    try {
      const r = isNew ? await api<Lead>('/leads', { method: 'POST', body }) : await api<LeadDetail>(`/leads/${lead.id}`, { method: 'PATCH', body });
      message.success('已保存');
      onDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.errors?.length) form.setFields(e.errors.map((x) => ({ name: x.field.split('.'), errors: [x.message] })));
      else message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={isNew ? '录入线索' : '编辑线索'} open onOk={save} confirmLoading={saving} onCancel={onCancel} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={initial} preserve={false} onValuesChange={(c) => c.audience && setAudience(c.audience)}>
        <Space wrap>
          <Form.Item label="客群" name="audience"><Segmented options={[{ value: 'C', label: 'C 端' }, { value: 'B', label: 'B 端' }]} /></Form.Item>
          <Form.Item label="意向" name="intent"><Select allowClear style={{ width: 120 }} options={options(INTENT)} /></Form.Item>
          {!isNew && <Form.Item label="状态" name="status"><Select style={{ width: 120 }} options={options(LEAD_STATUS)} /></Form.Item>}
        </Space>
        {isNew && <Form.Item label="昵称" name="nickname"><Input maxLength={100} placeholder="平台昵称或称呼" /></Form.Item>}
        <Space wrap>
          <Form.Item label="姓名" name="name"><Input maxLength={50} /></Form.Item>
          <Form.Item label={isNew || !lead.phone ? '手机号' : `手机号（现为 ${lead.phone}，不改留空）`} name="phone"><Input maxLength={20} /></Form.Item>
          <Form.Item label="微信" name="wechat"><Input maxLength={50} /></Form.Item>
        </Space>
        <Typography.Text type="secondary">意向内容</Typography.Text>
        <Space wrap style={{ marginTop: 8 }}>
          {DETAIL_FIELDS[audience].map(([k, label, ph]) => (
            <Form.Item key={k} label={label} name={['detail', k]}><Input placeholder={ph} maxLength={50} /></Form.Item>
          ))}
        </Space>
        <Space wrap>
          {can('ADMIN') && owners.length > 0 && (
            <Form.Item label="负责人" name="ownerId"><Select allowClear style={{ width: 160 }} placeholder="自动分配" options={owners.map((o) => ({ value: o.id, label: o.name }))} /></Form.Item>
          )}
          <Form.Item label="下次跟进" name="nextFollowAt"><DatePicker showTime={{ format: 'HH:mm' }} format="MM-DD HH:mm" /></Form.Item>
        </Space>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>人工改过的客群、意向、姓名、微信，AI 不会再覆盖。</Typography.Paragraph>
      </Form>
    </Modal>
  );
}

function AddressBlock({ lead, onChanged }: { lead: LeadDetail; onChanged: (l: LeadDetail) => void }) {
  const { message, modal } = App.useApp();
  const run = useAction();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [form] = Form.useForm();
  const [text, setText] = useState('');

  const parse = async () => {
    const p = await run(() => api<Parsed>('/leads/parse-address', { method: 'POST', body: { raw } }));
    if (!p) return;
    setParsed(p);
    form.setFieldsValue({ name: p.name, phone: p.phone, province: p.province, city: p.city, district: p.district, detail: p.detail });
  };
  const add = async () => {
    const v = await form.validateFields();
    const r = await run(() => api<LeadDetail>(`/leads/${lead.id}/addresses`, { method: 'POST', body: v }), '已添加地址');
    if (r) {
      onChanged(r);
      setAdding(false);
      setRaw('');
      setParsed(null);
    }
  };
  const doImport = async () => {
    const r = await run(() => api<{ created: number; failed: { line: number; text: string; message: string }[] }>(`/leads/${lead.id}/addresses/import`, { method: 'POST', body: { text } }));
    if (!r) return;
    setImporting(false);
    setText('');
    if (r.failed.length) modal.warning({ title: `导入 ${r.created} 个，${r.failed.length} 行没导入`, content: <List size="small" dataSource={r.failed} renderItem={(f) => <List.Item>第 {f.line} 行：{f.message}（{f.text}）</List.Item>} /> });
    else message.success(`已导入 ${r.created} 个地址`);
    const d = await api<LeadDetail>(`/leads/${lead.id}`);
    onChanged(d);
  };
  const reveal = async (a: Address) => {
    const r = await run(() => api<{ name: string; phone: string; province: string; city: string; district: string; detail: string }>(`/leads/${lead.id}/reveal`, { method: 'POST', body: { addressId: a.id } }));
    if (r) modal.info({ title: '收货地址（已记录查看）', content: <Typography.Paragraph copyable>{`${r.name} ${r.phone} ${r.province}${r.city}${r.district}${r.detail}`}</Typography.Paragraph> });
  };

  return (
    <Card size="small" title={`收货地址（${lead.addresses.length}）`} extra={lead.canEdit && (
      <Space size={4}>
        <Button size="small" onClick={() => setAdding(true)}>添加</Button>
        <Button size="small" onClick={() => setImporting(true)}>批量导入</Button>
      </Space>
    )}>
      {lead.addresses.length ? (
        <List
          size="small"
          dataSource={lead.addresses}
          renderItem={(a) => (
            <List.Item
              actions={lead.canEdit ? [
                !a.confirmed && <Button key="c" type="link" size="small" onClick={() => run(() => api<LeadDetail>(`/leads/${lead.id}/addresses/${a.id}`, { method: 'PATCH', body: { confirmed: true } }), '已确认').then((r) => r && onChanged(r))}>确认</Button>,
                <Button key="r" type="link" size="small" onClick={() => reveal(a)}>查看</Button>,
                <Popconfirm key="d" title="删除这个地址？" onConfirm={() => run(() => api<LeadDetail>(`/leads/${lead.id}/addresses/${a.id}`, { method: 'DELETE' }), '已删除').then((r) => r && onChanged(r))}>
                  <Button type="link" size="small" danger>删除</Button>
                </Popconfirm>,
              ].filter(Boolean) : []}
            >
              <Space direction="vertical" size={0}>
                <span>{a.name} {a.phone} {a.confirmed ? <Tag color="green">已确认</Tag> : <Tag color="orange">待确认</Tag>}{a.source === 'chat' && <Tag>私信识别</Tag>}{a.source === 'import' && <Tag>导入</Tag>}</span>
                <Typography.Text type="secondary">{a.province}{a.city}{a.district}{a.detail}</Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      ) : <Typography.Text type="secondary">还没有地址。客户在私信里发整段地址时会自动识别并让客户确认。</Typography.Text>}

      <Modal title="添加收货地址" open={adding} onOk={add} onCancel={() => setAdding(false)} destroyOnHidden>
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <Input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="粘贴整段地址自动拆分，如：王晓雯 138… 广东省深圳市…" />
          <Button onClick={parse} disabled={!raw.trim()}>拆分</Button>
        </Space.Compact>
        {parsed && !parsed.ok && <Alert style={{ marginBottom: 12 }} type={parsed.outOfRange ? 'error' : 'warning'} showIcon message={parsed.message} />}
        <Form form={form} layout="vertical" preserve={false} initialValues={{ confirmed: true }}>
          <Space wrap>
            <Form.Item label="收件人" name="name" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item label="电话" name="phone" rules={[{ required: true }]}><Input /></Form.Item>
          </Space>
          <Space wrap>
            <Form.Item label="省" name="province" rules={[{ required: true }]}><Input style={{ width: 120 }} /></Form.Item>
            <Form.Item label="市" name="city"><Input style={{ width: 120 }} /></Form.Item>
            <Form.Item label="区县" name="district"><Input style={{ width: 120 }} /></Form.Item>
          </Space>
          <Form.Item label="详细地址" name="detail" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="confirmed" valuePropName="checked"><Checkbox>客户已确认</Checkbox></Form.Item>
        </Form>
      </Modal>
      <Modal title="批量导入地址" open={importing} onOk={doImport} okButtonProps={{ disabled: !text.trim() }} onCancel={() => setImporting(false)} destroyOnHidden>
        <Typography.Paragraph type="secondary">企业礼赠、代送时用：每行一个地址（收件人、电话、地址），可以直接从 Excel 复制几列粘贴进来。不在配送范围或缺电话的行会列出来。</Typography.Paragraph>
        <Input.TextArea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'李雷\t13600001111\t江苏省南京市鼓楼区中山路 8 号\n韩梅梅 13600002222 上海市浦东新区世纪大道 100 号'} />
      </Modal>
    </Card>
  );
}

function FollowBlock({ lead, onChanged }: { lead: LeadDetail; onChanged: (l: LeadDetail) => void }) {
  const run = useAction();
  const [note, setNote] = useState('');
  const [next, setNext] = useState<dayjs.Dayjs | null>(null);
  const [status, setStatus] = useState<string | undefined>();
  const [script, setScript] = useState<{ advice: string; scripts: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();
  const submit = async () => {
    const r = await run(() => api<LeadDetail>(`/leads/${lead.id}/follow-ups`, { method: 'POST', body: { note, nextFollowAt: next ? next.toISOString() : undefined, status } }), '已记录');
    if (r) {
      onChanged(r);
      setNote('');
      setNext(null);
      setStatus(undefined);
    }
  };
  const loadScript = async () => {
    setLoading(true);
    const r = await run(() => api<{ advice: string; scripts: string[] }>(`/leads/${lead.id}/script`, { method: 'POST' }));
    setLoading(false);
    if (r) setScript(r);
  };
  return (
    <Card size="small" title="跟进" extra={<Button size="small" loading={loading} onClick={loadScript}>推荐话术</Button>}>
      {script && (
        <Alert
          type="info"
          style={{ marginBottom: 12 }}
          message={script.advice}
          description={
            <List size="small" dataSource={script.scripts} renderItem={(t) => (
              <List.Item actions={[<Button key="c" type="link" size="small" onClick={() => navigator.clipboard.writeText(t).then(() => message.success('已复制'), () => message.warning('请手动复制'))}>复制</Button>]}>{t}</List.Item>
            )} />
          }
          closable
          onClose={() => setScript(null)}
        />
      )}
      {lead.canEdit && (
        <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }}>
          <Input.TextArea rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="这次聊了什么、客户怎么说" />
          <Space wrap>
            <DatePicker showTime={{ format: 'HH:mm' }} format="MM-DD HH:mm" placeholder="下次跟进时间" value={next} onChange={setNext} />
            <Select allowClear placeholder="改状态（可选）" style={{ width: 140 }} value={status} onChange={setStatus} options={options(LEAD_STATUS)} />
            <Button type="primary" disabled={!note.trim()} onClick={submit}>记录跟进</Button>
          </Space>
        </Space>
      )}
      {lead.followUps.length ? (
        <Timeline items={lead.followUps.map((f) => ({ children: <><Typography.Text type="secondary">{dayjs(f.createdAt).format('MM-DD HH:mm')} · {f.user.name}</Typography.Text><div>{f.note}</div></> }))} />
      ) : <Typography.Text type="secondary">还没有跟进记录</Typography.Text>}
    </Card>
  );
}

function LeadDrawer({ id, owners, onClose, onChanged }: { id: string; owners: Owner[]; onClose: () => void; onChanged: () => void }) {
  const { modal } = App.useApp();
  const run = useAction();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api<LeadDetail>(`/leads/${id}`).then(setLead), [id]);
  useEffect(() => {
    setLead(null);
    void load().catch(() => undefined);
  }, [load]);
  const changed = (l: LeadDetail) => {
    setLead(l);
    onChanged();
  };
  const reveal = async () => {
    const r = await run(() => api<{ phone: string | null }>(`/leads/${id}/reveal`, { method: 'POST', body: {} }));
    if (r) modal.info({ title: '手机号（已记录查看）', content: <Typography.Paragraph copyable>{r.phone ?? '—'}</Typography.Paragraph> });
  };
  const detail = lead?.intentDetail ?? {};
  return (
    <Drawer open width={640} onClose={onClose} title={lead ? `${lead.nickname ?? lead.name ?? '客户'}` : '线索'} extra={lead?.canEdit && (
      <Space>
        <Button onClick={() => run(() => api<LeadDetail>(`/leads/${id}/extract`, { method: 'POST' }), '已从对话重新提取').then((r) => r && changed(r))} disabled={!lead.conversationId}>AI 从对话提取</Button>
        <Button type="primary" onClick={() => setEditing(true)}>编辑</Button>
      </Space>
    )}>
      {!lead ? <Card loading /> : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="客群">{lead.audience === 'B' ? 'B 端' : 'C 端'}</Descriptions.Item>
            <Descriptions.Item label="状态"><Tag color={LEAD_STATUS[lead.status]?.color}>{LEAD_STATUS[lead.status]?.text}</Tag></Descriptions.Item>
            <Descriptions.Item label="意向">{lead.intent ? <Tag color={INTENT[lead.intent]?.color}>{INTENT[lead.intent]?.text}</Tag> : '—'} {detail.summary}</Descriptions.Item>
            <Descriptions.Item label="负责人">{lead.owner?.name ?? '未分配'}</Descriptions.Item>
            <Descriptions.Item label="姓名">{lead.name ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="手机号">{lead.phone ?? '—'} {lead.phone && lead.canEdit && <Button type="link" size="small" onClick={reveal}>查看</Button>}</Descriptions.Item>
            <Descriptions.Item label="微信">{lead.wechat ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="下次跟进">{lead.nextFollowAt ? dayjs(lead.nextFollowAt).format('MM-DD HH:mm') : '—'}</Descriptions.Item>
            {DETAIL_FIELDS[lead.audience].map(([k, label]) => <Descriptions.Item key={k} label={label}>{detail[k] ?? '—'}</Descriptions.Item>)}
          </Descriptions>

          {lead.conversation && (
            <Card size="small" title="私信会话" extra={<Link to={`/inbox/${lead.conversation.id}`}>打开会话</Link>}>
              <Typography.Text>{lead.conversation.account.name}</Typography.Text>
              {lead.conversation.summary && <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }}>{lead.conversation.summary}</Typography.Paragraph>}
            </Card>
          )}

          <FollowBlock lead={lead} onChanged={changed} />
          <AddressBlock lead={lead} onChanged={changed} />

          <Card size="small" title={`来源记录（${lead.sources.length}）`}>
            <Timeline items={lead.sources.map((s) => ({
              children: (
                <>
                  <Typography.Text type="secondary">{dayjs(s.createdAt).format('MM-DD HH:mm')}</Typography.Text>{' '}
                  {SOURCE_KIND[s.kind] ?? s.kind}{s.platform ? ` · ${PLATFORM_LABEL[s.platform] ?? s.platform}` : ''}{s.accountName ? ` · ${s.accountName}` : ''}
                  {s.conversationId && <> · <Link to={`/inbox/${s.conversationId}`}>会话</Link></>}
                  {s.postUrl && <> · <a href={s.postUrl} target="_blank" rel="noreferrer">来源作品</a></>}
                </>
              ),
            }))} />
            {lead.wecomContacts.length > 0 && (
              <Typography.Text type="secondary">
                企业微信：{lead.wecomContacts.map((w) => `${w.staffId}（${w.channel?.name ?? '非活码'}，${dayjs(w.addedAt).format('MM-DD')}${w.removedAt ? '，已删除' : ''}）`).join('；')}
              </Typography.Text>
            )}
          </Card>
        </Space>
      )}
      {editing && lead && <LeadForm lead={lead} owners={owners} onCancel={() => setEditing(false)} onDone={(l) => { setEditing(false); changed(l as LeadDetail); }} />}
    </Drawer>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [form] = Form.useForm<Settings>();
  const run = useAction();
  useEffect(() => {
    void api<Settings>('/leads/settings').then((s) => form.setFieldsValue(s));
  }, [form]);
  const save = async () => {
    const v = await form.validateFields();
    if (await run(() => api('/leads/settings', { method: 'PUT', body: v }), '已保存')) onClose();
  };
  return (
    <Modal title="线索设置" open onOk={save} onCancel={onClose}>
      <Form form={form} layout="vertical">
        <Form.Item label="不发鲜果的地区" name="noShip" extra="客户发来这些地区的地址时，提示不在配送范围并转人工"><Select mode="tags" /></Form.Item>
        <Form.Item label="收集手机号和地址前的告知" name="privacyNotice" rules={[{ required: true }]} extra="AI 要客户留联系方式、回显地址时会带上这句（个人信息保护法告知同意）"><Input.TextArea rows={2} maxLength={200} /></Form.Item>
        <Form.Item label="新线索多久没跟进就提醒" name="staleHours"><InputNumber min={1} max={168} suffix="小时" /></Form.Item>
      </Form>
    </Modal>
  );
}

// ---------- 列表 ----------

export function LeadsPage() {
  const { can } = useAuth();
  const run = useAction();
  const [params, setParams] = useSearchParams();
  const views: Audience[] = can('ADMIN', 'VIEWER') ? ['C', 'B'] : [...(can('CS') ? ['C' as const] : []), ...(can('BIZ') ? ['B' as const] : [])];
  const [audience, setAudience] = useState<Audience>(views[0] ?? 'C');
  const [status, setStatus] = useState('all');
  const [intent, setIntent] = useState<string | undefined>();
  const [ownerId, setOwnerId] = useState<string | undefined>();
  const [mine, setMine] = useState(false);
  const [account, setAccount] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Lead[]; total: number; counts: Record<string, number> }>({ items: [], total: 0, counts: {} });
  const [loading, setLoading] = useState(false);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [setting, setSetting] = useState(false);
  const open = params.get('id');

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({ audience, page: String(page) });
    if (status !== 'all') qs.set('status', status);
    if (intent) qs.set('intent', intent);
    if (ownerId) qs.set('ownerId', ownerId);
    if (mine) qs.set('mine', 'true');
    if (account) qs.set('account', account);
    if (q.trim()) qs.set('q', q.trim());
    const r = await run(() => api<typeof data>(`/leads?${qs}`));
    if (r) setData(r);
    setLoading(false);
  }, [audience, status, intent, ownerId, mine, account, q, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void api<{ id: string; name: string }[]>('/accounts').then(setAccounts, () => undefined);
    if (can('ADMIN')) void api<(Owner & { roles: string[]; active: boolean })[]>('/users').then((u) => setOwners(u.filter((x) => x.active && x.roles.some((r) => r === 'CS' || r === 'BIZ'))), () => undefined);
  }, [can]);

  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const exportCsv = (aud?: Audience) => run(() => download(`/leads/export${aud ? `?audience=${aud}` : ''}`, '线索.csv'), '已导出（已记录导出日志）');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>线索库</Typography.Title>
          <Typography.Text type="secondary">有效咨询自动建档，同手机号或同平台账号自动合并；B 端分给招商，C 端客服轮流跟进。手机号和地址加密保存、列表脱敏。</Typography.Text>
        </div>
        <Space wrap>
          {can('CS', 'BIZ') && <Button type="primary" onClick={() => setCreating(true)}>录入线索</Button>}
          {can('ADMIN') && (
            <Dropdown menu={{ items: [{ key: 'C', label: '导出 C 端' }, { key: 'B', label: '导出 B 端' }, { key: 'all', label: '导出全部' }], onClick: ({ key }) => void exportCsv(key === 'all' ? undefined : (key as Audience)) }}>
              <Button>导出明文</Button>
            </Dropdown>
          )}
          {can('ADMIN') && <Button onClick={() => setSetting(true)}>线索设置</Button>}
        </Space>
      </Space>

      {views.length > 1 && (
        <Segmented value={audience} onChange={(v) => { setAudience(v as Audience); setPage(1); }} options={[{ value: 'C', label: 'C 端线索' }, { value: 'B', label: 'B 端线索' }]} />
      )}
      <Card size="small">
        <Tabs
          size="small"
          activeKey={status}
          onChange={(k) => { setStatus(k); setPage(1); }}
          items={[{ key: 'all', label: `全部 ${total}` }, ...Object.entries(LEAD_STATUS).map(([k, v]) => ({ key: k, label: `${v.text} ${data.counts[k] ?? 0}` }))]}
        />
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder="昵称、姓名、微信或完整手机号" style={{ width: 240 }} onSearch={(v) => { setQ(v); setPage(1); }} />
          <Select allowClear placeholder="意向" style={{ width: 110 }} value={intent} onChange={(v) => { setIntent(v); setPage(1); }} options={options(INTENT)} />
          <Select allowClear placeholder="来源账号" style={{ width: 150 }} value={account} onChange={(v) => { setAccount(v); setPage(1); }} options={accounts.map((a) => ({ value: a.name, label: a.name }))} />
          {owners.length > 0 ? (
            <Select allowClear placeholder="负责人" style={{ width: 130 }} value={ownerId} onChange={(v) => { setOwnerId(v); setPage(1); }} options={[{ value: 'none', label: '未分配' }, ...owners.map((o) => ({ value: o.id, label: o.name }))]} />
          ) : can('CS', 'BIZ') && <Checkbox checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }}>只看我负责的</Checkbox>}
        </Space>
        <Table<Lead>
          rowKey="id"
          size="middle"
          loading={loading}
          dataSource={data.items}
          locale={{ emptyText: <Empty description="还没有线索" /> }}
          scroll={{ x: true }}
          onRow={(l) => ({ onClick: () => setParams({ id: l.id }), style: { cursor: 'pointer' } })}
          pagination={{ current: page, pageSize: 50, total: data.total, onChange: setPage, showSizeChanger: false }}
          columns={[
            { title: '客户', key: 'who', render: (_, l) => <Space direction="vertical" size={0}><span>{l.nickname ?? l.name ?? '客户'}</span>{l.name && l.nickname && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{l.name}</Typography.Text>}</Space> },
            { title: '意向', key: 'intent', render: (_, l) => <Space size={4} wrap>{l.intent && <Tag color={INTENT[l.intent]?.color}>{INTENT[l.intent]?.text}</Tag>}<Typography.Text type="secondary">{l.intentDetail?.summary ?? ''}</Typography.Text></Space> },
            { title: '联系方式', key: 'contact', render: (_, l) => [l.phone, l.wechat && `微信 ${l.wechat}`].filter(Boolean).join(' · ') || '—' },
            { title: '来源', key: 'src', render: (_, l) => <>{[l.sourcePlatform && (PLATFORM_LABEL[l.sourcePlatform] ?? l.sourcePlatform), l.sourceAccount].filter(Boolean).join(' · ') || '手动录入'}{l.counts.sources > 1 && <Tag style={{ marginLeft: 4 }}>{l.counts.sources} 次来源</Tag>}</> },
            { title: '负责人', key: 'owner', render: (_, l) => l.owner?.name ?? <Typography.Text type="secondary">未分配</Typography.Text> },
            { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={LEAD_STATUS[s]?.color}>{LEAD_STATUS[s]?.text ?? s}</Tag> },
            {
              title: '下次跟进', dataIndex: 'nextFollowAt',
              render: (t: string | null, l) => t ? <Typography.Text type={dayjs(t).isBefore(dayjs()) ? 'danger' : undefined}>{dayjs(t).format('MM-DD HH:mm')}</Typography.Text> : !l.lastFollowAt && dayjs(l.createdAt).isBefore(dayjs().subtract(24, 'hour')) ? <Typography.Text type="warning">超 24 小时未跟进</Typography.Text> : '—',
            },
            { title: '进来时间', dataIndex: 'createdAt', render: (t: string) => dayjs(t).format('MM-DD HH:mm') },
          ]}
        />
      </Card>
      {open && <LeadDrawer id={open} owners={owners} onClose={() => setParams({})} onChanged={() => void load()} />}
      {creating && <LeadForm lead="new" owners={owners} onCancel={() => setCreating(false)} onDone={(l) => { setCreating(false); void load(); setParams({ id: l.id }); }} />}
      {setting && <SettingsModal onClose={() => setSetting(false)} />}
    </Space>
  );
}
