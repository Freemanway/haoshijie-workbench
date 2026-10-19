import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Response } from 'express';
import { Audience, ConversationStatus, LeadStatus, Prisma, Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth.decorators';
import { encrypt, hashPhone, normalizePhone } from '../common/pii';
import { ZodPipe } from '../common/zod.pipe';
import { JobQueue } from '../drafts/job-queue';
import { PrismaService } from '../prisma/prisma.service';
import { RiskModule, RiskService } from '../risk/risk.module';
import { WecomClient } from './wecom.client';
import { WecomCrypto, xmlField } from './wecom.crypto';
import { NotifyService } from './wecom.module';

const TAG_GROUP = '好时节来源渠道';

const SettingsSchema = z.object({
  /** 加微欢迎语，按客群；{name} 换成客户微信昵称 */
  welcome: z.object({ C: z.string().trim().min(1).max(500), B: z.string().trim().min(1).max(500) }),
  /** 群活码没开自动建群时，所有群都到这个人数就提醒换群 */
  groupFullAt: z.number().int().min(10).max(500),
});
type Settings = z.infer<typeof SettingsSchema>;
const SETTINGS_KEY = 'wecom';
const DEFAULT_SETTINGS: Settings = {
  welcome: {
    C: '{name}你好呀，我是好时节的小鲜～感谢添加！当季鲜果的实拍、价格和团购优惠都可以直接问我。',
    B: '{name}你好，我是好时节的招商对接人，感谢添加！方便说下你所在城市、渠道类型和大概需求量吗？我按你的情况发供货方案。',
  },
  groupFullAt: 190,
};

const ChannelInput = z.object({
  kind: z.enum(['qr', 'link']),
  name: z.string().trim().min(1, '请填写渠道名称').max(30, '渠道名称最多 30 字（企业微信标签长度限制）'),
  accountId: z.string().nullish(),
  audience: z.nativeEnum(Audience),
  staff: z.array(z.string().min(1)).min(1, '至少选一位接待成员').max(100),
  welcomeText: z.string().trim().max(500).nullish(),
  groupWayId: z.string().nullish(),
  active: z.boolean().optional(),
});
type ChannelIn = z.infer<typeof ChannelInput>;

const GroupInput = z.object({
  name: z.string().trim().min(1, '请填写名称').max(30),
  chatIds: z.array(z.string().min(1)).min(1, '至少填一个客户群 ID').max(5, '企业微信一个群活码最多关联 5 个群'),
  autoCreate: z.boolean().default(true),
  roomBaseName: z.string().trim().max(40).nullish(),
  roomBaseId: z.number().int().min(1).max(10000).nullish(),
});
type GroupIn = z.infer<typeof GroupInput>;

const STATE_RE = /(c[hv]_[A-Za-z0-9]+)/;
const newState = (p: 'ch' | 'gp') => `${p}_${randomBytes(8).toString('hex')}`;

/**
 * M9 私域引流：渠道活码（联系我二维码 / 获客助手链接）、加微回调（欢迎语、来源标签、关联线索）、团购群活码。
 * 加微回调和私信一样先落库再处理，失败的由定时任务重试。
 */
@Injectable()
export class CrmService {
  private readonly log = new Logger('WecomCrm');
  private readonly queue = new JobQueue(2);
  /** 群活码二维码上传成临时素材后的 media_id，3 天有效，这里缓存 2.5 天 */
  private readonly media = new Map<string, { id: string; qr: string; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wecom: WecomClient,
    private readonly risk: RiskService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  idle() {
    return this.queue.idle();
  }

  status() {
    return {
      enabled: this.wecom.enabled,
      callback: Boolean(this.config.get('WECOM_CALLBACK_TOKEN') && this.config.get('WECOM_CALLBACK_AES_KEY')),
      callbackPath: '/api/wecom/callback',
    };
  }

  private need() {
    if (!this.wecom.enabled) throw new ServiceUnavailableException('还没配置企业微信（WECOM_CORP_ID、WECOM_AGENT_ID、WECOM_SECRET），不能生成活码');
  }

  // ---------- 设置 ----------

  async settings(): Promise<Settings> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async saveSettings(me: AuthUser, s: Settings) {
    await this.assertClean([s.welcome.C, s.welcome.B]);
    await this.prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: s }, update: { value: s } });
    await this.audit.log(me.id, 'wecom.settings', SETTINGS_KEY);
    return s;
  }

  /** 欢迎语会自动发给客户，保存前过风控，有拦截词不让保存。 */
  private async assertClean(texts: (string | null | undefined)[]) {
    for (const t of texts) {
      if (!t) continue;
      const r = await this.risk.check({ text: t });
      if (r.blocked) {
        const words = [...new Set(r.hits.filter((h) => h.level === 'block').map((h) => h.matched))];
        throw new BadRequestException(`欢迎语含有风控拦截词：${words.join('、')}`);
      }
    }
  }

  // ---------- 渠道活码 ----------

  async channels() {
    const rows = await this.prisma.wecomChannel.findMany({ orderBy: { createdAt: 'asc' }, include: { account: true, groupWay: { select: { id: true, name: true } } } });
    const since = new Date(Date.now() - 7 * 86400_000);
    const [all, week] = await Promise.all([
      this.prisma.wecomContact.groupBy({ by: ['channelId'], _count: true }),
      this.prisma.wecomContact.groupBy({ by: ['channelId'], where: { addedAt: { gte: since } }, _count: true }),
    ]);
    const n = (g: { channelId: string | null; _count: number }[], id: string) => g.find((x) => x.channelId === id)?._count ?? 0;
    return rows.map((c) => ({ ...c, added: n(all, c.id), addedWeek: n(week, c.id) }));
  }

  private async checkChannel(b: Partial<ChannelIn>) {
    if (b.staff) {
      const users = await this.prisma.user.findMany({ where: { wecomId: { in: b.staff }, active: true }, select: { wecomId: true } });
      const missing = b.staff.filter((s) => !users.some((u) => u.wecomId === s));
      if (missing.length) throw new BadRequestException(`这些接待成员不在工作台成员里或已停用：${missing.join('、')}`);
    }
    if (b.accountId && !(await this.prisma.platformAccount.findUnique({ where: { id: b.accountId } }))) throw new BadRequestException('平台账号不存在');
    if (b.groupWayId && !(await this.prisma.groupJoinWay.findFirst({ where: { id: b.groupWayId, active: true } }))) throw new BadRequestException('群活码不存在或已停用');
    await this.assertClean([b.welcomeText]);
  }

  async createChannel(me: AuthUser, b: ChannelIn) {
    this.need();
    await this.checkChannel(b);
    const state = newState('ch');
    const remote = b.kind === 'qr' ? await this.wecom.addContactWay(b.staff, state, b.name) : await this.wecom.createLink(b.name, b.staff);
    let tagId: string | null = null;
    try {
      tagId = await this.wecom.ensureTag(TAG_GROUP, b.name);
    } catch (e) {
      this.log.warn(`建来源标签失败，加微时不打标签：${(e as Error).message}`);
    }
    const url = 'url' in remote ? `${remote.url}${remote.url.includes('?') ? '&' : '?'}customer_channel=${state}` : null;
    const c = await this.prisma.wecomChannel.create({
      data: {
        kind: b.kind, name: b.name, accountId: b.accountId ?? null, audience: b.audience, staff: b.staff, state,
        remoteId: remote.remoteId, qrCode: 'qrCode' in remote ? remote.qrCode : null, url, tagId,
        welcomeText: b.welcomeText || null, groupWayId: b.groupWayId ?? null,
      },
    });
    await this.audit.log(me.id, 'wecom.channel.create', c.id, { name: c.name, kind: c.kind });
    return c;
  }

  async updateChannel(me: AuthUser, id: string, b: Partial<ChannelIn>) {
    const c = await this.prisma.wecomChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('渠道不存在');
    await this.checkChannel(b);
    const name = b.name ?? c.name;
    const staff = b.staff ?? c.staff;
    const staffChanged = b.staff && (b.staff.length !== c.staff.length || b.staff.some((x, i) => x !== c.staff[i]));
    if ((b.name && b.name !== c.name) || staffChanged) {
      this.need();
      if (c.kind === 'qr') await this.wecom.updateContactWay(c.remoteId!, staff, c.state, name);
      else await this.wecom.updateLink(c.remoteId!, name, staff);
    }
    let tagId = c.tagId;
    if (b.name && b.name !== c.name) tagId = await this.wecom.ensureTag(TAG_GROUP, b.name).catch(() => c.tagId);
    const { kind: _kind, ...rest } = b;
    const updated = await this.prisma.wecomChannel.update({
      where: { id },
      data: { ...rest, welcomeText: b.welcomeText === undefined ? undefined : b.welcomeText || null, tagId },
    });
    await this.audit.log(me.id, 'wecom.channel.update', id, b as Prisma.InputJsonValue);
    return updated;
  }

  /** 删除：企业微信那边的码/链接作废，工作台保留记录和加微数据，只是停用。 */
  async removeChannel(me: AuthUser, id: string) {
    const c = await this.prisma.wecomChannel.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('渠道不存在');
    if (c.remoteId && this.wecom.enabled) {
      try {
        if (c.kind === 'qr') await this.wecom.delContactWay(c.remoteId);
        else await this.wecom.deleteLink(c.remoteId);
      } catch (e) {
        this.log.warn(`作废企业微信活码失败：${(e as Error).message}`);
      }
    }
    await this.prisma.wecomChannel.update({ where: { id }, data: { active: false, remoteId: null } });
    await this.audit.log(me.id, 'wecom.channel.delete', id);
    return { ok: true };
  }

  /** 给某个私信会话的专属加微链接：客户点它加微后，直接和这条会话、线索对上。 */
  async conversationLink(conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    const links = await this.prisma.wecomChannel.findMany({ where: { kind: 'link', active: true, url: { not: null } }, orderBy: { createdAt: 'asc' } });
    const aud = conv.audience;
    const pick =
      links.find((l) => l.accountId === conv.accountId && (!aud || l.audience === aud)) ??
      links.find((l) => l.accountId === conv.accountId) ??
      links.find((l) => !l.accountId && (!aud || l.audience === aud));
    if (!pick) throw new NotFoundException('这个账号还没有获客链接，请管理员在“私域引流”里新建');
    return { channel: { id: pick.id, name: pick.name }, url: pick.url!.replace(/customer_channel=[^&]*/, `customer_channel=cv_${conv.id}`) };
  }

  async contacts(channelId?: string) {
    const rows = await this.prisma.wecomContact.findMany({
      where: channelId ? { channelId } : {},
      orderBy: { addedAt: 'desc' },
      take: 100,
      include: { channel: { select: { name: true } }, lead: { select: { id: true, status: true, audience: true, conversationId: true } } },
    });
    return rows;
  }

  // ---------- 团购群活码 ----------

  groups() {
    return this.prisma.groupJoinWay.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async createGroup(me: AuthUser, b: GroupIn) {
    this.need();
    const state = newState('gp');
    const w = { ...b, state, roomBaseName: b.roomBaseName || b.name };
    const remoteId = await this.wecom.addJoinWay(w);
    const qrCode = await this.wecom.joinWayQr(remoteId);
    const g = await this.prisma.groupJoinWay.create({ data: { name: b.name, chatIds: b.chatIds, autoCreate: b.autoCreate, roomBaseName: w.roomBaseName, roomBaseId: b.roomBaseId ?? 1, state, remoteId, qrCode } });
    await this.audit.log(me.id, 'wecom.group.create', g.id, { name: g.name });
    await this.checkGroup(g.id).catch(() => undefined);
    return this.prisma.groupJoinWay.findUniqueOrThrow({ where: { id: g.id } });
  }

  async updateGroup(me: AuthUser, id: string, b: Partial<GroupIn>) {
    const g = await this.prisma.groupJoinWay.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('群活码不存在');
    this.need();
    const next = {
      name: b.name ?? g.name,
      chatIds: b.chatIds ?? g.chatIds,
      autoCreate: b.autoCreate ?? g.autoCreate,
      roomBaseName: (b.roomBaseName === undefined ? g.roomBaseName : b.roomBaseName) || (b.name ?? g.name),
      roomBaseId: b.roomBaseId ?? g.roomBaseId,
      state: g.state,
    };
    await this.wecom.updateJoinWay(g.remoteId!, next);
    const { state: _s, ...data } = next;
    await this.prisma.groupJoinWay.update({ where: { id }, data: { ...data, fullAlertAt: null } });
    this.media.delete(id);
    await this.audit.log(me.id, 'wecom.group.update', id, b as Prisma.InputJsonValue);
    await this.checkGroup(id).catch(() => undefined);
    return this.prisma.groupJoinWay.findUniqueOrThrow({ where: { id } });
  }

  async removeGroup(me: AuthUser, id: string) {
    const g = await this.prisma.groupJoinWay.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('群活码不存在');
    if (g.remoteId && this.wecom.enabled) await this.wecom.delJoinWay(g.remoteId).catch((e) => this.log.warn(`作废群活码失败：${(e as Error).message}`));
    await this.prisma.wecomChannel.updateMany({ where: { groupWayId: id }, data: { groupWayId: null } });
    await this.prisma.groupJoinWay.update({ where: { id }, data: { active: false, remoteId: null } });
    await this.audit.log(me.id, 'wecom.group.delete', id);
    return { ok: true };
  }

  /**
   * 刷新群活码关联的群和人数。开了自动建群的，群满后企业微信会自动建新群并加进来；
   * 没开的，所有群都快满时提醒客服和管理员换群（24 小时内只提醒一次）。
   */
  async checkGroup(id: string, now = new Date()) {
    const g = await this.prisma.groupJoinWay.findUniqueOrThrow({ where: { id } });
    if (!g.active || !g.remoteId) return g;
    const s = await this.settings();
    const members: Record<string, { name: string; count: number }> = {};
    for (const chatId of g.chatIds) {
      try {
        members[chatId] = await this.wecom.groupChat(chatId);
      } catch (e) {
        this.log.warn(`查询客户群 ${chatId} 失败：${(e as Error).message}`);
      }
    }
    const full = g.chatIds.length > 0 && g.chatIds.every((c) => (members[c]?.count ?? 0) >= s.groupFullAt);
    const alert = full && !g.autoCreate && (!g.fullAlertAt || now.getTime() - g.fullAlertAt.getTime() > 86400_000);
    if (alert) await this.notify.toRoles([Role.CS, Role.ADMIN], `【团购群快满了】群活码“${g.name}”关联的 ${g.chatIds.length} 个群都已到 ${s.groupFullAt} 人以上，请新建群并加到群活码里（或开启自动建群）。`);
    return this.prisma.groupJoinWay.update({
      where: { id },
      data: { members, checkedAt: now, ...(alert ? { fullAlertAt: now } : {}), ...(!full ? { fullAlertAt: null } : {}) },
    });
  }

  private async groupMedia(groupWayId: string) {
    const g = await this.prisma.groupJoinWay.findUnique({ where: { id: groupWayId } });
    if (!g?.active || !g.qrCode) return undefined;
    const hit = this.media.get(groupWayId);
    if (hit && hit.qr === g.qrCode && Date.now() - hit.at < 2.5 * 86400_000) return hit.id;
    const id = await this.wecom.uploadImage(g.qrCode);
    this.media.set(groupWayId, { id, qr: g.qrCode, at: Date.now() });
    return id;
  }

  // ---------- 加微回调 ----------

  private crypto() {
    const token = this.config.get<string>('WECOM_CALLBACK_TOKEN');
    const aes = this.config.get<string>('WECOM_CALLBACK_AES_KEY');
    const corp = this.config.get<string>('WECOM_CORP_ID');
    if (!token || !aes || !corp) throw new ServiceUnavailableException('未配置企业微信回调（WECOM_CALLBACK_TOKEN、WECOM_CALLBACK_AES_KEY）');
    return new WecomCrypto(token, aes, corp);
  }

  /** 企业微信后台保存回调地址时的校验：解出 echostr 原样返回。 */
  verifyUrl(q: Record<string, string>) {
    const c = this.crypto();
    if (!c.verify(q.msg_signature, q.timestamp, q.nonce, q.echostr ?? '')) throw new ForbiddenException('签名不对');
    return c.decrypt(q.echostr);
  }

  /** 收到回调先落库再处理；企业微信要求 5 秒内应答，处理放到队列里。 */
  async receive(q: Record<string, string>, body: string, opts: { wait?: boolean } = {}) {
    const c = this.crypto();
    const enc = xmlField(body ?? '', 'Encrypt');
    if (!enc || !c.verify(q.msg_signature, q.timestamp, q.nonce, enc)) throw new ForbiddenException('签名不对');
    const xml = c.decrypt(enc);
    const f = (k: string) => xmlField(xml, k);
    const event = f('Event');
    if (event !== 'change_external_contact' && event !== 'change_external_chat') return 'success';
    const payload = {
      event, changeType: f('ChangeType'), staffId: f('UserID'), externalUserId: f('ExternalUserID'), state: f('State'),
      welcomeCode: f('WelcomeCode'), chatId: f('ChatId'), updateDetail: f('UpdateDetail'), createTime: f('CreateTime'),
    };
    const externalId = `wecom:${payload.changeType}:${payload.externalUserId ?? payload.chatId}:${payload.staffId ?? ''}:${payload.createTime}`;
    const ev = await this.prisma.inboundEvent
      .create({ data: { channel: 'wecom', externalId, payload } })
      .catch((e) => (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' ? null : Promise.reject(e)));
    if (ev) {
      if (opts.wait) await this.process(ev.id);
      else this.queue.push(() => this.process(ev.id));
    }
    return 'success';
  }

  async process(eventId: string) {
    const ev = await this.prisma.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
    if (ev.status === 'done') return;
    const p = ev.payload as Record<string, string | undefined>;
    try {
      if (p.event === 'change_external_chat') await this.onChat(p.chatId);
      else if (p.changeType === 'add_external_contact') await this.onAdd(p as unknown as AddEvent, ev.createdAt);
      else if (p.changeType === 'edit_external_contact') await this.onEdit(p as unknown as AddEvent);
      else if (p.changeType === 'del_external_contact' || p.changeType === 'del_follow_user') {
        await this.prisma.wecomContact.updateMany({ where: { externalUserId: p.externalUserId, staffId: p.staffId }, data: { removedAt: new Date() } });
      }
      await this.prisma.inboundEvent.update({ where: { id: ev.id }, data: { status: 'done', processedAt: new Date(), attempts: { increment: 1 }, error: null } });
    } catch (e) {
      this.log.error(`处理企业微信回调失败：${(e as Error).message}`);
      await this.prisma.inboundEvent.update({ where: { id: ev.id }, data: { status: 'failed', attempts: { increment: 1 }, error: (e as Error).message.slice(0, 500) } });
    }
  }

  private async onAdd(p: AddEvent, receivedAt: Date) {
    const stateKey = STATE_RE.exec(p.state ?? '')?.[1];
    const conv = stateKey?.startsWith('cv_') ? await this.prisma.conversation.findUnique({ where: { id: stateKey.slice(3) }, include: { account: true } }) : null;
    let channel = stateKey?.startsWith('ch_') ? await this.prisma.wecomChannel.findUnique({ where: { state: stateKey } }) : null;
    if (!channel && conv) channel = await this.prisma.wecomChannel.findFirst({ where: { kind: 'link', accountId: conv.accountId, active: true }, orderBy: { createdAt: 'asc' } });

    const contact = await this.prisma.wecomContact.upsert({
      where: { externalUserId_staffId: { externalUserId: p.externalUserId, staffId: p.staffId } },
      create: { externalUserId: p.externalUserId, staffId: p.staffId, state: p.state ?? null, channelId: channel?.id ?? null },
      update: { removedAt: null, state: p.state ?? undefined, channelId: channel?.id ?? undefined },
    });

    const detail = await this.wecom.externalContact(p.externalUserId).catch((e) => {
      this.log.warn(`查询客户详情失败：${(e as Error).message}`);
      return { name: undefined, follow: [] as { userid: string; remark_mobiles?: string[] }[] };
    });
    const audience: Audience = channel?.audience ?? conv?.audience ?? conv?.account.audience ?? Audience.C;

    // 欢迎语最要紧（WelcomeCode 只有 20 秒），先发；重试时不再发
    if (!contact.welcome) {
      let welcome = 'skipped';
      if (p.welcomeCode && Date.now() - receivedAt.getTime() < 20_000) {
        const s = await this.settings();
        const text = (channel?.welcomeText || s.welcome[audience]).replaceAll('{name}', detail.name ?? '');
        const check = await this.risk.check({ text, source: 'welcome', sourceId: contact.id });
        if (!check.blocked) {
          try {
            const media = channel?.groupWayId && audience === Audience.C ? await this.groupMedia(channel.groupWayId).catch(() => undefined) : undefined;
            await this.wecom.sendWelcome(p.welcomeCode, text, media);
            welcome = 'sent';
          } catch (e) {
            this.log.warn(`发送欢迎语失败：${(e as Error).message}`);
            welcome = 'failed';
          }
        }
      }
      await this.prisma.wecomContact.update({ where: { id: contact.id }, data: { welcome, name: detail.name ?? undefined } });
    }

    if (channel?.tagId && !contact.tagged) {
      await this.wecom.markTag(p.staffId, p.externalUserId, [channel.tagId]);
      await this.prisma.wecomContact.update({ where: { id: contact.id }, data: { tagged: true } });
    }

    // 关联线索：会话专属链接 > 员工备注的手机号 > 同一客户加过别的成员 > 新建
    const phone = normalizePhone(detail.follow.find((f) => f.userid === p.staffId)?.remark_mobiles?.[0]);
    let lead = conv ? await this.prisma.lead.findUnique({ where: { conversationId: conv.id } }) : null;
    if (!lead && phone) lead = await this.prisma.lead.findUnique({ where: { phoneHash: hashPhone(phone) } });
    if (!lead && contact.leadId) lead = await this.prisma.lead.findUnique({ where: { id: contact.leadId } });
    if (!lead) {
      const other = await this.prisma.wecomContact.findFirst({ where: { externalUserId: p.externalUserId, leadId: { not: null } } });
      if (other) lead = await this.prisma.lead.findUnique({ where: { id: other.leadId! } });
    }
    const account = conv?.account ?? (channel?.accountId ? await this.prisma.platformAccount.findUnique({ where: { id: channel.accountId } }) : null);
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: {
          audience,
          conversationId: conv?.id ?? null,
          sourcePlatform: account?.platform ?? null,
          sourceAccount: account?.name ?? null,
          sourcePostUrl: conv?.sourcePostUrl ?? null,
          wecomChannel: channel?.id ?? null,
          nickname: detail.name ?? conv?.nickname ?? null,
          status: LeadStatus.ADDED_WECOM,
        },
      });
    } else {
      lead = await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: lead.status === LeadStatus.NEW ? LeadStatus.ADDED_WECOM : undefined,
          wecomChannel: lead.wecomChannel ?? channel?.id ?? null,
          // 走到这里说明没有线索占用这条会话（上面先按会话找过）
          conversationId: lead.conversationId ?? conv?.id ?? undefined,
        },
      });
    }
    if (phone && !lead.phoneHash) await this.setPhone(lead.id, phone);
    await this.prisma.wecomContact.update({ where: { id: contact.id }, data: { leadId: lead.id } });

    // 私信会话标记“已引流”
    if (conv && conv.status !== ConversationStatus.CLOSED && conv.status !== ConversationStatus.DIVERTED) {
      await this.prisma.conversation.update({ where: { id: conv.id }, data: { status: ConversationStatus.DIVERTED } });
      await this.prisma.message.create({ data: { conversationId: conv.id, sender: 'system', text: `客户已添加企业微信（${p.staffId}），会话标记为已引流`, delivery: 'sent' } });
    }
  }

  /** 员工给客户备注了手机号：补到线索上；手机号已在别的线索上，就把这位客户并过去。 */
  private async onEdit(p: AddEvent) {
    const contact = await this.prisma.wecomContact.findUnique({ where: { externalUserId_staffId: { externalUserId: p.externalUserId, staffId: p.staffId } } });
    if (!contact?.leadId) return;
    const detail = await this.wecom.externalContact(p.externalUserId);
    const phone = normalizePhone(detail.follow.find((f) => f.userid === p.staffId)?.remark_mobiles?.[0]);
    if (!phone) return;
    const owner = await this.prisma.lead.findUnique({ where: { phoneHash: hashPhone(phone) } });
    if (!owner) {
      const lead = await this.prisma.lead.findUniqueOrThrow({ where: { id: contact.leadId } });
      if (!lead.phoneHash) await this.setPhone(lead.id, phone);
      return;
    }
    if (owner.id === contact.leadId) return;
    const old = contact.leadId;
    await this.prisma.wecomContact.updateMany({ where: { externalUserId: p.externalUserId, leadId: old }, data: { leadId: owner.id } });
    await this.prisma.lead.update({ where: { id: owner.id }, data: { status: owner.status === LeadStatus.NEW ? LeadStatus.ADDED_WECOM : undefined } });
    // 加微时临时建的空线索没有别的数据就删掉
    const empty = await this.prisma.lead.findUnique({ where: { id: old }, include: { _count: { select: { addresses: true, followUps: true, orders: true, wecomContacts: true } } } });
    if (empty && !empty.conversationId && !empty.phoneHash && Object.values(empty._count).every((n) => n === 0)) await this.prisma.lead.delete({ where: { id: old } });
  }

  private async setPhone(leadId: string, phone: string) {
    const phoneHash = hashPhone(phone);
    if (await this.prisma.lead.findUnique({ where: { phoneHash } })) return;
    await this.prisma.lead.update({ where: { id: leadId }, data: { phoneHash, phoneEnc: encrypt(phone) } });
  }

  private async onChat(chatId?: string) {
    if (!chatId) return;
    const ways = await this.prisma.groupJoinWay.findMany({ where: { active: true, chatIds: { has: chatId } } });
    for (const w of ways) await this.checkGroup(w.id);
  }

  // ---------- 定时任务 ----------

  private get cronOn() {
    return this.config.get('CRON_ENABLED', 'true') !== 'false';
  }

  /** 每分钟重试失败的加微回调（最多 5 次）。 */
  @Cron('45 * * * * *', { name: 'wecom-retry' })
  async retry(now = new Date(), force = false) {
    if (!force && !this.cronOn) return { retried: 0 };
    const events = await this.prisma.inboundEvent.findMany({
      where: { channel: 'wecom', status: { in: ['pending', 'failed'] }, attempts: { lt: 5 }, createdAt: { lte: new Date(now.getTime() - 60_000) } },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    for (const ev of events) await this.process(ev.id);
    return { retried: events.length };
  }

  /** 每小时检查一遍团购群人数。 */
  @Cron('0 5 * * * *', { name: 'wecom-groups' })
  async checkGroups(now = new Date(), force = false) {
    if ((!force && !this.cronOn) || !this.wecom.enabled) return { checked: 0 };
    const ways = await this.prisma.groupJoinWay.findMany({ where: { active: true } });
    for (const w of ways) await this.checkGroup(w.id, now).catch((e) => this.log.warn(`检查群活码失败：${(e as Error).message}`));
    return { checked: ways.length };
  }
}

interface AddEvent {
  staffId: string;
  externalUserId: string;
  state?: string;
  welcomeCode?: string;
}

const READERS = [Role.CS, Role.BIZ, Role.VIEWER];

@Controller('wecom')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('status')
  status() {
    return this.crm.status();
  }

  @Get('settings')
  settings() {
    return this.crm.settings();
  }

  @Roles(Role.ADMIN)
  @Put('settings')
  saveSettings(@CurrentUser() me: AuthUser, @Body(new ZodPipe(SettingsSchema)) body: Settings) {
    return this.crm.saveSettings(me, body);
  }

  @Get('channels')
  channels() {
    return this.crm.channels();
  }

  @Roles(Role.ADMIN)
  @Post('channels')
  createChannel(@CurrentUser() me: AuthUser, @Body(new ZodPipe(ChannelInput)) body: ChannelIn) {
    return this.crm.createChannel(me, body);
  }

  @Roles(Role.ADMIN)
  @Patch('channels/:id')
  updateChannel(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(ChannelInput.omit({ kind: true }).partial())) body: Partial<ChannelIn>) {
    return this.crm.updateChannel(me, id, body);
  }

  @Roles(Role.ADMIN)
  @Delete('channels/:id')
  removeChannel(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.crm.removeChannel(me, id);
  }

  @Roles(...READERS)
  @Get('contacts')
  contacts(@Query('channelId') channelId?: string) {
    return this.crm.contacts(channelId);
  }

  @Roles(Role.CS, Role.BIZ)
  @Get('conversation-link/:conversationId')
  conversationLink(@Param('conversationId') id: string) {
    return this.crm.conversationLink(id);
  }

  @Get('groups')
  groups() {
    return this.crm.groups();
  }

  @Roles(Role.ADMIN)
  @Post('groups')
  createGroup(@CurrentUser() me: AuthUser, @Body(new ZodPipe(GroupInput)) body: GroupIn) {
    return this.crm.createGroup(me, body);
  }

  @Roles(Role.ADMIN)
  @Patch('groups/:id')
  updateGroup(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(GroupInput.partial())) body: Partial<GroupIn>) {
    return this.crm.updateGroup(me, id, body);
  }

  @Roles(Role.ADMIN)
  @Delete('groups/:id')
  removeGroup(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.crm.removeGroup(me, id);
  }

  @Roles(Role.ADMIN, Role.CS)
  @Post('groups/:id/check')
  checkGroup(@Param('id') id: string) {
    return this.crm.checkGroup(id);
  }

  /** 企业微信回调地址：在自建应用“接收消息”里填 https://<域名>/api/wecom/callback。 */
  @Public()
  @Get('callback')
  verify(@Query() q: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const plain = this.crm.verifyUrl(q);
    res.type('text/plain');
    return plain;
  }

  @Public()
  @Post('callback')
  @HttpCode(200)
  async receive(@Query() q: Record<string, string>, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.crm.receive(q, typeof body === 'string' ? body : '');
    res.type('text/plain');
    return r;
  }
}

@Module({ imports: [RiskModule], providers: [CrmService], controllers: [CrmController], exports: [CrmService] })
export class CrmModule {}
