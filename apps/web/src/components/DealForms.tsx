import { App, DatePicker, Form, Input, InputNumber, Modal, Select, Typography } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/** 金额（分）显示成 ¥1,234.5 */
export const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

export const TOOL_LABEL: Record<string, string> = { ktt: '快团团', jielong: '群接龙', huacheng: '花城农夫', other: '其他工具', manual: '人工录入' };
export const MATCH_LABEL: Record<string, string> = { phone: '手机号', receiver_address: '收货人+地址', manual: '人工关联' };

interface LeadOption { id: string; audience: string; nickname: string | null; name: string | null; phone: string | null; status: string; canEdit: boolean }

/** 搜线索（昵称、姓名、微信或完整手机号），选一条。 */
export function LeadPicker({ value, onChange, audience }: { value?: string; onChange?: (id: string) => void; audience?: string }) {
  const [options, setOptions] = useState<LeadOption[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const search = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      const qs = new URLSearchParams({ q });
      if (audience) qs.set('audience', audience);
      const r = await api<{ items: LeadOption[] }>(`/leads?${qs}`).catch(() => ({ items: [] }));
      setOptions(r.items.filter((l) => l.canEdit));
      setLoading(false);
    }, 300);
  };
  useEffect(() => {
    search('');
    return () => clearTimeout(timer.current);
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Select
      showSearch
      value={value}
      onChange={onChange}
      filterOption={false}
      onSearch={search}
      loading={loading}
      placeholder="搜昵称、姓名、微信或完整手机号"
      notFoundContent={loading ? '查找中…' : '没有找到你能编辑的线索'}
      options={options.map((l) => ({
        value: l.id,
        label: `${l.nickname ?? l.name ?? '客户'}${l.name && l.nickname ? `（${l.name}）` : ''} · ${l.audience} 端${l.phone ? ` · ${l.phone}` : ''}`,
      }))}
    />
  );
}

interface DealValues { leadId: string; amount: number; quote?: number; contractNo?: string; product?: string; quantity?: number; orderedAt: dayjs.Dayjs; note?: string }

/** M11-3 人工录入成交：B 端大单、线下成交。不传 leadId 时先选线索。 */
export function ManualDealModal<T>({ leadId, onClose, onDone }: { leadId?: string; onClose: () => void; onDone: (r: T) => void }) {
  const [form] = Form.useForm<DealValues>();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const r = await api<T>('/orders/manual', { method: 'POST', body: { ...v, leadId: leadId ?? v.leadId, orderedAt: v.orderedAt.startOf('day').toISOString() } });
      message.success('已录入成交，线索标为已成交');
      onDone(r);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="录入成交" open onOk={save} okText="保存" confirmLoading={saving} onCancel={onClose} destroyOnHidden>
      <Typography.Paragraph type="secondary">B 端大单走人工谈单，团购工具里没有订单；线下成交也在这里记。成交金额会计入线索和周报。</Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ orderedAt: dayjs() }}>
        {!leadId && <Form.Item label="线索" name="leadId" rules={[{ required: true, message: '请选择线索' }]}><LeadPicker /></Form.Item>}
        <Form.Item label="成交金额" name="amount" rules={[{ required: true, message: '请填写成交金额' }]}><InputNumber min={0.01} precision={2} prefix="¥" style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="报价" name="quote" extra="B 端谈单时的报价，可不填"><InputNumber min={0.01} precision={2} prefix="¥" style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="合同编号" name="contractNo"><Input maxLength={60} /></Form.Item>
        <Form.Item label="商品与规格" name="product"><Input maxLength={200} placeholder="如 金傲芬 2 吨，分 4 批发货" /></Form.Item>
        <Form.Item label="数量" name="quantity"><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="成交日期" name="orderedAt" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="备注" name="note"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}
