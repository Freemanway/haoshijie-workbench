import { Alert, App, Button, Card, Col, DatePicker, Empty, Input, Modal, Popconfirm, Row, Select, Space, Statistic, Steps, Table, Tabs, Tag, Typography, Upload } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LeadPicker, ManualDealModal, MATCH_LABEL, TOOL_LABEL, yuan } from '../components/DealForms';
import { api, PLATFORM_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Order {
  id: string;
  tool: string;
  toolName: string;
  externalNo: string | null;
  audience: string;
  amountCents: number;
  quoteCents: number | null;
  contractNo: string | null;
  product: string | null;
  quantity: number | null;
  buyerNick: string | null;
  receiver: string | null;
  phone: string | null;
  address: string | null;
  province: string | null;
  matchedBy: string | null;
  attrPlatform: string | null;
  attrAccount: string | null;
  attrPostUrl: string | null;
  isRepeat: boolean;
  cancelled: boolean;
  rawStatus: string | null;
  orderedAt: string;
  lead: { id: string; nickname: string | null; name: string | null; audience: string; status: string } | null;
  canHandle: boolean;
}
interface Summary { orders: number; amountCents: number; matched: number; unmatched: number; repeat: number }
interface Batch { id: string; tool: string; fileName: string; total: number; created: number; duplicated: number; matched: number; failed: number; errors: { row: number; message: string }[] | null; createdAt: string }
interface Field { key: string; label: string; required: boolean }
interface Preview { headers: string[]; mapping: Record<string, string>; sample: string[][]; total: number; fields: Field[]; tools: Record<string, string> }
type ImportResult = Batch & { unmatched: number };

const TOOLS = ['ktt', 'jielong', 'huacheng', 'other'];

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

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('读不了这个文件'));
    r.readAsDataURL(f);
  });

/** 订单表导入：选工具 → 选文件 → 核对字段映射 → 导入。 */
function ImportCard({ onDone }: { onDone: () => void }) {
  const run = useAction();
  const [tool, setTool] = useState('ktt');
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f: File) => {
    if (f.size > 10 * 1024 * 1024) return void run(() => Promise.reject(new Error('文件太大，一次最多 10MB')));
    const data = await toBase64(f);
    setFile({ name: f.name, data });
    setResult(null);
    setBusy(true);
    const p = await run(() => api<Preview>('/orders/import/preview', { method: 'POST', body: { tool, fileName: f.name, data } }));
    setBusy(false);
    setPreview(p ?? null);
    setMapping(p?.mapping ?? {});
  };
  const commit = async () => {
    if (!file) return;
    setBusy(true);
    const r = await run(() => api<ImportResult>('/orders/import', { method: 'POST', body: { tool, fileName: file.name, data: file.data, mapping } }));
    setBusy(false);
    if (r) {
      setResult(r);
      setPreview(null);
      setFile(null);
      onDone();
    }
  };
  const missing = preview?.fields.filter((f) => f.required && !mapping[f.key]) ?? [];
  const canMatch = !!mapping.phone || (!!mapping.receiver && !!mapping.address);
  const step = result ? 2 : preview ? 1 : 0;

  return (
    <Card size="small" title="导入团购订单表">
      <Steps size="small" current={step} style={{ marginBottom: 16, maxWidth: 560 }} items={[{ title: '选择订单表' }, { title: '核对字段' }, { title: '导入完成' }]} />
      <Space wrap style={{ marginBottom: 12 }}>
        <span>团购工具</span>
        <Select value={tool} style={{ width: 130 }} onChange={(v) => { setTool(v); setPreview(null); setFile(null); }} options={TOOLS.map((t) => ({ value: t, label: TOOL_LABEL[t] }))} />
        <Upload accept=".xlsx,.csv" showUploadList={false} beforeUpload={(f) => { void pick(f); return false; }}>
          <Button loading={busy && !preview} type={preview ? 'default' : 'primary'}>{file ? '换一个文件' : '选择订单表'}</Button>
        </Upload>
        {file && <Typography.Text type="secondary">{file.name}</Typography.Text>}
      </Space>
      {!preview && !result && (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          从团购工具后台导出订单表（.xlsx 或 .csv），导入后按手机号、收货人加地址对到线索，对上的线索标为“已成交”，并归因到来源平台和作品。同一张表重复导入会自动跳过已导入的订单。
        </Typography.Paragraph>
      )}

      {preview && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>共 {preview.total} 行。核对每个字段对应表里的哪一列，改过的映射会按工具记住，下次直接用。</Typography.Text>
          <Row gutter={[12, 8]}>
            {preview.fields.map((f) => (
              <Col key={f.key} xs={24} sm={12} md={8} lg={6}>
                <Typography.Text type={f.required && !mapping[f.key] ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>{f.label}{f.required ? '（必填）' : ''}</Typography.Text>
                <Select
                  allowClear
                  size="small"
                  style={{ width: '100%' }}
                  placeholder="不导入"
                  value={mapping[f.key] || undefined}
                  onChange={(v) => setMapping({ ...mapping, [f.key]: v ?? '' })}
                  options={preview.headers.map((h) => ({ value: h, label: h }))}
                />
              </Col>
            ))}
          </Row>
          {!canMatch && <Alert type="warning" showIcon message="至少要有“收货电话”，或者“收货人”加“详细地址”，否则订单没法对到线索" />}
          <Table
            size="small"
            pagination={false}
            scroll={{ x: true }}
            rowKey="__row"
            dataSource={preview.sample.map((r, n) => ({ __row: n, ...Object.fromEntries(preview.headers.map((h, i) => [h, r[i] ?? ''])) }))}
            columns={preview.headers.map((h) => {
              const f = preview.fields.find((x) => mapping[x.key] === h);
              return { title: <Space direction="vertical" size={0}><span>{h}</span>{f ? <Tag color="green" style={{ marginRight: 0 }}>{f.label}</Tag> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>不导入</Typography.Text>}</Space>, dataIndex: h, ellipsis: true };
            })}
          />
          <Space>
            <Button type="primary" loading={busy} disabled={missing.length > 0 || !canMatch} onClick={commit}>导入 {preview.total} 行</Button>
            <Button onClick={() => { setPreview(null); setFile(null); }}>取消</Button>
            {missing.length > 0 && <Typography.Text type="danger">还没指定：{missing.map((f) => f.label).join('、')}</Typography.Text>}
          </Space>
        </Space>
      )}

      {result && (
        <Alert
          type={result.created ? 'success' : 'info'}
          showIcon
          closable
          onClose={() => setResult(null)}
          message={`导入 ${result.created} 单，对上线索 ${result.matched} 单，待人工关联 ${result.unmatched} 单${result.duplicated ? `，${result.duplicated} 单之前导过已跳过` : ''}${result.failed ? `，${result.failed} 行没导入` : ''}`}
          description={result.errors?.length ? (
            <Typography.Text type="secondary">{result.errors.slice(0, 10).map((e) => `第 ${e.row} 行：${e.message}`).join('；')}{result.errors.length > 10 ? ` 等 ${result.errors.length} 行` : ''}</Typography.Text>
          ) : undefined}
        />
      )}
    </Card>
  );
}

function LinkModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const run = useAction();
  const { modal } = App.useApp();
  const [leadId, setLeadId] = useState<string>();
  const reveal = async () => {
    const r = await run(() => api<{ receiver: string | null; phone: string | null; address: string | null }>(`/orders/${order.id}/reveal`, { method: 'POST' }));
    if (r) modal.info({ title: '收货信息（已记录查看）', content: <Typography.Paragraph copyable>{[r.receiver, r.phone, r.address].filter(Boolean).join(' ')}</Typography.Paragraph> });
  };
  const ok = async () => {
    if (!leadId) return;
    if (await run(() => api(`/orders/${order.id}/link`, { method: 'POST', body: { leadId } }), '已关联，线索标为已成交')) onDone();
  };
  return (
    <Modal title="关联到线索" open onOk={ok} okButtonProps={{ disabled: !leadId }} onCancel={onClose}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>
          订单 {order.externalNo?.startsWith('h:') ? '' : order.externalNo} · {yuan(order.amountCents)} · {[order.buyerNick, order.receiver, order.phone, order.address].filter(Boolean).join(' · ')}
          {order.canHandle && <Button type="link" size="small" onClick={reveal}>看完整收货信息</Button>}
        </Typography.Text>
        <LeadPicker value={leadId} onChange={setLeadId} />
        <Typography.Text type="secondary">同一手机号或同一收货人加地址的其他未关联订单会一起关联到这条线索。</Typography.Text>
      </Space>
    </Modal>
  );
}

function ImportsTab({ reload }: { reload: () => void }) {
  const { can } = useAuth();
  const run = useAction();
  const [rows, setRows] = useState<Batch[]>([]);
  const load = useCallback(() => api<Batch[]>('/orders/imports').then(setRows, () => undefined), []);
  useEffect(() => void load(), [load]);
  const remove = async (b: Batch) => {
    if (await run(() => api(`/orders/imports/${b.id}`, { method: 'DELETE' }), '已删除这批订单')) {
      void load();
      reload();
    }
  };
  return (
    <Table<Batch>
      rowKey="id"
      size="small"
      dataSource={rows}
      pagination={false}
      scroll={{ x: true }}
      locale={{ emptyText: <Empty description="还没有导入过订单表" /> }}
      columns={[
        { title: '导入时间', dataIndex: 'createdAt', render: (t: string) => dayjs(t).format('MM-DD HH:mm') },
        { title: '工具', dataIndex: 'tool', render: (t: string) => TOOL_LABEL[t] ?? t },
        { title: '文件', dataIndex: 'fileName' },
        { title: '订单', dataIndex: 'total' },
        { title: '新导入', dataIndex: 'created' },
        { title: '对上线索', dataIndex: 'matched' },
        { title: '重复跳过', dataIndex: 'duplicated' },
        { title: '没导入', key: 'failed', render: (_, b) => b.failed ? <Typography.Text type="warning" title={b.errors?.map((e) => `第 ${e.row} 行：${e.message}`).join('\n')}>{b.failed} 行</Typography.Text> : 0 },
        ...(can('ADMIN') ? [{
          title: '', key: 'op', render: (_: unknown, b: Batch) => b.created > 0 && (
            <Popconfirm title={`删除这批导入的 ${b.created} 单？关联的线索会重算成交`} onConfirm={() => void remove(b)}>
              <Button type="link" size="small" danger>整批删除</Button>
            </Popconfirm>
          ),
        }] : []),
      ]}
    />
  );
}

export function OrdersPage() {
  const { can } = useAuth();
  const run = useAction();
  const [tab, setTab] = useState('all');
  const [tool, setTool] = useState<string>();
  const [q, setQ] = useState('');
  const [range, setRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: Order[]; total: number; summary: Summary }>({ items: [], total: 0, summary: { orders: 0, amountCents: 0, matched: 0, unmatched: 0, repeat: 0 } });
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState<Order | null>(null);
  const [manual, setManual] = useState(false);

  const load = useCallback(async () => {
    if (tab === 'imports') return;
    setLoading(true);
    const qs = new URLSearchParams({ page: String(page) });
    if (tab !== 'all') qs.set('state', tab);
    if (tool) qs.set('tool', tool);
    if (q.trim()) qs.set('q', q.trim());
    if (range?.[0]) qs.set('from', range[0].format('YYYY-MM-DD'));
    if (range?.[1]) qs.set('to', range[1].format('YYYY-MM-DD'));
    const r = await run(() => api<typeof data>(`/orders?${qs}`));
    if (r) setData(r);
    setLoading(false);
  }, [tab, tool, q, range, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [load]);

  const unlink = async (o: Order) => {
    if (await run(() => api(`/orders/${o.id}/unlink`, { method: 'POST' }), '已撤销关联')) void load();
  };
  const s = data.summary;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>成交导入</Typography.Title>
          <Typography.Text type="secondary">团购订单导入后按手机号、收货人加地址对到线索，成交归因到来源平台和作品；同一客户第二单起记为复购。收货信息加密保存、列表脱敏。</Typography.Text>
        </div>
        {can('CS', 'BIZ') && <Button onClick={() => setManual(true)}>人工录入成交（B 端 / 线下）</Button>}
      </Space>

      {can('CS') && <ImportCard onDone={() => void load()} />}

      <Row gutter={[12, 12]}>
        {[
          ['订单', s.orders, '不含退款取消'],
          ['成交金额', yuan(s.amountCents), ''],
          ['对上线索', s.matched, s.orders ? `${Math.round((s.matched / s.orders) * 100)}%` : ''],
          ['待人工关联', s.unmatched, ''],
          ['复购单', s.repeat, ''],
        ].map(([label, value, hint]) => (
          <Col key={label as string} xs={12} sm={8} md={6} lg={4}>
            <Card size="small"><Statistic title={label} value={value as string | number} suffix={hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text> : undefined} /></Card>
          </Col>
        ))}
      </Row>

      <Card size="small">
        <Tabs
          size="small"
          activeKey={tab}
          onChange={(k) => { setTab(k); setPage(1); }}
          items={[
            { key: 'all', label: '全部订单' },
            { key: 'unmatched', label: `待人工关联 ${s.unmatched}` },
            { key: 'matched', label: '已对上线索' },
            { key: 'repeat', label: '复购' },
            { key: 'cancelled', label: '退款/取消' },
            { key: 'imports', label: '导入记录' },
          ]}
        />
        {tab === 'imports' ? <ImportsTab reload={() => void load()} /> : (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Input.Search allowClear placeholder="订单号、下单人、商品或完整手机号" style={{ width: 260 }} onSearch={(v) => { setQ(v); setPage(1); }} />
              <Select allowClear placeholder="团购工具" style={{ width: 130 }} value={tool} onChange={(v) => { setTool(v); setPage(1); }} options={[...TOOLS, 'manual'].map((t) => ({ value: t, label: TOOL_LABEL[t] }))} />
              <DatePicker.RangePicker value={range} onChange={(v) => { setRange(v); setPage(1); }} placeholder={['下单开始', '结束']} />
            </Space>
            <Table<Order>
              rowKey="id"
              size="middle"
              loading={loading}
              dataSource={data.items}
              scroll={{ x: true }}
              locale={{ emptyText: <Empty description={tab === 'unmatched' ? '没有待关联的订单' : '还没有订单'} /> }}
              pagination={{ current: page, pageSize: 50, total: data.total, onChange: setPage, showSizeChanger: false }}
              columns={[
                {
                  title: '订单', key: 'no',
                  render: (_, o) => (
                    <Space direction="vertical" size={0}>
                      <span>{o.externalNo && !o.externalNo.startsWith('h:') ? o.externalNo : o.contractNo ? `合同 ${o.contractNo}` : '—'}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.toolName} · {dayjs(o.orderedAt).format(o.tool === 'manual' ? 'YYYY-MM-DD' : 'MM-DD HH:mm')}</Typography.Text>
                    </Space>
                  ),
                },
                { title: '客户', key: 'who', render: (_, o) => <Space direction="vertical" size={0}><span>{o.receiver ?? o.buyerNick ?? '—'}</span><Typography.Text type="secondary" style={{ fontSize: 12 }}>{[o.buyerNick && o.receiver ? o.buyerNick : null, o.phone].filter(Boolean).join(' · ')}</Typography.Text></Space> },
                { title: '地址', dataIndex: 'address', render: (a: string | null) => a ?? '—' },
                { title: '商品', key: 'product', render: (_, o) => [o.product, o.quantity && `×${o.quantity}`].filter(Boolean).join(' ') || '—' },
                {
                  title: '金额', key: 'amount',
                  render: (_, o) => (
                    <Space size={4} wrap>
                      <Typography.Text delete={o.cancelled}>{yuan(o.amountCents)}</Typography.Text>
                      {o.cancelled && <Tag>{o.rawStatus ?? '已取消'}</Tag>}
                      {o.isRepeat && <Tag color="purple">复购</Tag>}
                    </Space>
                  ),
                },
                {
                  title: '线索', key: 'lead',
                  render: (_, o) => o.lead ? (
                    <Space direction="vertical" size={0}>
                      <Link to={`/leads?id=${o.lead.id}`}>{o.lead.nickname ?? o.lead.name ?? '客户'}</Link>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {MATCH_LABEL[o.matchedBy ?? ''] ?? o.matchedBy}
                        {o.canHandle && o.tool !== 'manual' && <Popconfirm title="撤销这张订单和线索的关联？" onConfirm={() => void unlink(o)}><Button type="link" size="small">撤销</Button></Popconfirm>}
                      </Typography.Text>
                    </Space>
                  ) : o.cancelled ? '—' : o.canHandle ? <Button size="small" onClick={() => setLinking(o)}>关联线索</Button> : <Typography.Text type="warning">待关联</Typography.Text>,
                },
                {
                  title: '归因', key: 'attr',
                  render: (_, o) => o.lead ? (
                    <Space direction="vertical" size={0}>
                      <span>{[o.attrPlatform && (PLATFORM_LABEL[o.attrPlatform] ?? o.attrPlatform), o.attrAccount].filter(Boolean).join(' · ') || '手动录入的线索'}</span>
                      {o.attrPostUrl && <a href={o.attrPostUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>来源作品</a>}
                    </Space>
                  ) : '—',
                },
              ]}
            />
          </>
        )}
      </Card>
      {linking && <LinkModal order={linking} onClose={() => setLinking(null)} onDone={() => { setLinking(null); void load(); }} />}
      {manual && <ManualDealModal onClose={() => setManual(false)} onDone={() => { setManual(false); void load(); }} />}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>团购工具开放订单接口后自动同步（二期）。快团团、群接龙、花城农夫的列名按常见导出预置，拿到真实样表后再核对。</Typography.Text>
    </Space>
  );
}
