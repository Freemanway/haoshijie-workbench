import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { addressKey, maskPhone, parseAddress } from '@hsj/shared';
import { Audience, Lead, Order, Prisma, Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth.decorators';
import { decrypt, encrypt, hashAddress, hashPhone, normalizePhone } from '../common/pii';
import { LeadsService, maskName } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { FIELD_KEYS, findHeaderRow, guessMapping, isCancelled, Mapping, ORDER_FIELDS, OrderField, parseAmount, parseQuantity, parseTime, TOOL_NAMES, TOOLS } from './mapping';
import { readSheet, SheetError } from './sheet';

export const FileInput = z.object({
  tool: z.enum(Object.keys(TOOLS) as [keyof typeof TOOLS, ...(keyof typeof TOOLS)[]]),
  fileName: z.string().trim().min(1).max(200),
  /** 文件内容 base64 */
  data: z.string().min(1).max(14_000_000, '文件太大，一次最多 10MB'),
});
export type FileInput = z.infer<typeof FileInput>;
export const CommitInput = FileInput.extend({ mapping: z.record(z.string(), z.string()) });
export type CommitInput = z.infer<typeof CommitInput>;

export const ManualDeal = z.object({
  leadId: z.string().min(1),
  amount: z.number().positive('请填写成交金额').max(100_000_000),
  quote: z.number().positive().max(100_000_000).nullish(),
  contractNo: z.string().trim().max(60).nullish(),
  product: z.string().trim().max(200).nullish(),
  quantity: z.number().int().positive().max(1_000_000).nullish(),
  orderedAt: z.coerce.date(),
  note: z.string().trim().max(500).nullish(),
});
export type ManualDeal = z.infer<typeof ManualDeal>;

const MAX_ROWS = 5000;
const MAPPING_KEY = (tool: string) => `orders.mapping.${tool}`;
const orderInclude = { lead: { select: { id: true, nickname: true, name: true, audience: true, status: true, ownerId: true } } } satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

interface Parsed {
  row: number;
  externalNo: string;
  amountCents: number;
  orderedAt: Date;
  buyerNick: string | null;
  receiver: string | null;
  phone: string | null;
  address: string | null;
  province: string | null;
  product: string | null;
  quantity: number | null;
  rawStatus: string | null;
  note: string | null;
}

/** 小红书笔记链接里的笔记 ID（24 位十六进制）；回填的链接常带不同的分享参数，按 ID 认作品。 */
const postKey = (url: string) => /[0-9a-f]{24}/i.exec(url)?.[0] ?? url.split('?')[0];

/**
 * M11 成交导入：团购工具订单表导入、按手机号或收货人 + 地址匹配线索、归因到来源平台和作品、复购标记；
 * B 端大单和线下成交人工录入。成交金额回写线索（LeadsService.refreshDeal）。
 */
@Injectable()
export class OrdersService implements OnApplicationBootstrap {
  private readonly log = new Logger('Orders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.leads.backfillAddressHashes();
    } catch (e) {
      this.log.warn(`补地址匹配哈希失败：${(e as Error).message}`);
    }
  }

  fields() {
    return { tools: TOOLS, fields: FIELD_KEYS.map((k) => ({ key: k, label: ORDER_FIELDS[k].label, required: ORDER_FIELDS[k].required })) };
  }

  // ---------- 权限 ----------

  private scope(me: AuthUser): Audience[] | null {
    if (me.roles.includes(Role.ADMIN) || me.roles.includes(Role.VIEWER)) return null;
    const a: Audience[] = [];
    if (me.roles.includes(Role.CS)) a.push(Audience.C);
    if (me.roles.includes(Role.BIZ)) a.push(Audience.B);
    return a;
  }

  private async loadOrder(me: AuthUser, id: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: orderInclude });
    const s = this.scope(me);
    if (!o || (s && !s.includes(o.audience) && o.lead?.ownerId !== me.id)) throw new NotFoundException('订单不存在');
    return o;
  }

  /** 能看订单明文、能关联：管理员；客服管 C 端，招商管 B 端。管理层只读脱敏。 */
  private canHandle(me: AuthUser, o: Pick<Order, 'audience'>) {
    if (me.roles.includes(Role.ADMIN)) return true;
    return o.audience === Audience.B ? me.roles.includes(Role.BIZ) : me.roles.includes(Role.CS);
  }

  // ---------- 导入 ----------

  private async rows(f: FileInput) {
    const buf = Buffer.from(f.data, 'base64');
    if (buf.length > 10 * 1024 * 1024) throw new BadRequestException('文件太大，一次最多 10MB');
    try {
      const rows = await readSheet(f.fileName, buf);
      if (rows.length < 2) throw new BadRequestException('表格里没有订单');
      const h = findHeaderRow(rows);
      const headers = rows[h].map((x, i) => x || `第 ${i + 1} 列`);
      return { headers, data: rows.slice(h + 1), headerRow: h };
    } catch (e) {
      if (e instanceof SheetError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private async savedMapping(tool: string) {
    const row = await this.prisma.setting.findUnique({ where: { key: MAPPING_KEY(tool) } });
    return (row?.value ?? undefined) as Mapping | undefined;
  }

  /** 第一步：读表头、猜字段映射、给前 5 行预览。 */
  async preview(f: FileInput) {
    const { headers, data } = await this.rows(f);
    const mapping = guessMapping(headers, await this.savedMapping(f.tool));
    return { headers, mapping, sample: data.slice(0, 5), total: data.length, ...this.fields() };
  }

  private parse(headers: string[], data: string[][], mapping: Mapping, headerRow: number) {
    const idx = Object.fromEntries(FIELD_KEYS.map((k) => [k, mapping[k] ? headers.indexOf(mapping[k]!) : -1])) as Record<OrderField, number>;
    const errors: { row: number; message: string }[] = [];
    const byNo = new Map<string, Parsed[]>();
    data.forEach((r, i) => {
      const row = headerRow + i + 2; // Excel 里的行号
      const get = (k: OrderField) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '') || null;
      const amountCents = parseAmount(get('amount') ?? undefined);
      const orderedAt = parseTime(get('orderedAt') ?? undefined);
      if (amountCents == null) return errors.push({ row, message: `金额“${get('amount') ?? ''}”认不出` });
      if (!orderedAt) return errors.push({ row, message: `下单时间“${get('orderedAt') ?? ''}”认不出` });
      const detail = get('address') ?? '';
      const parts = [...new Set([get('province'), get('city'), get('district')])].filter((p): p is string => !!p && !detail.includes(p));
      const address = [...parts, detail].join('') || null;
      const p: Parsed = {
        row, amountCents, orderedAt, address,
        externalNo: get('externalNo') ?? '',
        buyerNick: get('buyerNick'),
        receiver: get('receiver'),
        phone: normalizePhone(get('phone')),
        province: get('province') ?? (address ? parseAddress(address).province || null : null),
        product: get('product'),
        quantity: parseQuantity(get('quantity') ?? undefined),
        rawStatus: get('status'),
        note: get('note'),
      };
      if (!p.externalNo) {
        // 没有订单号列：用行内容生成，同一张表再导一次也认得出
        p.externalNo = `h:${createHash('sha1').update([p.orderedAt.toISOString(), p.phone, p.receiver, p.amountCents, p.product, p.buyerNick].join('|')).digest('hex').slice(0, 20)}`;
      }
      byNo.set(p.externalNo, [...(byNo.get(p.externalNo) ?? []), p]);
    });
    // 一单多个商品时工具会导出多行：商品拼起来、数量相加；金额每行都一样就是订单金额，否则按商品行相加
    const orders = [...byNo.values()].map((ps) => {
      if (ps.length === 1) return ps[0];
      const sameAmount = ps.every((x) => x.amountCents === ps[0].amountCents);
      return {
        ...ps[0],
        amountCents: sameAmount ? ps[0].amountCents : ps.reduce((n, x) => n + x.amountCents, 0),
        product: [...new Set(ps.map((x) => x.product).filter(Boolean))].join('、') || null,
        quantity: ps.every((x) => x.quantity == null) ? null : ps.reduce((n, x) => n + (x.quantity ?? 0), 0),
        rawStatus: ps.find((x) => x.rawStatus)?.rawStatus ?? null,
      };
    });
    return { orders, errors };
  }

  /** 第二步：按确认的映射导入，去重、匹配线索、标复购，记住这次的映射。 */
  async commit(me: AuthUser, f: CommitInput) {
    const { headers, data, headerRow } = await this.rows(f);
    const mapping = Object.fromEntries(Object.entries(f.mapping).filter(([k, v]) => (FIELD_KEYS as string[]).includes(k) && v && headers.includes(v))) as Mapping;
    const missing = FIELD_KEYS.filter((k) => ORDER_FIELDS[k].required && !mapping[k]);
    if (missing.length) throw new BadRequestException(`请指定“${missing.map((k) => ORDER_FIELDS[k].label).join('、')}”对应哪一列`);
    if (!mapping.phone && !(mapping.receiver && mapping.address)) throw new BadRequestException('至少要有“收货电话”，或者“收货人”加“详细地址”，否则没法匹配线索');
    if (data.length > MAX_ROWS) throw new BadRequestException(`一次最多导入 ${MAX_ROWS} 行，请分批导入`);

    const { orders, errors } = this.parse(headers, data, mapping, headerRow);
    const existing = new Set(
      (await this.prisma.order.findMany({ where: { tool: f.tool, externalNo: { in: orders.map((o) => o.externalNo) } }, select: { externalNo: true } })).map((o) => o.externalNo),
    );
    const batch = await this.prisma.orderImport.create({ data: { tool: f.tool, fileName: f.fileName, total: orders.length, created: 0, duplicated: 0, matched: 0, failed: errors.length, createdById: me.id } });
    const touched: string[] = [];
    let duplicated = 0;
    let matched = 0;
    for (const p of orders) {
      if (existing.has(p.externalNo)) {
        duplicated++;
        continue;
      }
      const key = addressKey(p.receiver, p.address);
      const o = await this.prisma.order.create({
        data: {
          tool: f.tool, externalNo: p.externalNo, importId: batch.id, amountCents: p.amountCents, orderedAt: p.orderedAt,
          buyerNick: p.buyerNick, product: p.product, quantity: p.quantity, rawStatus: p.rawStatus, note: p.note, province: p.province,
          cancelled: isCancelled(p.rawStatus ?? undefined),
          receiverEnc: p.receiver ? encrypt(p.receiver) : null,
          phoneEnc: p.phone ? encrypt(p.phone) : null,
          addressEnc: p.address ? encrypt(p.address) : null,
          phoneHash: p.phone ? hashPhone(p.phone) : null,
          receiverHash: key ? hashAddress(key) : null,
        },
      });
      touched.push(o.id);
      const hit = await this.findLead(o);
      if (hit) {
        await this.link(o.id, hit.lead, hit.by);
        matched++;
      }
    }
    await this.afterChange(touched);
    await this.prisma.setting.upsert({ where: { key: MAPPING_KEY(f.tool) }, create: { key: MAPPING_KEY(f.tool), value: mapping }, update: { value: mapping } });
    const result = await this.prisma.orderImport.update({
      where: { id: batch.id },
      data: { created: touched.length, duplicated, matched, errors: errors.slice(0, 200) },
    });
    await this.audit.log(me.id, 'order.import', batch.id, { tool: f.tool, fileName: f.fileName, created: touched.length, duplicated, matched, failed: errors.length });
    const unmatched = await this.prisma.order.count({ where: { importId: batch.id, leadId: null, cancelled: false } });
    return { ...result, unmatched };
  }

  imports() {
    return this.prisma.orderImport.findMany({ orderBy: { createdAt: 'desc' }, take: 30 });
  }

  /** 导错了（比如映射选错列）：整批删掉，关联的线索重算成交。 */
  async removeImport(me: AuthUser, id: string) {
    const batch = await this.prisma.orderImport.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException('导入记录不存在');
    const orders = await this.prisma.order.findMany({ where: { importId: id }, select: { id: true, leadId: true, phoneHash: true, receiverHash: true } });
    await this.prisma.$transaction([this.prisma.order.deleteMany({ where: { importId: id } }), this.prisma.orderImport.delete({ where: { id } })]);
    await this.recomputeRepeats(orders);
    for (const leadId of new Set(orders.map((o) => o.leadId).filter((x): x is string => !!x))) await this.leads.refreshDeal(leadId);
    await this.audit.log(me.id, 'order.import.delete', id, { count: orders.length });
    return { removed: orders.length };
  }

  // ---------- 匹配与归因 ----------

  /** 先认手机号（线索手机号、线索地址的收件电话），再认收货人 + 地址；同一客户以前的订单人工关联过的，跟着走。 */
  private async findLead(o: Pick<Order, 'id' | 'phoneHash' | 'receiverHash'>): Promise<{ lead: Lead; by: string } | null> {
    if (o.phoneHash) {
      const lead = (await this.prisma.lead.findUnique({ where: { phoneHash: o.phoneHash } })) ?? (await this.prisma.address.findFirst({ where: { phoneHash: o.phoneHash }, orderBy: { createdAt: 'asc' }, include: { lead: true } }))?.lead;
      if (lead) return { lead, by: 'phone' };
    }
    if (o.receiverHash) {
      const a = await this.prisma.address.findFirst({ where: { matchHash: o.receiverHash }, orderBy: { createdAt: 'asc' }, include: { lead: true } });
      if (a) return { lead: a.lead, by: 'receiver_address' };
    }
    const prev = await this.prisma.order.findFirst({
      where: { id: { not: o.id }, leadId: { not: null }, OR: [...(o.phoneHash ? [{ phoneHash: o.phoneHash }] : []), ...(o.receiverHash ? [{ receiverHash: o.receiverHash }] : [])] },
      orderBy: { orderedAt: 'asc' },
      include: { lead: true },
    });
    if (prev?.lead && (o.phoneHash || o.receiverHash)) return { lead: prev.lead, by: prev.phoneHash && prev.phoneHash === o.phoneHash ? 'phone' : 'receiver_address' };
    return null;
  }

  /** 归因：线索的来源平台、账号和作品（没有就取最早一条带作品的来源），作品再对到排期里的选题。 */
  private async attribution(lead: Lead) {
    let { sourcePlatform: platform, sourceAccount: account, sourcePostUrl: postUrl } = lead;
    if (!postUrl || !platform) {
      const s = await this.prisma.leadSource.findFirst({ where: { leadId: lead.id, ...(postUrl ? { platform: { not: null } } : { postUrl: { not: null } }) }, orderBy: { createdAt: 'asc' } });
      postUrl ??= s?.postUrl ?? null;
      platform ??= s?.platform ?? null;
      account ??= s?.accountName ?? null;
    }
    let topicId = lead.topicId;
    if (!topicId && postUrl) {
      const item = await this.prisma.scheduleItem.findFirst({ where: { postUrl: { contains: postKey(postUrl) } }, include: { draft: { select: { topicId: true } } } });
      topicId = item?.draft.topicId ?? null;
    }
    return { attrPlatform: platform, attrAccount: account, attrPostUrl: postUrl, attrTopicId: topicId };
  }

  private async link(orderId: string, lead: Lead, by: string) {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { leadId: lead.id, matchedBy: by, matchedAt: new Date(), audience: lead.audience, ...(await this.attribution(lead)) },
    });
  }

  /**
   * 复购：同一客户（关联了线索按线索，否则按手机号、再按收货人 + 地址）按下单时间排，第二单起标复购。
   * 退款取消的单不算。
   */
  private async recomputeRepeats(seed: Pick<Order, 'leadId' | 'phoneHash' | 'receiverHash'>[]) {
    const leadIds = [...new Set(seed.map((o) => o.leadId).filter((x): x is string => !!x))];
    const phones = [...new Set(seed.map((o) => o.phoneHash).filter((x): x is string => !!x))];
    const addrs = [...new Set(seed.map((o) => o.receiverHash).filter((x): x is string => !!x))];
    if (!leadIds.length && !phones.length && !addrs.length) return;
    const all = await this.prisma.order.findMany({
      where: { OR: [{ leadId: { in: leadIds } }, { phoneHash: { in: phones } }, { receiverHash: { in: addrs } }] },
      select: { id: true, leadId: true, phoneHash: true, receiverHash: true, cancelled: true, isRepeat: true, orderedAt: true },
      orderBy: [{ orderedAt: 'asc' }, { id: 'asc' }],
    });
    const seen = new Set<string>();
    const on: string[] = [];
    const off: string[] = [];
    for (const o of all) {
      const who = o.leadId ?? o.phoneHash ?? o.receiverHash ?? o.id;
      const repeat = !o.cancelled && seen.has(who);
      if (!o.cancelled) seen.add(who);
      if (repeat !== o.isRepeat) (repeat ? on : off).push(o.id);
    }
    if (on.length) await this.prisma.order.updateMany({ where: { id: { in: on } }, data: { isRepeat: true } });
    if (off.length) await this.prisma.order.updateMany({ where: { id: { in: off } }, data: { isRepeat: false } });
  }

  private async afterChange(orderIds: string[], extraLeads: (string | null)[] = []) {
    const orders = await this.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { leadId: true, phoneHash: true, receiverHash: true } });
    await this.recomputeRepeats(orders);
    const leadIds = new Set([...orders.map((o) => o.leadId), ...extraLeads].filter((x): x is string => !!x));
    for (const id of leadIds) await this.leads.refreshDeal(id);
  }

  // ---------- 人工关联与录入 ----------

  async linkManual(me: AuthUser, id: string, leadId: string) {
    const o = await this.loadOrder(me, id);
    if (!this.canHandle(me, o)) throw new ForbiddenException('不能处理这张订单');
    const lead = await this.leads.load(me, leadId, true);
    if (o.leadId === lead.id) return this.dto(o, me);
    const old = o.leadId;
    await this.link(o.id, lead, 'manual');
    // 同一手机号或同一收货人 + 地址的其他未匹配订单是同一个客户，一起关联
    const same = [...(o.phoneHash ? [{ phoneHash: o.phoneHash }] : []), ...(o.receiverHash ? [{ receiverHash: o.receiverHash }] : [])];
    const siblings = same.length ? await this.prisma.order.findMany({ where: { leadId: null, id: { not: o.id }, OR: same }, select: { id: true } }) : [];
    for (const s of siblings) await this.link(s.id, lead, 'manual');
    await this.afterChange([o.id, ...siblings.map((s) => s.id)], [old]);
    await this.audit.log(me.id, 'order.link', o.id, { leadId, from: old, siblings: siblings.length });
    return this.dto(await this.loadOrder(me, id), me);
  }

  async unlink(me: AuthUser, id: string) {
    const o = await this.loadOrder(me, id);
    if (!o.leadId) return this.dto(o, me);
    await this.leads.load(me, o.leadId, true);
    const old = o.leadId;
    await this.prisma.order.update({ where: { id }, data: { leadId: null, matchedBy: null, matchedAt: null, attrPlatform: null, attrAccount: null, attrPostUrl: null, attrTopicId: null } });
    await this.recomputeRepeats([{ leadId: old, phoneHash: o.phoneHash, receiverHash: o.receiverHash }]);
    await this.leads.refreshDeal(old);
    await this.audit.log(me.id, 'order.unlink', id, { leadId: old });
    return this.dto(await this.loadOrder(me, id), me);
  }

  /** M11-3 人工录入成交：B 端大单、线下成交，记报价、合同编号和成交金额。 */
  async createManual(me: AuthUser, b: ManualDeal) {
    const lead = await this.leads.load(me, b.leadId, true);
    const o = await this.prisma.order.create({
      data: {
        tool: 'manual', leadId: lead.id, audience: lead.audience, matchedBy: 'manual', matchedAt: new Date(), createdById: me.id,
        amountCents: Math.round(b.amount * 100), quoteCents: b.quote != null ? Math.round(b.quote * 100) : null,
        contractNo: b.contractNo || null, product: b.product || null, quantity: b.quantity ?? null, note: b.note || null, orderedAt: b.orderedAt,
        phoneHash: lead.phoneHash,
        ...(await this.attribution(lead)),
      },
    });
    await this.afterChange([o.id]);
    await this.audit.log(me.id, 'order.manual', o.id, { leadId: lead.id, amountCents: o.amountCents });
    return this.leads.detail(me, lead.id);
  }

  /** 只能删人工录入的成交；导入的订单撤销关联或整批删除。 */
  async removeManual(me: AuthUser, id: string) {
    const o = await this.loadOrder(me, id);
    if (o.tool !== 'manual') throw new BadRequestException('导入的订单不能单独删除，可以撤销关联，或在导入记录里整批删除');
    if (o.leadId) await this.leads.load(me, o.leadId, true);
    else if (!me.roles.includes(Role.ADMIN)) throw new ForbiddenException('只有管理员能删除');
    await this.prisma.order.delete({ where: { id } });
    await this.recomputeRepeats([o]);
    if (o.leadId) await this.leads.refreshDeal(o.leadId);
    await this.audit.log(me.id, 'order.manual.delete', id, { leadId: o.leadId });
    return { ok: true };
  }

  // ---------- 列表（脱敏） ----------

  private dto(o: OrderRow, me: AuthUser) {
    const dec = (s: string | null) => {
      if (!s) return null;
      try {
        return decrypt(s);
      } catch {
        return null;
      }
    };
    const receiver = dec(o.receiverEnc);
    const phone = dec(o.phoneEnc);
    const address = dec(o.addressEnc);
    const { receiverEnc: _r, phoneEnc: _p, addressEnc: _a, phoneHash: _ph, receiverHash: _rh, ...rest } = o;
    return {
      ...rest,
      toolName: TOOL_NAMES[o.tool] ?? o.tool,
      receiver: receiver ? maskName(receiver) : null,
      phone: phone ? maskPhone(phone) : null,
      address: address ? `${address.slice(0, 6)}****` : null,
      canHandle: this.canHandle(me, o),
    };
  }

  async list(me: AuthUser, q: { tool?: string; state?: string; importId?: string; q?: string; from?: string; to?: string; page?: string }) {
    const scope = this.scope(me);
    const where: Prisma.OrderWhereInput = {
      ...(scope ? { OR: [{ audience: { in: scope } }, { lead: { ownerId: me.id } }] } : {}),
      ...(q.tool ? { tool: q.tool } : {}),
      ...(q.importId ? { importId: q.importId } : {}),
      ...(q.from || q.to ? { orderedAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(new Date(q.to).getTime() + 86400_000) } : {}) } } : {}),
    };
    if (q.q?.trim()) {
      const kw = q.q.trim();
      const phone = normalizePhone(kw);
      where.AND = [{ OR: [{ externalNo: { contains: kw } }, { buyerNick: { contains: kw } }, { product: { contains: kw } }, ...(phone ? [{ phoneHash: hashPhone(phone) }] : [])] }];
    }
    const state: Record<string, Prisma.OrderWhereInput> = {
      matched: { leadId: { not: null } },
      unmatched: { leadId: null, cancelled: false },
      repeat: { isRepeat: true },
      cancelled: { cancelled: true },
    };
    const filtered = { ...where, ...(state[q.state ?? ''] ?? {}) };
    const page = Math.max(1, Number(q.page) || 1);
    const valid = { ...where, cancelled: false };
    const [items, total, sum, matched, unmatched, repeat] = await Promise.all([
      this.prisma.order.findMany({ where: filtered, include: orderInclude, orderBy: { orderedAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
      this.prisma.order.count({ where: filtered }),
      this.prisma.order.aggregate({ where: valid, _sum: { amountCents: true }, _count: true }),
      this.prisma.order.count({ where: { ...valid, leadId: { not: null } } }),
      this.prisma.order.count({ where: { ...valid, leadId: null } }),
      this.prisma.order.count({ where: { ...valid, isRepeat: true } }),
    ]);
    return {
      items: items.map((o) => this.dto(o, me)),
      total,
      summary: { orders: sum._count, amountCents: sum._sum.amountCents ?? 0, matched, unmatched, repeat },
    };
  }

  /** 看明文收货信息（人工关联时核对用），记日志。 */
  async reveal(me: AuthUser, id: string) {
    const o = await this.loadOrder(me, id);
    if (!this.canHandle(me, o)) throw new ForbiddenException('没有权限查看');
    await this.audit.log(me.id, 'order.reveal', id);
    return { receiver: o.receiverEnc ? decrypt(o.receiverEnc) : null, phone: o.phoneEnc ? decrypt(o.phoneEnc) : null, address: o.addressEnc ? decrypt(o.addressEnc) : null };
  }
}
