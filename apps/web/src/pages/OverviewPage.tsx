import { Alert, App, Button, Card, Col, DatePicker, Empty, List, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { yuan } from '../components/DealForms';
import { api, download, PLATFORM_LABEL } from '../lib/api';
import { useAuth } from '../lib/auth';

/** C 端、B 端两个系列的颜色（已过色盲与对比度校验），图例和标签始终带文字 */
const SERIES = { C: '#9B4A78', B: '#2F6DB5' } as const;
type Aud = 'C' | 'B';

interface Kpi { posts: number; reads: number; consults: number; leads: number; leadsC: number; leadsB: number; dealCents: number }
interface Group { name: string; posts: number; reads: number; rate: number | null; consults: number; leads: number }
interface Post { id: string; title: string; category: string; audience: Aud; platform: string; account: string; publishedAt: string; postUrl: string | null; reads: number; rate: number | null; filled: boolean; consults: number; leads: number }
type Ranked = { name: string; count: number }[];
interface LeadStat { new: number; wecom: number; won: number; wecomRate: number | null; wonRate: number | null; orders: number; repeat: number; dealCents: number; intent: Record<string, number>; scene: Ranked; channel: Ranked; city: Ranked; sources: Ranked; posts: Ranked; categories: Ranked }
interface Dashboard {
  from: string;
  to: string;
  kpi: Kpi;
  prev: { from: string; to: string; kpi: Kpi };
  funnel: { audience: Aud; steps: { key: string; label: string; value: number }[] }[];
  content: { posts: Post[]; unfilled: number; byPlatform: Group[]; byAccount: Group[]; byCategory: Group[]; top: Post[] };
  service: {
    daily: { date: string; consults: number; posts: number }[];
    conversations: number; aiReplies: number; aiOnly: number; handoffs: number; handoffRate: number | null;
    reasons: { reason: string; count: number }[]; firstResponse: number | null; firstResponseCount: number;
    byAgent: { name: string; count: number; avg: number | null }[]; topQuestions: { question: string; count: number }[];
  };
  leads: Record<Aud, LeadStat>;
}
interface Insight { highlights: string[]; problems: string[]; suggestions: string[] }
interface ReportRow { id: string; kind: 'week' | 'month'; from: string; to: string; pushedAt: string | null; createdAt: string }
interface Report extends ReportRow { data: Dashboard; insight: Insight | null }

const fmtDate = (d: Dayjs) => d.format('YYYY-MM-DD');
const lastWeek = (): [Dayjs, Dayjs] => {
  const monday = dayjs().subtract((dayjs().day() + 6) % 7, 'day');
  return [monday.subtract(7, 'day'), monday.subtract(1, 'day')];
};
const PRESETS: { label: string; value: [Dayjs, Dayjs] }[] = [
  { label: '上周', value: lastWeek() },
  { label: '本周', value: [lastWeek()[1].add(1, 'day'), dayjs()] },
  { label: '上月', value: [dayjs().subtract(1, 'month').startOf('month'), dayjs().subtract(1, 'month').endOf('month')] },
  { label: '本月', value: [dayjs().startOf('month'), dayjs()] },
  { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] },
];
const pctText = (v: number | null) => (v == null ? '—' : `${v}%`);
const num = (n: number) => n.toLocaleString('zh-CN');

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>上期 0</Typography.Text>;
  const d = Math.round(((cur - prev) / prev) * 1000) / 10;
  return <Typography.Text type={d > 0 ? 'success' : d < 0 ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>环比 {d > 0 ? '+' : ''}{d}%</Typography.Text>;
}

/** 横向条形清单：名称、细条、数量；条长按本组最大值 */
function BarList({ rows, color = '#8c8c8c', empty = '暂无数据' }: { rows: { name: string; count: number }[]; color?: string; empty?: string }) {
  if (!rows.length) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {rows.map((r) => (
        <Tooltip key={r.name} title={`${r.name}：${r.count}`}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) 40px', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <div style={{ height: 8, borderRadius: 4, background: color, width: `${Math.max(3, (r.count / max) * 100)}%` }} />
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.count}</span>
          </div>
        </Tooltip>
      ))}
    </Space>
  );
}

/** 转化漏斗：条长按平方根缩放（曝光和成交差几个数量级），每步标转化率 */
function Funnel({ f }: { f: Dashboard['funnel'][number] }) {
  const max = Math.max(f.steps[0].value, ...f.steps.map((s) => s.value), 1);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Tag color={f.audience === 'C' ? 'magenta' : 'blue'} style={{ alignSelf: 'flex-start' }}>{f.audience} 端</Tag>
      {f.steps.map((s, i) => {
        const prev = i ? f.steps[i - 1].value : null;
        // 线索也可能来自手动录入、企业微信，会多于私信咨询；超过 100% 的转化率没有意义，不显示
        const rate = prev && s.value <= prev ? `${Math.round((s.value / prev) * 1000) / 10}%` : prev ? '—' : '';
        const tip = rate === '—' ? '，多于上一步（含其他来源），不计转化率' : rate ? `，较上一步 ${rate}` : '';
        return (
          <Tooltip key={s.key} title={`${s.label} ${num(s.value)}${tip}`}>
            <div style={{ display: 'grid', gridTemplateColumns: '40px minmax(0, 1fr) 64px 56px', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <Typography.Text type="secondary">{s.label}</Typography.Text>
              <div style={{ height: 16, borderRadius: 4, background: SERIES[f.audience], width: `${Math.max(2, Math.sqrt(s.value / max) * 100)}%` }} />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{num(s.value)}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>{rate}</Typography.Text>
            </div>
          </Tooltip>
        );
      })}
    </Space>
  );
}

/** 每日咨询人次柱状图（单系列，悬停看当天发布数） */
function DailyChart({ daily }: { daily: Dashboard['service']['daily'] }) {
  const W = 640;
  const H = 180;
  const pl = 32;
  const pb = 24;
  const pt = 10;
  const max = Math.max(4, ...daily.map((d) => d.consults));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const bw = Math.min(28, ((W - pl) / daily.length) * 0.6);
  const x = (i: number) => pl + ((i + 0.5) * (W - pl)) / daily.length;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const every = Math.ceil(daily.length / 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="每日咨询人次">
      {[0, 1, 2, 3, 4].map((k) => (
        <g key={k}>
          <line x1={pl} x2={W} y1={y(k * step)} y2={y(k * step)} stroke="#f0f0f0" />
          <text x={pl - 6} y={y(k * step) + 4} textAnchor="end" fontSize="10" fill="#8c8c8c">{k * step}</text>
        </g>
      ))}
      {daily.map((d, i) => (
        <g key={d.date}>
          <title>{`${d.date}：咨询 ${d.consults} 人次，发布 ${d.posts} 篇`}</title>
          <rect x={x(i) - bw / 2 - 4} y={pt} width={bw + 8} height={H - pt - pb} fill="transparent" />
          {d.consults > 0 && <rect x={x(i) - bw / 2} y={y(d.consults)} width={bw} height={y(0) - y(d.consults)} rx={4} fill={SERIES.C} />}
          {d.posts > 0 && <circle cx={x(i)} cy={H - pb + 4} r={3} fill="#595959" />}
          {i % every === 0 && <text x={x(i)} y={H - 4} textAnchor="middle" fontSize="10" fill="#8c8c8c">{d.date.slice(5)}</text>}
        </g>
      ))}
    </svg>
  );
}

function groupColumns(first: string) {
  return [
    { title: first, dataIndex: 'name' },
    { title: '篇数', dataIndex: 'posts' },
    { title: '阅读', dataIndex: 'reads', render: num },
    { title: '互动率', dataIndex: 'rate', render: pctText },
    { title: '咨询', dataIndex: 'consults' },
    { title: '线索', dataIndex: 'leads' },
  ];
}

function InsightCard({ insight }: { insight: Insight }) {
  const block = (title: string, rows: string[], type: 'success' | 'warning' | undefined) => rows.length > 0 && (
    <div>
      <Typography.Text strong type={type}>{title}</Typography.Text>
      <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{rows.map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  );
  return (
    <Card size="small" title="AI 解读" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>只依据本期数字生成，发出前请核对</Typography.Text>}>
      <Space direction="vertical" size={8}>
        {block('本期亮点', insight.highlights, 'success')}
        {block('问题', insight.problems, 'warning')}
        {block('下期建议', insight.suggestions, undefined)}
      </Space>
    </Card>
  );
}

export function OverviewPage() {
  const { can } = useAuth();
  const { message } = App.useApp();
  const [params, setParams] = useSearchParams();
  const reportId = params.get('report');
  const [range, setRange] = useState<[Dayjs, Dayjs]>(lastWeek());
  const [platform, setPlatform] = useState<string>();
  const [accountId, setAccountId] = useState<string>();
  const [accounts, setAccounts] = useState<{ id: string; name: string; platform: string }[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [data, setData] = useState<Dashboard | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const query = useCallback(() => {
    const qs = new URLSearchParams({ from: fmtDate(range[0]), to: fmtDate(range[1]) });
    if (platform) qs.set('platform', platform);
    if (accountId) qs.set('accountId', accountId);
    return qs;
  }, [range, platform, accountId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (reportId) {
        const r = await api<Report>(`/reports/${reportId}`);
        setReport(r);
        setData(r.data);
      } else {
        setReport(null);
        setData(await api<Dashboard>(`/reports/dashboard?${query()}`));
      }
    } catch (e) {
      message.error((e as Error).message);
    }
    setLoading(false);
  }, [reportId, query, message]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void api<{ id: string; name: string; platform: string }[]>('/accounts').then(setAccounts, () => undefined);
    void api<ReportRow[]>('/reports').then(setReports, () => undefined);
  }, []);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api<Report>('/reports/generate', { method: 'POST', body: { kind: 'week', from: fmtDate(range[0]), to: fmtDate(range[1]), push: false } });
      message.success('已生成这一期的报告和 AI 解读');
      setReports(await api<ReportRow[]>('/reports'));
      setParams({ report: r.id });
    } catch (e) {
      message.error((e as Error).message);
    }
    setBusy(false);
  };
  const exportXlsx = async () => {
    const from = data?.from ?? fmtDate(range[0]);
    const to = data?.to ?? fmtDate(range[1]);
    const qs = report ? new URLSearchParams({ from, to }) : query();
    try {
      await download(`/reports/export?${qs}`, `数据明细-${from}至${to}.xlsx`);
      message.success(can('ADMIN') ? '已导出（含脱敏线索，已记录导出日志）' : '已导出');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const k = data?.kpi;
  const p = data?.prev.kpi;
  const kpis: [string, string, number, number, string?][] = k && p ? [
    ['发布量', `${k.posts} 篇`, k.posts, p.posts],
    ['阅读', num(k.reads), k.reads, p.reads, data!.content.unfilled ? `${data!.content.unfilled} 篇未回填` : undefined],
    ['私信咨询', `${k.consults} 人次`, k.consults, p.consults],
    ['新增线索', String(k.leads), k.leads, p.leads, `C ${k.leadsC} · B ${k.leadsB}`],
    ['成交金额', yuan(k.dealCents), k.dealCents, p.dealCents],
  ] : [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }} className="report-page">
      <style>{`@media print {
        .ant-layout-sider, .ant-layout-header, .no-print { display: none !important; }
        .ant-layout-content { margin: 0 !important; padding: 0 !important; }
        .report-page .ant-card { break-inside: avoid; }
      }`}</style>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>数据周报</Typography.Title>
          <Typography.Text type="secondary">
            {data ? `${data.from} 至 ${data.to}，环比 ${data.prev.from} 至 ${data.prev.to}` : '内容、客服、客资三个板块和转化漏斗'}
            {report && ` · ${report.kind === 'week' ? '周报' : '月报'}快照，${dayjs(report.createdAt).format('MM-DD HH:mm')} 生成${report.pushedAt ? '，已推送企业微信' : ''}`}
          </Typography.Text>
        </div>
        <Space wrap className="no-print">
          <Button onClick={() => window.print()} disabled={!data}>导出 PDF</Button>
          <Button onClick={exportXlsx} disabled={!data}>导出明细 Excel</Button>
          {can('ADMIN') && !report && <Button loading={busy} onClick={generate}>生成这一期报告</Button>}
        </Space>
      </Space>

      <Card size="small" className="no-print">
        <Space wrap>
          <Select
            style={{ width: 220 }}
            placeholder="查看已生成的周报 / 月报"
            allowClear
            value={reportId ?? undefined}
            onChange={(v) => setParams(v ? { report: v } : {})}
            options={reports.map((r) => ({ value: r.id, label: `${r.kind === 'week' ? '周报' : '月报'} ${r.from.slice(5)} 至 ${r.to.slice(5)}` }))}
          />
          {!report && (
            <>
              <DatePicker.RangePicker value={range} presets={PRESETS} allowClear={false} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} disabledDate={(d) => d.isAfter(dayjs(), 'day')} />
              <Select allowClear placeholder="全部平台" style={{ width: 120 }} value={platform} onChange={(v) => { setPlatform(v); setAccountId(undefined); }} options={Object.entries(PLATFORM_LABEL).map(([value, label]) => ({ value, label }))} />
              <Select allowClear placeholder="全部账号" style={{ width: 160 }} value={accountId} onChange={setAccountId} options={accounts.filter((a) => !platform || a.platform === platform).map((a) => ({ value: a.id, label: a.name }))} />
            </>
          )}
          {report && <Button onClick={() => setParams({})}>回到实时看板</Button>}
        </Space>
      </Card>

      {!data ? <Card loading={loading}><Empty /></Card> : (
        <>
          <Row gutter={[12, 12]}>
            {kpis.map(([label, value, cur, prev, hint]) => (
              <Col key={label} xs={12} sm={8} xl={{ flex: '1 1 0' }}>
                <Card size="small" loading={loading}>
                  <Statistic title={label} value={value} />
                  <Space size={8} wrap><Delta cur={cur} prev={prev} />{hint && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}</Space>
                </Card>
              </Col>
            ))}
          </Row>

          {report?.insight && <InsightCard insight={report.insight} />}

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              <Card size="small" title="每日私信咨询" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>柱：咨询人次（同一客户同一天算 1 次）· 点：当天有发布</Typography.Text>}>
                <DailyChart daily={data.service.daily} />
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card size="small" title="转化漏斗" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>条长按平方根缩放 · 右侧为较上一步的转化率</Typography.Text>}>
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  {data.funnel.map((f) => <Funnel key={f.audience} f={f} />)}
                </Space>
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5} style={{ margin: 0 }}>内容</Typography.Title>
          <Card size="small" title="作品排行" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按带来的咨询数，其次互动率；阅读等数据取回填的累计值</Typography.Text>}>
            <Table<Post>
              rowKey="id"
              size="small"
              pagination={false}
              scroll={{ x: true }}
              dataSource={data.content.top}
              locale={{ emptyText: <Empty description="这段时间没有发布作品" /> }}
              columns={[
                { title: '作品', key: 'title', render: (_, x) => <Space direction="vertical" size={0}>{x.postUrl ? <a href={x.postUrl} target="_blank" rel="noreferrer">{x.title}</a> : x.title}<Typography.Text type="secondary" style={{ fontSize: 12 }}>{dayjs(x.publishedAt).format('MM-DD')} · {x.account} · {x.category}</Typography.Text></Space> },
                { title: '客群', dataIndex: 'audience', render: (a: Aud) => <Tag color={a === 'C' ? 'magenta' : 'blue'}>{a} 端</Tag> },
                { title: '阅读', key: 'reads', render: (_, x) => x.filled ? num(x.reads) : <Typography.Text type="warning">未回填</Typography.Text> },
                { title: '互动率', dataIndex: 'rate', render: pctText },
                { title: '咨询', dataIndex: 'consults' },
                { title: '线索', dataIndex: 'leads' },
              ]}
            />
          </Card>
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              <Card size="small" title="选题类别表现">
                <Table<Group> rowKey="name" size="small" pagination={false} scroll={{ x: true }} dataSource={data.content.byCategory} columns={groupColumns('类别')} locale={{ emptyText: '暂无' }} />
              </Card>
            </Col>
            <Col xs={24} lg={10}>
              <Card size="small" title="平台与账号">
                <Table<Group> rowKey="name" size="small" pagination={false} scroll={{ x: true }} dataSource={[...data.content.byPlatform, ...(data.content.byAccount.length > 1 ? data.content.byAccount : [])]} columns={groupColumns('平台 / 账号')} locale={{ emptyText: '暂无' }} />
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5} style={{ margin: 0 }}>客服</Typography.Title>
          <Row gutter={[12, 12]}>
            {[
              ['会话', String(data.service.conversations), ''],
              ['AI 回复', `${data.service.aiReplies} 条`, `全程 AI 接待 ${data.service.aiOnly} 个会话`],
              ['转人工率', pctText(data.service.handoffRate), `${data.service.handoffs} 个会话`],
              ['人工首响', data.service.firstResponse == null ? '—' : `${data.service.firstResponse} 分钟`, data.service.firstResponseCount ? `${data.service.firstResponseCount} 次，按工作时间计` : '没有人工接待'],
            ].map(([label, value, hint]) => (
              <Col key={label} xs={12} md={6}>
                <Card size="small"><Statistic title={label} value={value} /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint || ' '}</Typography.Text></Card>
              </Col>
            ))}
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Card size="small" title="高频问题 Top 10" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按 AI 回复命中的问答</Typography.Text>}>
                <BarList rows={data.service.topQuestions.map((q) => ({ name: q.question, count: q.count }))} empty="还没有命中知识库问答的回复" />
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card size="small" title="转人工原因">
                <BarList rows={data.service.reasons.map((r) => ({ name: r.reason, count: r.count }))} empty="没有转人工" />
                {data.service.byAgent.length > 0 && (
                  <List size="small" style={{ marginTop: 12 }} header={<Typography.Text type="secondary">客服首响</Typography.Text>} dataSource={data.service.byAgent} renderItem={(a) => <List.Item>{a.name}<span>{a.count} 次 · 平均 {a.avg ?? '—'} 分钟</span></List.Item>} />
                )}
              </Card>
            </Col>
          </Row>

          <Typography.Title level={5} style={{ margin: 0 }}>客资</Typography.Title>
          <Row gutter={[16, 16]}>
            {(['C', 'B'] as const).map((a) => {
              const l = data.leads[a];
              const intent = [['high', '高意向'], ['medium', '中意向'], ['low', '低意向'], ['unknown', '未判断']].map(([key, name]) => ({ name, count: l.intent[key] ?? 0 })).filter((x) => x.count);
              return (
                <Col key={a} xs={24} lg={12}>
                  <Card size="small" title={<Space><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: SERIES[a] }} />{a} 端客资</Space>}>
                    <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
                      <Col span={6}><Statistic title="新增线索" value={l.new} /></Col>
                      <Col span={6}><Statistic title="加微率" value={pctText(l.wecomRate)} /></Col>
                      <Col span={6}><Statistic title="成交率" value={pctText(l.wonRate)} /></Col>
                      <Col span={6}><Statistic title="成交金额" value={yuan(l.dealCents)} /></Col>
                    </Row>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>加微率 = 已加微 ÷ 新增线索；成交率 = 已成交 ÷ 已加微。成交金额按下单时间统计，本期 {l.orders} 单{l.repeat ? `，其中复购 ${l.repeat} 单` : ''}。</Typography.Paragraph>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <div><Typography.Text type="secondary">来源渠道</Typography.Text><BarList rows={l.sources} color={SERIES[a]} /></div>
                      <div><Typography.Text type="secondary">来源选题类别</Typography.Text><BarList rows={l.categories} color={SERIES[a]} /></div>
                      <div><Typography.Text type="secondary">意向分布</Typography.Text><BarList rows={intent} color={SERIES[a]} /></div>
                      {a === 'C'
                        ? <div><Typography.Text type="secondary">购买场景</Typography.Text><BarList rows={l.scene} color={SERIES[a]} /></div>
                        : (
                          <>
                            <div><Typography.Text type="secondary">渠道类型</Typography.Text><BarList rows={l.channel} color={SERIES[a]} /></div>
                            <div><Typography.Text type="secondary">地区</Typography.Text><BarList rows={l.city} color={SERIES[a]} /></div>
                          </>
                        )}
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
          {!report && <Alert className="no-print" type="info" showIcon message="每周一 9:00 自动生成上周周报、每月 1 日生成上月月报，附 AI 解读并推送企业微信。看板数字随数据实时更新，报告快照保留生成当时的数字。" />}
        </>
      )}
    </Space>
  );
}
