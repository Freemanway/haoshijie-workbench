import { App, Button, Card, Form, Input, InputNumber, Modal, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

type Key =
  | 'weeklyPosts' | 'minutesPerPost' | 'weeklyConsults' | 'firstResponseMin' | 'aiSolveRate'
  | 'weeklyLeadsC' | 'weeklyLeadsB' | 'wecomRateC' | 'wonRateC' | 'wonRateB' | 'riskMisses' | 'penalties';
type Figures = Partial<Record<Key, number | null>>;
export interface Baseline { period: string; note: string; baseline: Figures; target: Figures; recordedBy?: string; updatedAt?: string }

/** 看板里能算出“本期”的数字；人工耗时、漏拦和处罚次数系统不统计，只记基线和目标 */
export interface BaselineCurrent { days: number; posts: number; consults: number; firstResponse: number | null; conversations: number; aiOnly: number; leadsC: number; leadsB: number; wecomRateC: number | null; wonRateC: number | null; wonRateB: number | null }

/** PRD 11.2 建议跟踪的指标；lower 表示越低越好 */
const METRICS: { key: Key; label: string; unit: string; lower?: boolean; weekly?: boolean }[] = [
  { key: 'weeklyPosts', label: '每周发布量', unit: '篇', weekly: true },
  { key: 'minutesPerPost', label: '每篇人工耗时', unit: '分钟', lower: true },
  { key: 'weeklyConsults', label: '每周私信咨询', unit: '人次', weekly: true },
  { key: 'firstResponseMin', label: '人工首响时长', unit: '分钟', lower: true },
  { key: 'aiSolveRate', label: '自动回复解决率', unit: '%' },
  { key: 'weeklyLeadsC', label: '每周新增 C 端线索', unit: '条', weekly: true },
  { key: 'weeklyLeadsB', label: '每周新增 B 端线索', unit: '条', weekly: true },
  { key: 'wecomRateC', label: 'C 端加微率', unit: '%' },
  { key: 'wonRateC', label: 'C 端成交率', unit: '%' },
  { key: 'wonRateB', label: 'B 端成交率', unit: '%' },
  { key: 'riskMisses', label: '风控漏拦次数', unit: '次', lower: true },
  { key: 'penalties', label: '账号违规处罚次数', unit: '次', lower: true },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

function current(c: BaselineCurrent): Figures {
  const perWeek = (n: number) => round1((n * 7) / Math.max(1, c.days));
  return {
    weeklyPosts: perWeek(c.posts),
    weeklyConsults: perWeek(c.consults),
    firstResponseMin: c.firstResponse,
    aiSolveRate: c.conversations ? round1((c.aiOnly / c.conversations) * 100) : null,
    weeklyLeadsC: perWeek(c.leadsC),
    weeklyLeadsB: perWeek(c.leadsB),
    wecomRateC: c.wecomRateC,
    wonRateC: c.wonRateC,
    wonRateB: c.wonRateB,
  };
}

const show = (v: number | null | undefined, unit: string) => (v == null ? '—' : `${v.toLocaleString('zh-CN')} ${unit}`);

/** 上线前基线（PRD 11.2）：先记人工方式下的数字，再按基线定目标，看板上对比本期。 */
export function BaselineCard({ cur }: { cur: BaselineCurrent | null }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const [b, setB] = useState<Baseline | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    void api<Baseline | undefined>('/reports/baseline').then((r) => setB(r ?? null), () => undefined);
  }, []);

  const open = () => setEditing(true);
  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      setB(await api<Baseline>('/reports/baseline', { method: 'PUT', body: v }));
      setEditing(false);
      message.success('已保存基线和目标');
    } catch (e) {
      message.error((e as Error).message);
    }
    setSaving(false);
  };

  const now = cur ? current(cur) : {};
  const rows = METRICS.map((m) => {
    const target = b?.target[m.key];
    const value = now[m.key];
    const hit = target != null && value != null ? (m.lower ? value <= target : value >= target) : null;
    return { ...m, base: b?.baseline[m.key], target, value, hit };
  });

  return (
    <Card
      size="small"
      title="对比上线前基线"
      extra={can('ADMIN') && <Button size="small" className="no-print" onClick={open}>{b ? '修改基线和目标' : '录入基线'}</Button>}
    >
      {!b ? (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          上线前先记下人工方式下每周的发布量、咨询量、线索数等数字，再按基线定目标，这里会和本期对比。{can('ADMIN') ? '' : '由管理员录入。'}
        </Typography.Paragraph>
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            基线：{b.period || '未注明时间段'}{b.recordedBy ? `，${b.recordedBy} 录入` : ''}{b.updatedAt ? `于 ${dayjs(b.updatedAt).format('YYYY-MM-DD')}` : ''}。本期的“每周”数字按所选 {cur?.days ?? 7} 天折算到每周。{b.note && ` ${b.note}`}
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={rows}
            columns={[
              { title: '指标', dataIndex: 'label' },
              { title: '上线前基线', render: (_, r) => show(r.base, r.unit) },
              { title: '目标', render: (_, r) => show(r.target, r.unit) },
              {
                title: '本期',
                render: (_, r) => (
                  <Space size={6}>
                    {r.value === undefined ? <Typography.Text type="secondary">系统不统计</Typography.Text> : show(r.value, r.unit)}
                    {r.hit === true && <Tag color="success">已达目标</Tag>}
                    {r.hit === false && <Tag>未达目标</Tag>}
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}
      <Modal title="上线前基线与目标" open={editing} onOk={save} confirmLoading={saving} onCancel={() => setEditing(false)} width={640} destroyOnHidden>
        <Form form={form} layout="vertical" preserve={false} initialValues={b ?? { period: '', note: '', baseline: {}, target: {} }}>
          <Form.Item name="period" label="基线时间段" extra="比如“2026 年 9 月，人工方式”">
            <Input maxLength={60} />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px 120px', gap: '4px 12px', alignItems: 'center' }}>
            <Typography.Text type="secondary">指标</Typography.Text>
            <Typography.Text type="secondary">基线</Typography.Text>
            <Typography.Text type="secondary">目标</Typography.Text>
            {METRICS.map((m) => (
              <div key={m.key} style={{ display: 'contents' }}>
                <span>{m.label}（{m.unit}{m.weekly ? '/周' : ''}）</span>
                <Form.Item name={['baseline', m.key]} style={{ margin: 0 }}><InputNumber min={0} style={{ width: '100%' }} aria-label={`${m.label}基线`} /></Form.Item>
                <Form.Item name={['target', m.key]} style={{ margin: 0 }}><InputNumber min={0} style={{ width: '100%' }} aria-label={`${m.label}目标`} /></Form.Item>
              </div>
            ))}
          </div>
          <Form.Item name="note" label="备注" style={{ marginTop: 16 }}>
            <Input.TextArea rows={2} maxLength={500} placeholder="数字怎么来的，比如“发布量按 9 月小红书后台，咨询按客服手工登记”" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
