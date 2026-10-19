import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DEFAULT_NO_SHIP, maskPhone, parseAddress, ParsedAddress } from '@hsj/shared';
import { Audience, Lead, LeadStatus, Platform, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { AiService } from '../ai/ai.module';
import { leadExtract, leadScript } from '../ai/prompts';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../common/auth.decorators';
import { decrypt, encrypt, hashPhone, normalizePhone } from '../common/pii';
import { JobQueue } from '../drafts/job-queue';
import { PrismaService } from '../prisma/prisma.service';
import { NotifyService } from '../wecom/wecom.module';

export const LeadSettingsSchema = z.object({
  /** 不发鲜果的省份（简称，如 新疆、西藏） */
  noShip: z.array(z.string().trim().min(1)).max(40),
  /** 收集手机号、地址前告知的用途 */
  privacyNotice: z.string().trim().min(1).max(200),
  /** 新线索多少小时没人跟进就提醒负责人 */
  staleHours: z.number().int().min(1).max(168),
});
export type LeadSettings = z.infer<typeof LeadSettingsSchema>;
const SETTINGS_KEY = 'leads';
const RR_KEY = 'leads.rr';
const DEFAULT_SETTINGS: LeadSettings = {
  noShip: DEFAULT_NO_SHIP,
  privacyNotice: '你留的手机号和地址只用于发货和售后联系，我们会妥善保管～',
  staleHours: 24,
};

export const LeadPatch = z.object({
  audience: z.nativeEnum(Audience).optional(),
  intent: z.enum(['high', 'medium', 'low']).nullable().optional(),
  intentDetail: z.record(z.string(), z.string().nullable()).nullable().optional(),
  name: z.string().trim().max(50).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  wechat: z.string().trim().max(50).nullable().optional(),
  status: z.nativeEnum(LeadStatus).optional(),
  ownerId: z.string().nullable().optional(),
  nextFollowAt: z.coerce.date().nullable().optional(),
});
export type LeadPatch = z.infer<typeof LeadPatch>;

export const LeadCreate = LeadPatch.extend({ audience: z.nativeEnum(Audience), nickname: z.string().trim().max(100).nullish() });
export type LeadCreate = z.infer<typeof LeadCreate>;

export const AddressInput = z.object({
  name: z.string().trim().min(1, '请填写收件人').max(30),
  phone: z.string().trim().min(1, '请填写电话'),
  province: z.string().trim().min(1, '请填写省份'),
  city: z.string().trim().default(''),
  district: z.string().trim().default(''),
  detail: z.string().trim().min(2, '请填写详细地址').max(200),
  confirmed: z.boolean().default(false),
});
export type AddressInput = z.infer<typeof AddressInput>;

export interface SourceInput {
  kind: 'conversation' | 'wecom' | 'manual' | 'import';
  platform?: Platform | null;
  platformUserId?: string | null;
  accountName?: string | null;
  postUrl?: string | null;
  conversationId?: string | null;
  channelId?: string | null;
}

/** 消息里识别到的联系方式和地址，交给收件箱决定怎么回。 */
export interface MessageAction {
  reply?: { text: string; meta: Record<string, unknown> };
  handoff?: string;
  note?: string;
}

const PHONE_IN_TEXT = /(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/;
const WECHAT_IN_TEXT = /(?:微信|vx|wx|v信)[号:： ]*([A-Za-z][-_A-Za-z0-9]{5,19})/i;
const CONFIRM = /^(确认|确定|没问题|对的?|是的|正确|好的|ok|嗯+|无误)[!！。.~～\s]*$/i;
const STATUS_RANK: Record<LeadStatus, number> = { NEW: 0, ADDED_WECOM: 1, FOLLOWING: 2, WON: 3, LOST: -1 };
const STATUS_TEXT: Record<LeadStatus, string> = { NEW: '新线索', ADDED_WECOM: '已加微', FOLLOWING: '跟进中', WON: '已成交', LOST: '已流失' };
const AI_FIELDS = ['audience', 'intent', 'intentDetail', 'name', 'wechat'] as const;

export const maskName = (s: string) => (s.length <= 1 ? s : s.length === 2 ? `${s[0]}*` : `${s[0]}${'*'.repeat(s.length - 2)}${s.at(-1)}`);
export const maskDetail = (s: string) => (s.length <= 4 ? '****' : `${s.slice(0, 4)}****`);
const platformUserId = (externalUserId: string) => externalUserId.replace(/^comment:/, '');

const leadInclude = {
  owner: { select: { id: true, name: true } },
  _count: { select: { sources: true, addresses: true, followUps: true } },
} satisfies Prisma.LeadInclude;
type LeadRow = Prisma.LeadGetPayload<{ include: typeof leadInclude }>;

/**
 * M10 线索：有效咨询自动建档、同手机号或同平台 ID 合并、地址收集确认、分配与跟进提醒、隐私保护。
 * 私信会话（收件箱）和加企业微信（M9）都从这里建线索，分配规则和去重只有一份。
 */
@Injectable()
export class LeadsService {
  private readonly log = new Logger('Leads');
  private readonly queue = new JobQueue(1);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  idle() {
    return this.queue.idle();
  }

  async settings(): Promise<LeadSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = LeadSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async saveSettings(me: AuthUser, s: LeadSettings) {
    await this.prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: s }, update: { value: s } });
    await this.audit.log(me.id, 'lead.settings', SETTINGS_KEY, s);
    return s;
  }

  async parse(raw: string) {
    return parseAddress(raw, (await this.settings()).noShip);
  }

  // ---------- 权限 ----------

  /** 能看到哪些客群：管理员、管理层看全部；客服看 C 端，招商看 B 端。 */
  private scope(me: AuthUser): Audience[] | null {
    if (me.roles.includes(Role.ADMIN) || me.roles.includes(Role.VIEWER)) return null;
    const a: Audience[] = [];
    if (me.roles.includes(Role.CS)) a.push(Audience.C);
    if (me.roles.includes(Role.BIZ)) a.push(Audience.B);
    return a;
  }

  private canSee(me: AuthUser, l: Pick<Lead, 'audience' | 'ownerId'>) {
    const s = this.scope(me);
    return !s || s.includes(l.audience) || l.ownerId === me.id;
  }

  /** 能改、能看明文：管理员；招商管 B 端；客服管自己负责的（或还没分配的）C 端。管理层只读脱敏。 */
  canEdit(me: AuthUser, l: Pick<Lead, 'audience' | 'ownerId'>) {
    if (me.roles.includes(Role.ADMIN) || l.ownerId === me.id) return true;
    if (l.audience === Audience.B) return me.roles.includes(Role.BIZ);
    return me.roles.includes(Role.CS) && !l.ownerId;
  }

  private async load(me: AuthUser, id: string, edit = false) {
    const l = await this.prisma.lead.findUnique({ where: { id } });
    if (!l || !this.canSee(me, l)) throw new NotFoundException('线索不存在');
    if (edit && !this.canEdit(me, l)) throw new ForbiddenException('只能修改自己负责的线索');
    return l;
  }

  // ---------- 列表与详情（脱敏） ----------

  private phoneOf(l: { phoneEnc: string | null }) {
    if (!l.phoneEnc) return null;
    try {
      return decrypt(l.phoneEnc);
    } catch {
      return null;
    }
  }

  private dto(l: LeadRow, me: AuthUser) {
    const { phoneEnc: _e, phoneHash: _h, _count, ...rest } = l;
    const phone = this.phoneOf(l);
    return { ...rest, phone: phone ? maskPhone(phone) : null, counts: _count, canEdit: this.canEdit(me, l) };
  }

  async list(me: AuthUser, q: { audience?: string; status?: string; intent?: string; ownerId?: string; account?: string; mine?: string; q?: string; page?: string }) {
    const scope = this.scope(me);
    const audience = q.audience === 'C' || q.audience === 'B' ? (q.audience as Audience) : undefined;
    if (audience && scope && !scope.includes(audience)) return { items: [], total: 0, counts: {} };
    const where: Prisma.LeadWhereInput = {
      ...(audience ? { audience } : scope ? { OR: [{ audience: { in: scope } }, { ownerId: me.id }] } : {}),
      ...(q.intent ? { intent: q.intent } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId === 'none' ? null : q.ownerId } : {}),
      ...(q.mine === 'true' ? { ownerId: me.id } : {}),
      ...(q.account ? { sourceAccount: q.account } : {}),
    };
    if (q.q?.trim()) {
      const kw = q.q.trim();
      const phone = normalizePhone(kw);
      where.AND = [{ OR: [{ nickname: { contains: kw } }, { name: { contains: kw } }, { wechat: { contains: kw } }, ...(phone ? [{ phoneHash: hashPhone(phone) }] : [])] }];
    }
    const page = Math.max(1, Number(q.page) || 1);
    const statusWhere = q.status && q.status in LeadStatus ? { status: q.status as LeadStatus } : {};
    const [items, total, grouped] = await Promise.all([
      this.prisma.lead.findMany({ where: { ...where, ...statusWhere }, include: leadInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50 }),
      this.prisma.lead.count({ where: { ...where, ...statusWhere } }),
      this.prisma.lead.groupBy({ by: ['status'], where, _count: true }),
    ]);
    return { items: items.map((l) => this.dto(l, me)), total, counts: Object.fromEntries(grouped.map((g) => [g.status, g._count])) };
  }

  async detail(me: AuthUser, id: string) {
    await this.load(me, id);
    const l = await this.prisma.lead.findUniqueOrThrow({
      where: { id },
      include: {
        ...leadInclude,
        sources: { orderBy: { createdAt: 'asc' } },
        addresses: { orderBy: { createdAt: 'asc' } },
        followUps: { orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true } } } },
        conversation: { select: { id: true, status: true, summary: true, account: { select: { name: true } } } },
        wecomContacts: { select: { staffId: true, name: true, addedAt: true, removedAt: true, channel: { select: { name: true } } } },
      },
    });
    const { addresses, ...rest } = l;
    return {
      ...this.dto(rest as LeadRow, me),
      sources: l.sources,
      followUps: l.followUps,
      // 摘要里可能带着客户发的手机号
      conversation: l.conversation && { ...l.conversation, summary: l.conversation.summary?.replace(/1[3-9]\d{9}/g, (m) => maskPhone(m)) ?? null },
      wecomContacts: l.wecomContacts,
      addresses: addresses.map((a) => this.addressDto(a)),
    };
  }

  private addressDto(a: Prisma.AddressGetPayload<object>) {
    const name = decrypt(a.receiverEnc);
    return {
      id: a.id,
      name: maskName(name),
      phone: maskPhone(decrypt(a.phoneEnc)),
      province: a.province,
      city: a.city,
      district: a.district,
      detail: maskDetail(decrypt(a.detailEnc)),
      confirmed: a.confirmed,
      source: a.source,
      createdAt: a.createdAt,
    };
  }

  /** 查看明文：只给能编辑这条线索的人，并记日志。 */
  async reveal(me: AuthUser, id: string, addressId?: string) {
    const l = await this.load(me, id, true);
    await this.audit.log(me.id, 'lead.reveal', id, addressId ? { addressId } : { field: 'phone' });
    if (!addressId) return { phone: this.phoneOf(l) };
    const a = await this.prisma.address.findFirst({ where: { id: addressId, leadId: id } });
    if (!a) throw new NotFoundException('地址不存在');
    return { name: decrypt(a.receiverEnc), phone: decrypt(a.phoneEnc), province: a.province, city: a.city, district: a.district, detail: decrypt(a.detailEnc) };
  }

  // ---------- 建档、去重、合并 ----------

  /** 新建线索：按客群分配负责人（B 端招商、C 端客服，多人轮流），记录第一条来源，通知负责人。 */
  async create(data: Omit<Prisma.LeadUncheckedCreateInput, 'ownerId'> & { ownerId?: string | null }, source: SourceInput) {
    const ownerId = data.ownerId === undefined ? await this.nextOwner(data.audience) : data.ownerId;
    const lead = await this.prisma.lead.create({ data: { ...data, ownerId, sources: { create: source } } });
    if (ownerId) {
      const owner = await this.prisma.user.findUnique({ where: { id: ownerId } });
      if (owner) await this.notify.toUsers([owner.wecomId], `【新线索】${lead.audience === Audience.B ? 'B 端' : 'C 端'} · ${lead.nickname ?? lead.name ?? '客户'}（${source.accountName ?? '手动录入'}）已分配给你，请到工作台“线索库”跟进。`);
    }
    return lead;
  }

  private async nextOwner(audience: Audience) {
    const role = audience === Audience.B ? Role.BIZ : Role.CS;
    const users = await this.prisma.user.findMany({ where: { active: true, roles: { has: role } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!users.length) return null;
    const row = await this.prisma.setting.findUnique({ where: { key: RR_KEY } });
    const last = ((row?.value ?? {}) as Record<string, string>)[audience];
    const i = users.findIndex((u) => u.id === last);
    const next = users[(i + 1) % users.length].id;
    const value = { ...((row?.value as object) ?? {}), [audience]: next };
    await this.prisma.setting.upsert({ where: { key: RR_KEY }, create: { key: RR_KEY, value }, update: { value } });
    return next;
  }

  async addSource(leadId: string, s: SourceInput) {
    const dup = await this.prisma.leadSource.findFirst({
      where: { leadId, kind: s.kind, conversationId: s.conversationId ?? undefined, channelId: s.channelId ?? undefined },
    });
    // 同一会话、同一活码只记一次来源
    if (dup && (s.conversationId || s.channelId)) return dup;
    return this.prisma.leadSource.create({ data: { ...s, leadId } });
  }

  async leadForConversation(conversationId: string) {
    return (
      (await this.prisma.lead.findUnique({ where: { conversationId } })) ??
      (await this.prisma.leadSource.findFirst({ where: { conversationId }, include: { lead: true } }))?.lead ??
      null
    );
  }

  /** 私信会话对应的线索：没有就按同平台同用户 ID 找，再没有就新建。 */
  async ensureForConversation(conversationId: string) {
    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { account: true } });
    const uid = platformUserId(conv.externalUserId);
    const source: SourceInput = { kind: 'conversation', platform: conv.account.platform, platformUserId: uid, accountName: conv.account.name, postUrl: conv.sourcePostUrl, conversationId };
    let lead = await this.leadForConversation(conversationId);
    // 半自动贴入的“用户 ID”只是昵称，不能拿来认人
    if (!lead && !uid.startsWith('manual:')) {
      lead = (await this.prisma.leadSource.findFirst({ where: { platform: conv.account.platform, platformUserId: uid }, orderBy: { createdAt: 'asc' }, include: { lead: true } }))?.lead ?? null;
    }
    if (!lead) {
      lead = await this.create(
        {
          audience: conv.audience ?? conv.account.audience,
          conversationId,
          sourcePlatform: conv.account.platform,
          sourceAccount: conv.account.name,
          sourcePostUrl: conv.sourcePostUrl,
          nickname: conv.nickname,
          intent: conv.intent,
        },
        source,
      );
      this.queue.push(() => this.extract(lead!.id).then(() => undefined));
      return lead;
    }
    await this.addSource(lead.id, source);
    if (!lead.conversationId && !(await this.prisma.lead.findUnique({ where: { conversationId } }))) {
      lead = await this.prisma.lead.update({ where: { id: lead.id }, data: { conversationId } });
    }
    return lead;
  }

  /** 收件箱每轮 AI 应答后调用：有效咨询才建档，已有线索同步 AI 判断的客群和意向（人工改过的不覆盖）。 */
  async syncConversation(conversationId: string, valid: boolean) {
    const existing = await this.leadForConversation(conversationId);
    if (!existing && !valid) return null;
    const lead = existing ?? (await this.ensureForConversation(conversationId));
    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const data: Prisma.LeadUpdateInput = {};
    if (conv.audience && !lead.editedFields.includes('audience') && conv.audience !== lead.audience) data.audience = conv.audience;
    if (conv.intent && !lead.editedFields.includes('intent') && conv.intent !== lead.intent) data.intent = conv.intent;
    return Object.keys(data).length ? this.prisma.lead.update({ where: { id: lead.id }, data }) : lead;
  }

  /** 给线索补手机号；手机号已在别的线索上，就把这条并过去，返回最终的线索 ID。 */
  async setPhone(leadId: string, phone: string) {
    const phoneHash = hashPhone(phone);
    const other = await this.prisma.lead.findUnique({ where: { phoneHash } });
    if (other && other.id !== leadId) {
      await this.merge(other.id, leadId);
      return other.id;
    }
    if (!other) await this.prisma.lead.update({ where: { id: leadId }, data: { phoneHash, phoneEnc: encrypt(phone) } });
    return leadId;
  }

  async byPhone(phone: string) {
    return this.prisma.lead.findUnique({ where: { phoneHash: hashPhone(phone) } });
  }

  /** 合并：把 drop 的来源、地址、跟进、订单、企业微信客户都挪到 keep，空字段用 drop 的补上，再删掉 drop。 */
  async merge(keepId: string, dropId: string, me?: AuthUser) {
    if (keepId === dropId) return this.prisma.lead.findUniqueOrThrow({ where: { id: keepId } });
    const [keep, drop] = await Promise.all([this.prisma.lead.findUniqueOrThrow({ where: { id: keepId } }), this.prisma.lead.findUniqueOrThrow({ where: { id: dropId } })]);
    const fill = <K extends keyof Lead>(k: K) => (keep[k] == null && drop[k] != null ? { [k]: drop[k] } : {});
    const status = STATUS_RANK[drop.status] > STATUS_RANK[keep.status] ? drop.status : keep.status;
    const result = await this.prisma.$transaction(async (tx) => {
      const moveConv = !keep.conversationId && drop.conversationId ? drop.conversationId : null;
      for (const m of ['leadSource', 'address', 'followUp', 'order', 'wecomContact'] as const) {
        await (tx[m] as unknown as { updateMany: (a: object) => Promise<unknown> }).updateMany({ where: { leadId: dropId }, data: { leadId: keepId } });
      }
      await tx.lead.delete({ where: { id: dropId } });
      return tx.lead.update({
        where: { id: keepId },
        data: {
          ...fill('name'), ...fill('wechat'), ...fill('intent'), ...fill('topicId'), ...fill('sourcePlatform'), ...fill('sourceAccount'), ...fill('sourcePostUrl'), ...fill('wecomChannel'), ...fill('nickname'), ...fill('ownerId'), ...fill('lastFollowAt'),
          ...(keep.intentDetail == null && drop.intentDetail != null ? { intentDetail: drop.intentDetail as Prisma.InputJsonValue } : {}),
          ...(moveConv ? { conversationId: moveConv } : {}),
          ...(!keep.phoneHash && drop.phoneHash ? { phoneHash: drop.phoneHash, phoneEnc: drop.phoneEnc } : {}),
          nextFollowAt: keep.nextFollowAt && drop.nextFollowAt ? (keep.nextFollowAt < drop.nextFollowAt ? keep.nextFollowAt : drop.nextFollowAt) : (keep.nextFollowAt ?? drop.nextFollowAt),
          editedFields: [...new Set([...keep.editedFields, ...drop.editedFields])],
          status,
        },
      });
    });
    await this.audit.log(me?.id, 'lead.merge', keepId, { merged: dropId });
    return result;
  }

  async markAddedWecom(leadId: string) {
    const l = await this.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (l.status === LeadStatus.NEW) return this.prisma.lead.update({ where: { id: leadId }, data: { status: LeadStatus.ADDED_WECOM } });
    return l;
  }

  // ---------- 私信里的联系方式和地址 ----------

  /**
   * 每条客户消息都过一遍：识别手机号、微信号、整段收货地址和“确认”。
   * 识别到地址先存成待确认，AI 接待时回显给客户核对；不在配送范围的转人工。
   */
  async onCustomerMessage(conversationId: string, text: string, auto: boolean): Promise<MessageAction> {
    const s = await this.settings();
    const phoneRaw = PHONE_IN_TEXT.exec(text)?.[0];
    const phone = normalizePhone(phoneRaw);
    const parsed = phone ? parseAddress(text, s.noShip) : null;
    const isAddress = !!parsed && !!parsed.province && parsed.detail.length >= 3 && !!parsed.name;

    if (!phone) {
      const wechat = WECHAT_IN_TEXT.exec(text)?.[1];
      const lead = await this.leadForConversation(conversationId);
      if (wechat) {
        const l = lead ?? (await this.ensureForConversation(conversationId));
        if (!l.wechat) await this.prisma.lead.update({ where: { id: l.id }, data: { wechat } });
      }
      if (lead && CONFIRM.test(text.trim())) return this.confirmPending(conversationId, lead.id, auto);
      return {};
    }

    const leadId = await this.setPhone((await this.ensureForConversation(conversationId)).id, phone);
    if (!isAddress) return { note: '客户留了手机号，已记到线索上' };
    const address = await this.saveAddress(leadId, parsed, 'chat', false);
    if (parsed.outOfRange) {
      return { handoff: `收货地址不在配送范围（${parsed.province}）`, note: `识别到收货地址：${parsed.province}${parsed.city}，不在配送范围` };
    }
    if (!auto) return { note: '识别到收货地址，等客户确认后可在线索里点“确认”' };
    return {
      reply: {
        text: `帮你核对一下收货信息：\n收件人：${parsed.name}\n电话：尾号 ${parsed.phone.slice(-4)}\n地址：${parsed.province}${parsed.city}${parsed.district}${parsed.detail}\n没问题的话回复“确认”就好～${s.privacyNotice}`,
        meta: { addressConfirm: address.id, intent: 'high' },
      },
    };
  }

  private async confirmPending(conversationId: string, leadId: string, auto: boolean): Promise<MessageAction> {
    const last = await this.prisma.message.findFirst({ where: { conversationId, sender: 'ai' }, orderBy: { createdAt: 'desc' } });
    const addressId = (last?.meta as { addressConfirm?: string } | null)?.addressConfirm;
    if (!addressId) return {};
    const a = await this.prisma.address.findFirst({ where: { id: addressId, leadId, confirmed: false } });
    if (!a) return {};
    await this.prisma.address.update({ where: { id: a.id }, data: { confirmed: true } });
    return auto ? { reply: { text: '好的，收货地址已确认～有其他问题随时找我。', meta: { addressConfirmed: a.id, intent: 'high' } }, note: '客户已确认收货地址' } : { note: '客户已确认收货地址' };
  }

  private async saveAddress(leadId: string, p: Pick<ParsedAddress, 'name' | 'phone' | 'province' | 'city' | 'district' | 'detail'>, source: string, confirmed: boolean) {
    return this.prisma.address.create({
      data: { leadId, receiverEnc: encrypt(p.name), phoneEnc: encrypt(p.phone), province: p.province, city: p.city, district: p.district, detailEnc: encrypt(p.detail), confirmed, source },
    });
  }

  // ---------- 人工操作 ----------

  async createManual(me: AuthUser, b: LeadCreate) {
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (b.phone && !phone) throw new BadRequestException('手机号格式不对');
    if (!me.roles.includes(Role.ADMIN) && !me.roles.includes(b.audience === Audience.B ? Role.BIZ : Role.CS)) throw new ForbiddenException('不能录入这个客群的线索');
    if (phone) {
      const dup = await this.byPhone(phone);
      if (dup) throw new BadRequestException(`这个手机号已经有线索了（${dup.nickname ?? dup.name ?? '客户'}），请直接在那条上跟进`);
    }
    const lead = await this.create(
      {
        audience: b.audience, nickname: b.nickname ?? null, name: b.name ?? null, wechat: b.wechat ?? null, intent: b.intent ?? null,
        intentDetail: (b.intentDetail ?? undefined) as Prisma.InputJsonValue | undefined, nextFollowAt: b.nextFollowAt ?? null,
        ...(b.ownerId !== undefined ? { ownerId: b.ownerId } : {}),
        ...(phone ? { phoneHash: hashPhone(phone), phoneEnc: encrypt(phone) } : {}),
        editedFields: [...AI_FIELDS],
      },
      { kind: 'manual' },
    );
    await this.audit.log(me.id, 'lead.create', lead.id);
    return lead;
  }

  async update(me: AuthUser, id: string, b: LeadPatch) {
    const l = await this.load(me, id, true);
    if (b.ownerId !== undefined && b.ownerId !== l.ownerId && !me.roles.includes(Role.ADMIN) && !(l.audience === Audience.B && me.roles.includes(Role.BIZ))) throw new ForbiddenException('只有管理员能改 C 端线索的负责人');
    const { phone: rawPhone, intentDetail, ...rest } = b;
    const edited = AI_FIELDS.filter((f) => b[f] !== undefined);
    await this.prisma.lead.update({
      where: { id },
      data: {
        ...rest,
        ...(intentDetail !== undefined ? { intentDetail: intentDetail === null ? Prisma.DbNull : intentDetail } : {}),
        ...(b.nextFollowAt !== undefined ? { followRemindedAt: null } : {}),
        editedFields: [...new Set([...l.editedFields, ...edited])],
      },
    });
    let finalId = id;
    if (rawPhone !== undefined) {
      if (rawPhone === null || rawPhone === '') await this.prisma.lead.update({ where: { id }, data: { phoneHash: null, phoneEnc: null } });
      else {
        const phone = normalizePhone(rawPhone);
        if (!phone) throw new BadRequestException('手机号格式不对');
        finalId = await this.setPhone(id, phone);
      }
    }
    if (b.ownerId && b.ownerId !== l.ownerId) {
      const owner = await this.prisma.user.findUnique({ where: { id: b.ownerId } });
      if (owner) await this.notify.toUsers([owner.wecomId], `【线索转给你】${l.nickname ?? l.name ?? '客户'}（${STATUS_TEXT[l.status]}）由 ${me.name} 转给你，请到工作台“线索库”跟进。`);
    }
    await this.audit.log(me.id, 'lead.update', finalId, { ...b, phone: b.phone ? '***' : b.phone } as Prisma.InputJsonValue);
    return this.detail(me, finalId);
  }

  async addFollowUp(me: AuthUser, id: string, b: { note: string; nextFollowAt?: Date | null; status?: LeadStatus }) {
    const l = await this.load(me, id, true);
    await this.prisma.followUp.create({ data: { leadId: id, userId: me.id, note: b.note } });
    const status = b.status ?? (STATUS_RANK[l.status] < STATUS_RANK.FOLLOWING && l.status !== LeadStatus.LOST ? LeadStatus.FOLLOWING : l.status);
    await this.prisma.lead.update({
      where: { id },
      data: { lastFollowAt: new Date(), status, ...(b.nextFollowAt !== undefined ? { nextFollowAt: b.nextFollowAt, followRemindedAt: null } : {}), ...(!l.ownerId ? { ownerId: me.id } : {}) },
    });
    return this.detail(me, id);
  }

  async addAddress(me: AuthUser, id: string, b: AddressInput) {
    await this.load(me, id, true);
    const phone = normalizePhone(b.phone);
    if (!phone) throw new BadRequestException('电话不是有效的手机号');
    const s = await this.settings();
    if (s.noShip.some((p) => b.province.startsWith(p))) throw new BadRequestException(`${b.province}不在鲜果配送范围内`);
    const a = await this.saveAddress(id, { ...b, phone }, 'manual', b.confirmed);
    await this.audit.log(me.id, 'lead.address.create', id, { addressId: a.id });
    return this.detail(me, id);
  }

  async updateAddress(me: AuthUser, id: string, addressId: string, b: Partial<AddressInput>) {
    await this.load(me, id, true);
    const a = await this.prisma.address.findFirst({ where: { id: addressId, leadId: id } });
    if (!a) throw new NotFoundException('地址不存在');
    const phone = b.phone !== undefined ? normalizePhone(b.phone) : undefined;
    if (phone === null) throw new BadRequestException('电话不是有效的手机号');
    await this.prisma.address.update({
      where: { id: addressId },
      data: {
        ...(b.name !== undefined ? { receiverEnc: encrypt(b.name) } : {}),
        ...(phone ? { phoneEnc: encrypt(phone) } : {}),
        ...(b.detail !== undefined ? { detailEnc: encrypt(b.detail) } : {}),
        ...(b.province !== undefined ? { province: b.province } : {}),
        ...(b.city !== undefined ? { city: b.city } : {}),
        ...(b.district !== undefined ? { district: b.district } : {}),
        ...(b.confirmed !== undefined ? { confirmed: b.confirmed } : {}),
      },
    });
    await this.audit.log(me.id, 'lead.address.update', id, { addressId });
    return this.detail(me, id);
  }

  async removeAddress(me: AuthUser, id: string, addressId: string) {
    await this.load(me, id, true);
    const r = await this.prisma.address.deleteMany({ where: { id: addressId, leadId: id } });
    if (!r.count) throw new NotFoundException('地址不存在');
    await this.audit.log(me.id, 'lead.address.delete', id, { addressId });
    return this.detail(me, id);
  }

  /** 批量导入地址（企业礼赠、代送）：每行一个地址，可以直接从 Excel 复制粘贴。 */
  async importAddresses(me: AuthUser, id: string, text: string) {
    await this.load(me, id, true);
    const s = await this.settings();
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 500) throw new BadRequestException('一次最多导入 500 行');
    const failed: { line: number; text: string; message: string }[] = [];
    let created = 0;
    for (const [i, line] of lines.entries()) {
      const p = parseAddress(line, s.noShip);
      if (!p.ok || !p.name || p.detail.length < 2) {
        if (i === 0 && /收件人|收货人|姓名|电话|地址/.test(line) && !p.phone) continue; // 表头
        failed.push({ line: i + 1, text: line.slice(0, 60), message: p.message || '没认出收件人或详细地址' });
        continue;
      }
      await this.saveAddress(id, p, 'import', true);
      created++;
    }
    await this.audit.log(me.id, 'lead.address.import', id, { created, failed: failed.length });
    return { created, failed };
  }

  // ---------- AI ----------

  /** 从私信对话提取姓名、微信、意向内容（人工改过的字段不动）。 */
  async extract(leadId: string) {
    const lead = await this.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const convIds = [lead.conversationId, ...(await this.prisma.leadSource.findMany({ where: { leadId, conversationId: { not: null } } })).map((s) => s.conversationId)].filter((x): x is string => !!x);
    if (!convIds.length) return lead;
    const msgs = await this.prisma.message.findMany({ where: { conversationId: { in: [...new Set(convIds)] }, sender: { in: ['customer', 'ai', 'agent'] } }, orderBy: { createdAt: 'asc' }, take: 60 });
    if (!msgs.some((m) => m.sender === 'customer')) return lead;
    const { output } = await this.ai.run(leadExtract, { audience: lead.audience, history: msgs.map((m) => ({ sender: m.sender, text: m.text })) }, { refType: 'lead', refId: leadId });
    const keep = (f: string) => !lead.editedFields.includes(f);
    const detail = Object.fromEntries(Object.entries(output.detail).filter(([, v]) => v));
    return this.prisma.lead.update({
      where: { id: leadId },
      data: {
        ...(keep('audience') && output.audience !== 'unknown' ? { audience: output.audience } : {}),
        ...(keep('intent') ? { intent: output.intent } : {}),
        ...(keep('name') && output.name && !lead.name ? { name: output.name } : {}),
        ...(keep('wechat') && output.wechat && !lead.wechat ? { wechat: output.wechat } : {}),
        ...(keep('intentDetail') ? { intentDetail: { ...((lead.intentDetail as object) ?? {}), ...detail, summary: output.summary } } : {}),
      },
    });
  }

  async reExtract(me: AuthUser, id: string) {
    await this.load(me, id, true);
    await this.extract(id);
    return this.detail(me, id);
  }

  async script(me: AuthUser, id: string) {
    const lead = await this.load(me, id);
    const [followUps, msgs, facts] = await Promise.all([
      this.prisma.followUp.findMany({ where: { leadId: id }, orderBy: { createdAt: 'desc' }, take: 5 }),
      lead.conversationId ? this.prisma.message.findMany({ where: { conversationId: lead.conversationId, sender: { in: ['customer', 'ai', 'agent'] } }, orderBy: { createdAt: 'desc' }, take: 20 }) : Promise.resolve([]),
      this.prisma.knowledgeItem.findMany({ where: { kind: { not: 'compliance' } }, take: 8 }),
    ]);
    const detail = (lead.intentDetail ?? null) as Record<string, string | null> | null;
    const { output } = await this.ai.run(
      leadScript,
      {
        audience: lead.audience,
        status: STATUS_TEXT[lead.status],
        intentSummary: detail?.summary ?? null,
        detail,
        followUps: followUps.map((f) => ({ note: f.note, at: f.createdAt.toISOString().slice(0, 10) })),
        history: msgs.reverse().map((m) => ({ sender: m.sender, text: m.text })),
        facts: facts.map((f) => ({ title: f.title, content: f.content.slice(0, 300) })),
      },
      { refType: 'lead', refId: id },
    );
    return output;
  }

  // ---------- 导出 ----------

  /** 导出明文 CSV：只有管理员能导，记日志。 */
  async exportCsv(me: AuthUser, audience?: string) {
    const rows = await this.prisma.lead.findMany({
      where: audience === 'C' || audience === 'B' ? { audience: audience as Audience } : {},
      include: { owner: { select: { name: true } }, addresses: { orderBy: [{ confirmed: 'desc' }, { createdAt: 'asc' }], take: 1 } },
      orderBy: { createdAt: 'asc' },
    });
    await this.audit.log(me.id, 'lead.export', audience ?? 'all', { count: rows.length });
    const cell = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['客群', '状态', '意向', '昵称', '姓名', '手机号', '微信', '来源平台', '来源账号', '来源作品', '负责人', '收件人', '收件电话', '收货地址', '创建时间'];
    const lines = rows.map((l) => {
      const a = l.addresses[0];
      return [
        l.audience === Audience.B ? 'B 端' : 'C 端', STATUS_TEXT[l.status], l.intent ?? '', l.nickname, l.name, this.phoneOf(l), l.wechat, l.sourcePlatform, l.sourceAccount, l.sourcePostUrl, l.owner?.name,
        a ? decrypt(a.receiverEnc) : '', a ? decrypt(a.phoneEnc) : '', a ? `${a.province}${a.city}${a.district}${decrypt(a.detailEnc)}` : '',
        l.createdAt.toISOString().replace('T', ' ').slice(0, 16),
      ].map(cell).join(',');
    });
    return `﻿${[head.join(','), ...lines].join('\n')}\n`;
  }

  // ---------- 提醒 ----------

  private get cronOn() {
    return this.config.get('CRON_ENABLED', 'true') !== 'false';
  }

  /** 每 10 分钟：到了下次跟进时间提醒负责人；新线索超过时限没人跟进也提醒（各只提醒一次）。 */
  @Cron('0 */10 * * * *', { name: 'lead-reminders' })
  async remind(now = new Date(), force = false) {
    if (!force && !this.cronOn) return { due: 0, stale: 0 };
    const s = await this.settings();
    const owner = { owner: { select: { wecomId: true, active: true } } } as const;
    const due = await this.prisma.lead.findMany({
      where: { ownerId: { not: null }, nextFollowAt: { lte: now }, followRemindedAt: null, status: { notIn: [LeadStatus.WON, LeadStatus.LOST] } },
      include: owner,
      take: 200,
    });
    for (const l of due) {
      if (l.owner?.active) await this.notify.toUsers([l.owner.wecomId], `【该跟进了】${l.nickname ?? l.name ?? '客户'}（${l.audience === Audience.B ? 'B 端' : 'C 端'} · ${STATUS_TEXT[l.status]}）到了约定的跟进时间。`);
      await this.prisma.lead.update({ where: { id: l.id }, data: { followRemindedAt: now } });
    }
    const stale = await this.prisma.lead.findMany({
      where: { ownerId: { not: null }, lastFollowAt: null, staleRemindedAt: null, status: { in: [LeadStatus.NEW, LeadStatus.ADDED_WECOM] }, createdAt: { lte: new Date(now.getTime() - s.staleHours * 3600_000) } },
      include: owner,
      take: 200,
    });
    for (const l of stale) {
      if (l.owner?.active) await this.notify.toUsers([l.owner.wecomId], `【线索未跟进】${l.nickname ?? l.name ?? '客户'} 进来超过 ${s.staleHours} 小时还没有跟进记录，请尽快联系。`);
      await this.prisma.lead.update({ where: { id: l.id }, data: { staleRemindedAt: now } });
    }
    return { due: due.length, stale: stale.length };
  }
}
