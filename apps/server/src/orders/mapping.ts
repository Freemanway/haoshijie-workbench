/**
 * 团购工具订单表的字段映射（任务 M11-1）。
 * 快团团、群接龙、花城农夫的导出列名按常见写法预置，还没拿真实样表核对；
 * 识别不准的列导入时手动改一次，会按工具记住，下次直接用。
 */

export const TOOLS = { ktt: '快团团', jielong: '群接龙', huacheng: '花城农夫', other: '其他工具' } as const;
export type ImportTool = keyof typeof TOOLS;
export const TOOL_NAMES: Record<string, string> = { ...TOOLS, manual: '人工录入' };

export const ORDER_FIELDS = {
  externalNo: { label: '订单号', required: false, aliases: ['订单号', '订单编号', '跟团号', '接龙号', '订单ID', '订单id', '单号'] },
  orderedAt: { label: '下单时间', required: true, aliases: ['下单时间', '支付时间', '付款时间', '跟团时间', '接龙时间', '创建时间', '订单时间', '时间'] },
  amount: { label: '实付金额', required: true, aliases: ['实付金额', '实收金额', '实付款', '支付金额', '付款金额', '订单金额', '应付金额', '订单总额', '总金额', '商品总价', '金额'] },
  buyerNick: { label: '下单人', required: false, aliases: ['下单人', '下单人昵称', '团员昵称', '微信昵称', '用户昵称', '昵称', '团员', '买家'] },
  receiver: { label: '收货人', required: false, aliases: ['收货人', '收件人', '收货人姓名', '收件人姓名', '联系人', '姓名'] },
  phone: { label: '收货电话', required: false, aliases: ['收货人手机', '收货人电话', '收货电话', '收件人电话', '联系电话', '手机号码', '手机号', '手机', '电话', '联系方式'] },
  province: { label: '省', required: false, aliases: ['省份', '收货省份', '省'] },
  city: { label: '市', required: false, aliases: ['城市', '收货城市', '市'] },
  district: { label: '区县', required: false, aliases: ['区县', '收货区县', '区/县', '区'] },
  address: { label: '详细地址', required: false, aliases: ['详细地址', '收货地址', '收件地址', '完整地址', '地址'] },
  product: { label: '商品', required: false, aliases: ['商品名称', '商品名', '商品', '商品规格', '规格', '团购名称', '活动名称'] },
  quantity: { label: '数量', required: false, aliases: ['购买数量', '商品数量', '数量', '件数', '份数'] },
  status: { label: '订单状态', required: false, aliases: ['订单状态', '退款状态', '售后状态', '支付状态', '状态'] },
  note: { label: '备注', required: false, aliases: ['买家备注', '团员备注', '订单备注', '备注'] },
} as const;
export type OrderField = keyof typeof ORDER_FIELDS;
export type Mapping = Partial<Record<OrderField, string>>;
export const FIELD_KEYS = Object.keys(ORDER_FIELDS) as OrderField[];

const norm = (h: string) => h.replace(/[\s:：*（）()]/g, '');

/** 表头在哪一行：前 10 行里认出列名最多的一行（有的工具导出时上面带标题行）。 */
export function findHeaderRow(rows: string[][]) {
  let best = 0;
  let bestScore = -1;
  rows.slice(0, 10).forEach((r, i) => {
    const score = r.filter((h) => FIELD_KEYS.some((f) => (ORDER_FIELDS[f].aliases as readonly string[]).includes(norm(h)))).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** 按列名猜映射：先找完全一样的列名，再找包含的；一列只用一次。保存过的映射优先。 */
export function guessMapping(headers: string[], saved?: Mapping): Mapping {
  const used = new Set<string>();
  const m: Mapping = {};
  for (const f of FIELD_KEYS) {
    const s = saved?.[f];
    if (s && headers.includes(s)) {
      m[f] = s;
      used.add(s);
    }
  }
  for (const pass of ['exact', 'contains'] as const) {
    for (const f of FIELD_KEYS) {
      if (m[f]) continue;
      for (const alias of ORDER_FIELDS[f].aliases) {
        // 单字的“省 / 市 / 区”只认完全一样的列名
        if (pass === 'contains' && alias.length < 2) continue;
        const h = headers.find((x) => !used.has(x) && (pass === 'exact' ? norm(x) === alias : norm(x).includes(alias)));
        if (h) {
          m[f] = h;
          used.add(h);
          break;
        }
      }
    }
  }
  return m;
}

/** 金额：去掉 ¥、元、千分位，转成分。 */
export function parseAmount(s: string | undefined): number | null {
  const t = (s ?? '').replace(/[¥￥,，元\s]/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** 下单时间：常见的 2026-10-14 12:30、2026/10/14、2026年10月14日，或 Excel 日期序列号；没写时区按北京时间。 */
export function parseTime(s: string | undefined): Date | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const serial = Number(t);
    // Excel 序列号以 1899-12-30 为 0，单元格里的时间是北京时间
    return new Date(Math.round((serial - 25569) * 86400_000) - 8 * 3600_000);
  }
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[\sT]+(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2}))?)?/.exec(t);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +sec));
  return Number.isNaN(date.getTime()) ? null : date;
}

export const isCancelled = (status: string | undefined) => !!status && /已退款|退款成功|全额退款|已取消|取消订单|订单取消|交易关闭|已关闭|^取消$/.test(status) && !/部分/.test(status);

export function parseQuantity(s: string | undefined) {
  const n = Number((s ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
