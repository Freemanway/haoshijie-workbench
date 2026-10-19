import { Alert, App, Button, Card, Form, Image, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CrudTable } from '../components/CrudTable';
import { api, AUDIENCE_LABEL, PLATFORM_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Status { enabled: boolean; callback: boolean; callbackPath: string }
interface Account { id: string; name: string; platform: string }
interface Member { id: string; wecomId: string; name: string; active: boolean }
interface Group {
  id: string;
  name: string;
  chatIds: string[];
  autoCreate: boolean;
  roomBaseName: string | null;
  roomBaseId: number | null;
  qrCode: string | null;
  members: Record<string, { name: string; count: number }> | null;
  checkedAt: string | null;
  active: boolean;
}
interface Channel {
  id: string;
  kind: 'qr' | 'link';
  name: string;
  accountId: string | null;
  account: Account | null;
  audience: string;
  staff: string[];
  qrCode: string | null;
  url: string | null;
  tagId: string | null;
  welcomeText: string | null;
  groupWayId: string | null;
  groupWay: { id: string; name: string } | null;
  active: boolean;
  added: number;
  addedWeek: number;
}
interface Contact {
  id: string;
  externalUserId: string;
  staffId: string;
  name: string | null;
  welcome: string | null;
  tagged: boolean;
  addedAt: string;
  removedAt: string | null;
  channel: { name: string } | null;
  lead: { id: string; status: string; audience: string; conversationId: string | null } | null;
}
interface Settings { welcome: { C: string; B: string }; groupFullAt: number }

const KIND: Record<string, string> = { qr: '联系我二维码', link: '获客助手链接' };
const WELCOME: Record<string, { text: string; color?: string }> = {
  sent: { text: '已发', color: 'green' },
  failed: { text: '发送失败', color: 'red' },
  skipped: { text: '未发' },
};
const LEAD_STATUS: Record<string, string> = { NEW: '新线索', ADDED_WECOM: '已加微', FOLLOWING: '跟进中', WON: '已成交', LOST: '已流失' };

function QrButton({ title, src }: { title: string; src: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)}>二维码</Button>
      <Modal title={title} open={open} footer={null} onCancel={() => setOpen(false)} width={360}>
        <Space direction="vertical" align="center" style={{ width: '100%' }}>
          <Image src={src} width={260} preview={false} alt={title} />
          <Typography.Link href={src} target="_blank" rel="noreferrer">打开原图（右键保存，用于主页、物料）</Typography.Link>
        </Space>
      </Modal>
    </>
  );
}

function CopyLink({ url }: { url: string }) {
  const { message } = App.useApp();
  return (
    <Button
      type="link"
      size="small"
      onClick={() => navigator.clipboard.writeText(url).then(() => message.success('已复制链接'), () => message.warning('浏览器不允许复制，请手动复制'))}
    >
      复制链接
    </Button>
  );
}

function ChannelsTab({ status }: { status: Status | null }) {
  const { can } = useAuth();
  const admin = can('ADMIN');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    void api<Account[]>('/accounts').then(setAccounts, () => undefined);
    void api<Group[]>('/wecom/groups').then((g) => setGroups(g.filter((x) => x.active)), () => undefined);
    if (admin) void api<Member[]>('/users').then((m) => setMembers(m.filter((x) => x.active)), () => undefined);
  }, [admin]);
  const memberName = (id: string) => members.find((m) => m.wecomId === id)?.name ?? id;

  return (
    <CrudTable<Channel>
      entity="渠道活码"
      listPath="/wecom/channels"
      basePath="/wecom/channels"
      canEdit={admin && !!status?.enabled}
      initialValues={{ kind: 'qr', audience: 'C' }}
      toForm={(c) => ({ ...c, welcomeText: c.welcomeText ?? '' })}
      toBody={(v) => ({ ...v, accountId: v.accountId || null, groupWayId: v.groupWayId || null, welcomeText: v.welcomeText || null })}
      columns={[
        {
          title: '渠道', dataIndex: 'name',
          render: (n: string, c) => (
            <Space direction="vertical" size={0}>
              <span>{n} {!c.active && <Tag>已停用</Tag>}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{KIND[c.kind]}{c.tagId ? ' · 自动打来源标签' : ''}</Typography.Text>
            </Space>
          ),
        },
        { title: '平台账号', dataIndex: 'account', render: (a: Account | null) => (a ? `${PLATFORM_LABEL[a.platform] ?? a.platform} · ${a.name}` : '通用') },
        { title: '客群', dataIndex: 'audience', render: (a: string) => AUDIENCE_LABEL[a] ?? a },
        { title: '接待成员', dataIndex: 'staff', render: (s: string[]) => s.map((x) => <Tag key={x}>{memberName(x)}</Tag>) },
        { title: '欢迎语', dataIndex: 'welcomeText', render: (t: string | null, c) => <Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }}>{t ?? '默认'}{c.groupWay ? `，附 ${c.groupWay.name}` : ''}</Typography.Text> },
        { title: '加微（近 7 天 / 累计）', key: 'added', render: (_, c) => `${c.addedWeek} / ${c.added}` },
      ]}
      rowActions={(c) => (
        <>
          {c.active && c.qrCode && <QrButton title={c.name} src={c.qrCode} />}
          {c.active && c.url && <CopyLink url={c.url} />}
        </>
      )}
      form={
        <>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) => (
              <Form.Item label="类型" name="kind" extra="二维码适合放主页、包裹卡和线下物料；获客链接点开即可加微，适合按平台规则放在主页或私信里">
                <Select disabled={!!getFieldValue('id')} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            )}
          </Form.Item>
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Form.Item label="渠道名称" name="name" rules={[{ required: true, message: '请填写渠道名称' }]} extra="同名的客户标签会自动建在“好时节来源渠道”标签组里">
            <Input maxLength={30} placeholder="如：小红书-好时节果园" />
          </Form.Item>
          <Form.Item label="对应平台账号" name="accountId" extra="报表按它统计各账号带来的加微数">
            <Select allowClear placeholder="通用" options={accounts.map((a) => ({ value: a.id, label: `${PLATFORM_LABEL[a.platform] ?? a.platform} · ${a.name}` }))} />
          </Form.Item>
          <Form.Item label="客群" name="audience"><Select options={Object.entries(AUDIENCE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item label="接待成员" name="staff" rules={[{ required: true, message: '至少选一位接待成员' }]} extra="多人时企业微信轮流分配；C 端一般选零售客服，B 端选招商负责人">
            <Select mode="multiple" options={members.map((m) => ({ value: m.wecomId, label: `${m.name}（${m.wecomId}）` }))} />
          </Form.Item>
          <Form.Item label="欢迎语（选填）" name="welcomeText" extra="不填用默认欢迎语；{name} 会换成客户微信昵称；保存前过风控">
            <Input.TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
          <Form.Item label="欢迎语附带团购群活码（C 端）" name="groupWayId">
            <Select allowClear placeholder="不附带" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
          </Form.Item>
        </>
      }
    />
  );
}

function GroupsTab({ status }: { status: Status | null }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const admin = can('ADMIN');
  const check = async (g: Group, reload: () => void) => {
    try {
      await api(`/wecom/groups/${g.id}/check`, { method: 'POST' });
      message.success('已刷新群人数');
      reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  return (
    <CrudTable<Group>
      entity="群活码"
      listPath="/wecom/groups"
      basePath="/wecom/groups"
      canEdit={admin && !!status?.enabled}
      initialValues={{ autoCreate: true, roomBaseId: 1 }}
      columns={[
        { title: '名称', dataIndex: 'name', render: (n: string, g) => <>{n} {!g.active && <Tag>已停用</Tag>}</> },
        {
          title: '关联的群（人数）', dataIndex: 'chatIds',
          render: (ids: string[], g) => (
            <Space wrap size={4}>
              {ids.map((id) => {
                const m = g.members?.[id];
                return <Tag key={id} color={m && m.count >= 190 ? 'orange' : undefined}>{m ? `${m.name} ${m.count} 人` : id}</Tag>;
              })}
            </Space>
          ),
        },
        { title: '群满自动建群', dataIndex: 'autoCreate', render: (a: boolean, g) => (a ? `是（${g.roomBaseName ?? g.name}${g.roomBaseId ?? 1} 起）` : '否，快满时提醒') },
        { title: '最近检查', dataIndex: 'checkedAt', render: (t: string | null) => (t ? dayjs(t).format('MM-DD HH:mm') : '—') },
      ]}
      rowActions={(g, reload) => (
        <>
          {g.active && g.qrCode && <QrButton title={g.name} src={g.qrCode} />}
          {g.active && can('CS') && <Button type="link" size="small" onClick={() => check(g, reload)}>刷新人数</Button>}
        </>
      )}
      form={
        <>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '请填写名称' }]}><Input maxLength={30} placeholder="如：秋季鲜果团购群" /></Form.Item>
          <Form.Item label="客户群 ID" name="chatIds" rules={[{ required: true, message: '至少填一个客户群 ID' }]} extra="最多 5 个群，按顺序进人；群 ID 可在企业微信客户群详情或接口里查到">
            <Select mode="tags" tokenSeparators={[',', '，', ' ']} placeholder="输入后回车" />
          </Form.Item>
          <Form.Item label="群满后自动建新群" name="autoCreate" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item label="新群名称前缀" name="roomBaseName"><Input maxLength={40} placeholder="不填用上面的名称" /></Form.Item>
          <Form.Item label="新群起始序号" name="roomBaseId"><InputNumber min={1} max={10000} /></Form.Item>
        </>
      }
    />
  );
}

function ContactsTab() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api<Contact[]>('/wecom/contacts'));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);
  useEffect(() => void load(), [load]);
  return (
    <Table<Contact>
      rowKey="id"
      size="middle"
      loading={loading}
      dataSource={rows}
      scroll={{ x: true }}
      columns={[
        { title: '加微时间', dataIndex: 'addedAt', render: (t: string) => dayjs(t).format('MM-DD HH:mm') },
        { title: '客户', dataIndex: 'name', render: (n: string | null, c) => <>{n ?? '微信用户'} {c.removedAt && <Tag>已删除</Tag>}</> },
        { title: '接待成员', dataIndex: 'staffId' },
        { title: '来源渠道', dataIndex: 'channel', render: (c: { name: string } | null) => c?.name ?? '其他（非活码添加）' },
        { title: '欢迎语', dataIndex: 'welcome', render: (w: string | null) => (w ? <Tag color={WELCOME[w]?.color}>{WELCOME[w]?.text ?? w}</Tag> : '—') },
        { title: '来源标签', dataIndex: 'tagged', render: (t: boolean) => (t ? '已打' : '—') },
        {
          title: '线索', dataIndex: 'lead',
          render: (l: Contact['lead']) => (l ? <Space size={4}><Tag>{AUDIENCE_LABEL[l.audience]}</Tag>{LEAD_STATUS[l.status] ?? l.status}{l.conversationId && <Link to={`/inbox/${l.conversationId}`}>私信会话</Link>}</Space> : '—'),
        },
      ]}
    />
  );
}

function SettingsTab({ status }: { status: Status | null }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [form] = Form.useForm<Settings>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api<Settings>('/wecom/settings').then((s) => form.setFieldsValue(s), (e) => message.error(e.message));
  }, [form, message]);
  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api('/wecom/settings', { method: 'PUT', body: v });
      message.success('已保存');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 720 }}>
      <Card size="small" title="默认欢迎语">
        <Form form={form} layout="vertical" disabled={!can('ADMIN')}>
          <Form.Item label="C 端" name={['welcome', 'C']} rules={[{ required: true }]} extra="{name} 会换成客户微信昵称"><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item>
          <Form.Item label="B 端" name={['welcome', 'B']} rules={[{ required: true }]}><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item>
          <Form.Item label="团购群到多少人算快满" name="groupFullAt" extra="没开自动建群的群活码，所有群都到这个人数时提醒客服换群"><InputNumber min={10} max={500} suffix="人" /></Form.Item>
          {can('ADMIN') && <Button type="primary" loading={saving} onClick={save}>保存</Button>}
        </Form>
      </Card>
      <Card size="small" title="企业微信后台配置">
        <Typography.Paragraph>
          1. 在“客户联系 &gt; 客户 &gt; API”里，把工作台的自建应用设为“可调用应用”，并给接待成员开通客户联系权限。
        </Typography.Paragraph>
        <Typography.Paragraph>
          2. 在自建应用的“接收消息 &gt; 设置 API 接收”里，URL 填 <Typography.Text code copyable>{`${origin}${status?.callbackPath ?? '/api/wecom/callback'}`}</Typography.Text>（换成正式域名），Token 和 EncodingAESKey 随机生成后填进服务器的 WECOM_CALLBACK_TOKEN、WECOM_CALLBACK_AES_KEY。
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          3. 获客助手链接需要企业开通获客助手（按企业微信规则可能收费）；联系我二维码和群活码不需要。
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

export function WecomPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    void api<Status>('/wecom/status').then(setStatus, () => undefined);
  }, []);
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>私域引流</Typography.Title>
        <Typography.Text type="secondary">每个平台账号一个企业微信渠道活码，加微时自动发欢迎语、打来源标签、建线索；C 端客户可附团购群活码</Typography.Text>
      </div>
      {status && !status.enabled && <Alert type="warning" showIcon message="还没配置企业微信" description="服务器配置 WECOM_CORP_ID、WECOM_AGENT_ID、WECOM_SECRET 后才能生成活码。" />}
      {status?.enabled && !status.callback && <Alert type="info" showIcon message="还没配置加微回调" description="活码可以生成，但欢迎语、来源标签和线索关联需要先配置回调（见“欢迎语与配置”）。" />}
      <Tabs
        items={[
          { key: 'channels', label: '渠道活码', children: <ChannelsTab status={status} /> },
          { key: 'groups', label: '团购群活码', children: <GroupsTab status={status} /> },
          ...(can('CS', 'BIZ', 'VIEWER') ? [{ key: 'contacts', label: '最近加微', children: <ContactsTab /> }] : []),
          { key: 'settings', label: '欢迎语与配置', children: <SettingsTab status={status} /> },
        ]}
      />
    </Space>
  );
}
