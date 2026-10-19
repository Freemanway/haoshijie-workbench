import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { bestMatches, isWorkTime, workHoursText, workMinutesBetween } from '@hsj/shared';
import { Audience, ConversationStatus, Platform, Prisma, Role } from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AiService } from '../ai/ai.module';
import { ChatTurn, customerSummary, inboxReply, InboxReplyOut } from '../ai/prompts';
import { AuthUser, CurrentUser, Public, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { JobQueue } from '../drafts/job-queue';
import { LeadsModule } from '../leads/leads.module';
import { LeadsService, MessageAction } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.service';
import { RiskModule, RiskService } from '../risk/risk.module';
import { NotifyService } from '../wecom/wecom.module';

const PLATFORM_NAME: Record<Platform, string> = { XHS: '小红书', DOUYIN: '抖音', WECHAT_CHANNELS: '视频号' };
const HM = z.string().regex(/^\d{2}:\d{2}$/, '时间格式应为 HH:mm');

const SettingsSchema = z.object({
  /** 关闭后新消息全部进“待人工” */
  autoReply: z.boolean(),
  workHours: z.object({ days: z.array(z.number().int().min(1).max(7)).min(1, '至少选一天'), start: HM, end: HM }),
  /** 工作时间内转人工后多少分钟没人接待就升级提醒 */
  slaMinutes: z.number().int().min(1).max(120),
  handoffText: z.string().trim().min(1),
  /** {hours} 会替换成工作时间 */
  offHoursText: z.string().trim().min(1),
  /** 引流话术：小红书上只用官方组件（留资卡、群聊卡片等），不发微信号和电话 */
  diversion: z.object({ C: z.string().trim().min(1), B: z.string().trim().min(1) }),
});
type Settings = z.infer<typeof SettingsSchema>;
const SETTINGS_KEY = 'inbox';
const DEFAULT_SETTINGS: Settings = {
  autoReply: true,
  workHours: { days: [1, 2, 3, 4, 5, 6, 7], start: '09:00', end: '21:00' },
  slaMinutes: 5,
  handoffText: '收到～已经帮你转给人工客服，马上回复你，请稍等一下。',
  offHoursText: '现在是非工作时间，人工客服工作时间是{hours}，上班后第一时间回复你～可以先说说你的需求（自己吃还是送礼、大概要多少），也可以点主页的留资卡片留下联系方式。',
  diversion: {
    C: '想看实拍和优惠可以点我主页的群聊卡片进群哦～',
    B: '方便的话点我主页的留资卡片留个联系方式，招商同事会尽快联系你。',
  },
};

const InboundSchema = z.object({
  /** 平台消息 ID，用于去重 */
  id: z.string().min(1).max(200),
  /** 工作台里的账号 ID，或平台账号 ID（PlatformAccount.externalId） */
  accountId: z.string().min(1),
  kind: z.enum(['dm', 'comment']).default('dm'),
  userId: z.string().min(1).max(200),
  nickname: z.string().max(100).optional(),
  text: z.string().trim().min(1).max(2000),
  postUrl: z.string().url().optional(),
});
type Inbound = z.infer<typeof InboundSchema>;
const WebhookInput = z.object({ events: z.array(InboundSchema).min(1).max(100) });

const ManualInput = z.object({
  accountId: z.string().min(1, '请选择账号'),
  kind: z.enum(['dm', 'comment']).default('dm'),
  nickname: z.string().trim().min(1, '请填写客户昵称').max(100),
  text: z.string().trim().min(1, '请粘贴客户消息').max(2000),
  postUrl: z.string().trim().url('作品链接格式不对').optional().or(z.literal('').transform(() => undefined)),
});
const ReplyInput = z.object({ text: z.string().trim().min(1, '请填写回复').max(1000) });
const HandoffInput = z.object({ reason: z.string().trim().max(200).optional() });
const StatusInput = z.object({ status: z.enum([ConversationStatus.DIVERTED, ConversationStatus.CLOSED]) });
const ListQuery = z.object({
  status: z.string().optional(),
  accountId: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  q: z.string().optional(),
});

const HANDOFF = {
  human: '客户要求人工',
  biz: 'B 端高意向（询价、起订量、代理合作）',
  negative: '投诉、售后或情绪负面',
  unmatched: 'AI 连续 2 轮没在知识库里找到答案',
  risk: '回复命中风控，没有安全回复',
  manual: '客服手动转人工',
  off: '自动回复已关闭',
};

const convInclude = {
  account: { select: { id: true, name: true, platform: true, audience: true, inboxMode: true } },
  agent: { select: { id: true, name: true } },
} satisfies Prisma.ConversationInclude;

/** 授权服务商的发送接口（M8-1 实时接入）。没配置时，api 模式账号的回复会标记发送失败并提醒客服手动发。 */
@Injectable()
export class ProviderClient {
  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return Boolean(this.config.get('INBOX_PROVIDER_URL'));
  }

  async send(msg: { accountExternalId: string | null; userId: string; kind: string; text: string }) {
    const url = this.config.get<string>('INBOX_PROVIDER_URL');
    if (!url) throw new Error('未配置服务商发送接口 INBOX_PROVIDER_URL');
    const body = JSON.stringify(msg);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hsj-Signature': sign(this.config.get('INBOX_WEBHOOK_SECRET', ''), body) },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`服务商返回 HTTP ${res.status}`);
  }
}

export const sign = (secret: string, body: string | Buffer) => createHmac('sha256', secret).update(body).digest('hex');

/**
 * M8 收件箱：接收私信和咨询评论 → AI 应答（意图识别、知识库检索、发出前风控）→ 按规则转人工 → 客服接管。
 * 一期默认半自动：客服把小红书里的消息贴进来，回复复制回小红书发送；接上授权服务商后走 webhook 实时收发，业务逻辑不变。
 */
@Injectable()
export class InboxService {
  private readonly log = new Logger('Inbox');
  private readonly queue = new JobQueue(2);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly risk: RiskService,
    private readonly notify: NotifyService,
    private readonly provider: ProviderClient,
    private readonly config: ConfigService,
    private readonly leads: LeadsService,
  ) {}

  async idle() {
    await this.queue.idle();
    await this.leads.idle();
  }

  async settings(): Promise<Settings> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...((row?.value as object) ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async saveSettings(s: Settings) {
    await this.prisma.setting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: s }, update: { value: s } });
    return s;
  }

  // ---------- 接收 ----------

  /** 先落库再处理：同一条消息重复推送只处理一次；处理失败的由定时任务重试。 */
  async ingest(channel: 'api' | 'manual', e: Inbound, opts: { wait?: boolean } = {}) {
    const externalId = `${channel}:${e.id}`;
    const existing = await this.prisma.inboundEvent.findUnique({ where: { externalId } });
    if (existing) return { eventId: existing.id, duplicate: true };
    const ev = await this.prisma.inboundEvent
      .create({ data: { channel, externalId, payload: e as unknown as Prisma.InputJsonValue } })
      .catch((err) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
        throw err;
      });
    if (!ev) return { eventId: null, duplicate: true };
    if (opts.wait) await this.process(ev.id);
    else this.queue.push(() => this.process(ev.id));
    return { eventId: ev.id, duplicate: false };
  }

  async process(eventId: string) {
    const ev = await this.prisma.inboundEvent.findUnique({ where: { id: eventId } });
    if (!ev || ev.status === 'done') return;
    try {
      await this.handle(ev.payload as unknown as Inbound, ev.externalId);
      await this.prisma.inboundEvent.update({ where: { id: eventId }, data: { status: 'done', processedAt: new Date(), attempts: { increment: 1 }, error: null } });
    } catch (e) {
      this.log.error(`处理消息 ${ev.externalId} 失败：${(e as Error).message}`);
      await this.prisma.inboundEvent.update({ where: { id: eventId }, data: { status: 'failed', attempts: { increment: 1 }, error: (e as Error).message.slice(0, 500) } });
    }
  }

  private async handle(e: Inbound, externalId: string) {
    const account = await this.prisma.platformAccount.findFirst({ where: { OR: [{ id: e.accountId }, { externalId: e.accountId }] } });
    if (!account) throw new Error(`找不到账号 ${e.accountId}`);
    // 同一位客户的私信和评论分开成两个会话，避免把评论区的公开回复和私信混在一起
    const externalUserId = e.kind === 'comment' ? `comment:${e.userId}` : e.userId;
    const now = new Date();
    let conv = await this.prisma.conversation.upsert({
      where: { accountId_externalUserId: { accountId: account.id, externalUserId } },
      create: { accountId: account.id, externalUserId, nickname: e.nickname, kind: e.kind, sourcePostUrl: e.postUrl, lastMessageAt: now },
      update: { lastMessageAt: now, ...(e.nickname ? { nickname: e.nickname } : {}), ...(e.postUrl ? { sourcePostUrl: e.postUrl } : {}) },
    });
    const msg = await this.prisma.message
      .create({ data: { conversationId: conv.id, sender: 'customer', text: e.text, externalId } })
      .catch((err) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
        throw err;
      });
    if (!msg) return; // 已处理过
    if (conv.status === ConversationStatus.CLOSED || conv.status === ConversationStatus.DIVERTED) {
      conv = await this.prisma.conversation.update({ where: { id: conv.id }, data: { status: ConversationStatus.AI_HANDLING, handoffReason: null, unmatched: 0, agentId: null, waitingSince: null, escalatedAt: null } });
    }
    const s = await this.settings();
    // 先认手机号、收货地址和“确认”：地址要回显给客户核对，不在配送范围的转人工
    // 评论区是公开的，不在评论里回显地址
    const act = await this.leads.onCustomerMessage(conv.id, e.text, conv.status === ConversationStatus.AI_HANDLING && s.autoReply && conv.kind === 'dm').catch((err) => {
      this.log.error(`识别联系方式失败：${(err as Error).message}`);
      return {} as MessageAction;
    });
    if (act.note) await this.prisma.message.create({ data: { conversationId: conv.id, sender: 'system', text: act.note } });
    if (conv.status === ConversationStatus.AI_HANDLING) {
      if (!s.autoReply) await this.handoff(conv.id, HANDOFF.off, s, { silent: true });
      else if (act.handoff) await this.handoff(conv.id, act.handoff, s);
      else if (act.reply) await this.send(conv.id, { sender: 'ai', text: act.reply.text, meta: act.reply.meta });
      else await this.aiRespond(conv.id, e.text, s);
      await this.syncLead(conv.id);
      return;
    }
    if (conv.status === ConversationStatus.AGENT_HANDLING && conv.agentId) {
      const agent = await this.prisma.user.findUnique({ where: { id: conv.agentId } });
      if (agent) await this.notify.toUsers([agent.wecomId], `【新消息】${account.name} · ${conv.nickname ?? '客户'}：${e.text.slice(0, 60)}`);
    }
    await this.syncLead(conv.id);
  }

  /** 有效咨询（中高意向，或要人工、谈合作、投诉）建线索；已有线索同步客群和意向。 */
  private async syncLead(conversationId: string) {
    try {
      const c = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      const valid = c.intent === 'high' || c.intent === 'medium' || [HANDOFF.human, HANDOFF.biz, HANDOFF.negative].includes(c.handoffReason ?? '');
      await this.leads.syncConversation(conversationId, valid);
    } catch (e) {
      this.log.error(`同步线索失败：${(e as Error).message}`);
    }
  }

  // ---------- AI 应答 ----------

  private async knowledge(question: string, audience?: Audience | null) {
    const [faqs, items] = await Promise.all([
      this.prisma.faqItem.findMany({ where: audience ? { OR: [{ audience: null }, { audience }] } : undefined }),
      this.prisma.knowledgeItem.findMany(),
    ]);
    return {
      faqs: bestMatches(question, faqs, (f) => f.question, { take: 3 }).map((m) => m.item),
      facts: bestMatches(question, items.filter((i) => i.kind !== 'compliance'), (i) => `${i.title}${i.content}`, { min: 0.2, take: 3 }).map((m) => m.item),
      rules: items.filter((i) => i.kind === 'compliance').map((i) => ({ avoid: i.title, instead: i.content.replace(/^改为[:：]\s*/, '').slice(0, 200) })),
    };
  }

  private async history(conversationId: string, take = 12): Promise<ChatTurn[]> {
    const rows = await this.prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take });
    return rows.reverse().map((m) => ({ sender: m.sender, text: m.text }));
  }

  private async aiRespond(conversationId: string, text: string, s: Settings) {
    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: convInclude });
    const kb = await this.knowledge(text, conv.audience);
    const history = (await this.history(conversationId)).slice(0, -1); // 去掉刚收到的这条
    const input = {
      platformName: PLATFORM_NAME[conv.account.platform],
      accountAudience: conv.account.audience,
      history,
      message: text,
      kind: conv.kind as 'dm' | 'comment',
      faqs: kb.faqs.map((f) => ({ question: f.question, answer: f.answer })),
      facts: kb.facts.map((f) => ({ title: f.title, content: f.content.slice(0, 300) })),
      rules: kb.rules,
      diversion: s.diversion,
      privacyNotice: (await this.leads.settings()).privacyNotice,
    };
    let out: InboxReplyOut;
    let callId: string;
    try {
      const r = await this.ai.run(inboxReply, input, { refType: 'conversation', refId: conversationId, check: (o) => ([...(o as InboxReplyOut).reply].length > 200 ? ['回复超过 200 字，请缩短'] : []) });
      out = r.output;
      callId = r.callId;
    } catch (e) {
      // 模型不可用时不让客户干等：转人工
      this.log.error(`AI 应答失败：${(e as Error).message}`);
      await this.handoff(conversationId, `AI 应答失败：${(e as Error).message.slice(0, 80)}`, s);
      return;
    }

    // 发出前风控；拦截时带上命中词重写一次，仍不行就转人工
    let check = await this.risk.check({ text: out.reply, platform: conv.account.platform, source: 'reply', sourceId: conversationId });
    let blockedText: string | null = null;
    if (check.blocked) {
      blockedText = out.reply;
      const words = [...new Set(check.hits.filter((h) => h.level === 'block').map((h) => h.matched))];
      try {
        const r2 = await this.ai.run(inboxReply, { ...input, rules: [...(input.rules ?? []), ...words.map((w) => ({ avoid: w, instead: '换成合规的说法，或不提' }))] }, { refType: 'conversation', refId: conversationId });
        const c2 = await this.risk.check({ text: r2.output.reply, platform: conv.account.platform, source: 'reply', sourceId: conversationId });
        if (!c2.blocked) {
          out = { ...out, reply: r2.output.reply };
          callId = r2.callId;
          check = c2;
        }
      } catch {
        /* 重写失败按拦截处理 */
      }
    }

    const unmatched = out.matched ? 0 : conv.unmatched + 1;
    const reason = out.wantsHuman
      ? HANDOFF.human
      : out.bizDeal && out.audience !== 'C'
        ? HANDOFF.biz
        : out.negative
          ? HANDOFF.negative
          : check.blocked
            ? HANDOFF.risk
            : unmatched >= 2
              ? HANDOFF.unmatched
              : null;
    const meta = {
      audience: out.audience,
      intent: out.intent,
      matched: out.matched,
      faqIds: kb.faqs.map((f) => f.id),
      ...(reason ? { handoff: reason, aiReply: check.blocked ? null : out.reply } : {}),
      ...(check.hits.length ? { riskWords: check.hits.map((h) => h.matched) } : {}),
    };
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { unmatched, intent: out.intent, ...(out.audience !== 'unknown' ? { audience: out.audience } : {}) },
    });
    if (reason) {
      await this.handoff(conversationId, reason, s, { meta, blockedText, callId });
      return;
    }
    await this.send(conversationId, { sender: 'ai', text: out.reply, meta, blockedText, llmCallId: callId });
  }

  /** 转人工：先给客户一句交代（工作时间“马上回复”，非工作时间告知上班时间并留资），再通知客服。 */
  async handoff(conversationId: string, reason: string, s?: Settings, opts: { meta?: object; blockedText?: string | null; callId?: string; silent?: boolean } = {}) {
    s ??= await this.settings();
    const now = new Date();
    const conv = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: ConversationStatus.WAITING_AGENT, handoffReason: reason, waitingSince: now, escalatedAt: null, agentId: null },
      include: convInclude,
    });
    const work = isWorkTime(now, s.workHours);
    if (!opts.silent) {
      const text = work ? s.handoffText : s.offHoursText.replace('{hours}', workHoursText(s.workHours));
      await this.send(conversationId, { sender: 'ai', text, meta: { ...(opts.meta ?? {}), handoff: reason, offHours: !work }, blockedText: opts.blockedText, llmCallId: opts.callId });
    }
    await this.prisma.message.create({ data: { conversationId, sender: 'system', text: `转人工：${reason}${work ? '' : '（非工作时间，上班后处理）'}` } });
    const roles: Role[] = reason === HANDOFF.biz ? [Role.BIZ, Role.CS] : [Role.CS];
    await this.notify.toRoles(roles, `【待人工】${conv.account.name} · ${conv.nickname ?? '客户'}：${reason}。请到工作台“收件箱”接待${work ? `，${s.slaMinutes} 分钟内响应` : ''}。`);
    await this.summarize(conversationId).catch((e) => this.log.error(`生成客户摘要失败：${(e as Error).message}`));
  }

  /** 客户摘要 + 建议回复，转人工时和客服点“刷新”时生成。 */
  async summarize(conversationId: string) {
    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: convInclude });
    const history = await this.history(conversationId, 30);
    const lastAsk = [...history].reverse().find((t) => t.sender === 'customer')?.text ?? '';
    const kb = await this.knowledge(lastAsk, conv.audience);
    const r = await this.ai.run(
      customerSummary,
      {
        platformName: PLATFORM_NAME[conv.account.platform],
        accountName: conv.account.name,
        sourcePostUrl: conv.sourcePostUrl,
        history,
        faqs: kb.faqs.map((f) => ({ question: f.question, answer: f.answer })),
        facts: kb.facts.map((f) => ({ title: f.title, content: f.content.slice(0, 300) })),
      },
      { refType: 'conversation', refId: conversationId },
    );
    const check = await this.risk.check({ text: r.output.suggestedReply, platform: conv.account.platform });
    const suggestedReply = check.blocked ? null : r.output.suggestedReply;
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { summary: r.output.summary } });
    return { summary: r.output.summary, suggestedReply, blockedWords: check.blocked ? check.hits.filter((h) => h.level === 'block').map((h) => h.matched) : [] };
  }

  // ---------- 发送 ----------

  private async send(conversationId: string, m: { sender: 'ai' | 'agent'; text: string; meta?: object; blockedText?: string | null; llmCallId?: string; authorId?: string }) {
    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { account: true } });
    const api = conv.account.inboxMode === 'api';
    const msg = await this.prisma.message.create({
      data: {
        conversationId,
        sender: m.sender,
        text: m.text,
        meta: m.meta as Prisma.InputJsonValue | undefined,
        blockedText: m.blockedText ?? null,
        llmCallId: m.llmCallId,
        authorId: m.authorId,
        delivery: api ? 'sending' : 'to_send',
      },
    });
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
    if (api) await this.deliver(msg.id);
    return this.prisma.message.findUniqueOrThrow({ where: { id: msg.id } });
  }

  private async deliver(messageId: string) {
    const msg = await this.prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: { conversation: { include: { account: true } } } });
    const c = msg.conversation;
    try {
      await this.provider.send({
        accountExternalId: c.account.externalId,
        userId: c.externalUserId.replace(/^comment:/, ''),
        kind: c.kind,
        text: msg.text,
      });
      await this.prisma.message.update({ where: { id: messageId }, data: { delivery: 'sent' } });
    } catch (e) {
      this.log.error(`回复发送失败：${(e as Error).message}`);
      await this.prisma.message.update({ where: { id: messageId }, data: { delivery: 'failed' } });
    }
  }

  // ---------- 客服操作 ----------

  private async conv(id: string) {
    const c = await this.prisma.conversation.findUnique({ where: { id }, include: convInclude });
    if (!c) throw new NotFoundException('会话不存在');
    return c;
  }

  async list(q: z.infer<typeof ListQuery>, me: AuthUser) {
    const statuses = q.status?.split(',').filter((s): s is ConversationStatus => s in ConversationStatus);
    const rows = await this.prisma.conversation.findMany({
      where: {
        ...(statuses?.length ? { status: { in: statuses } } : {}),
        ...(q.accountId ? { accountId: q.accountId } : {}),
        ...(q.mine ? { agentId: me.id } : {}),
        ...(q.q ? { OR: [{ nickname: { contains: q.q, mode: 'insensitive' } }, { messages: { some: { text: { contains: q.q, mode: 'insensitive' } } } }] } : {}),
      },
      include: { ...convInclude, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
    });
    const counts = await this.prisma.conversation.groupBy({ by: ['status'], _count: true });
    return {
      items: rows.map(({ messages, ...c }) => ({ ...c, last: messages[0] ?? null })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    };
  }

  async detail(id: string) {
    const c = await this.conv(id);
    const messages = await this.prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(messages.map((m) => m.authorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    const names = new Map(authors.map((a) => [a.id, a.name]));
    const lead = await this.leads.leadForConversation(id);
    return { ...c, lead: lead && { id: lead.id, status: lead.status }, messages: messages.map((m) => ({ ...m, authorName: m.authorId ? names.get(m.authorId) : undefined })) };
  }

  async detailOfMessage(externalId: string) {
    const msg = await this.prisma.message.findUnique({ where: { externalId } });
    if (!msg) throw new BadRequestException('消息处理失败，稍后会自动重试，可以在收件箱里查看');
    return this.detail(msg.conversationId);
  }

  async claim(id: string, me: AuthUser) {
    const c = await this.conv(id);
    if (c.status === ConversationStatus.AGENT_HANDLING && c.agentId && c.agentId !== me.id) throw new ConflictException(`${c.agent?.name ?? '其他客服'}已经在接待了`);
    await this.prisma.conversation.update({ where: { id }, data: { status: ConversationStatus.AGENT_HANDLING, agentId: me.id, waitingSince: null } });
    await this.prisma.message.create({ data: { conversationId: id, sender: 'system', text: `${me.name} 接管了会话` } });
    return this.detail(id);
  }

  /** 客服发回复：先过风控，拦截级不能发。 */
  async reply(id: string, text: string, me: AuthUser) {
    const c = await this.conv(id);
    if (c.status === ConversationStatus.CLOSED) throw new ConflictException('会话已关闭');
    if (c.status === ConversationStatus.AGENT_HANDLING && c.agentId && c.agentId !== me.id) throw new ConflictException(`${c.agent?.name ?? '其他客服'}正在接待这位客户`);
    const check = await this.risk.check({ text, platform: c.account.platform, source: 'reply', sourceId: id });
    if (check.blocked) {
      const words = [...new Set(check.hits.filter((h) => h.level === 'block').map((h) => h.matched))];
      throw new ConflictException({ message: `含拦截级风险词（${words.join('、')}），请修改后再发`, hits: check.hits });
    }
    if (c.status !== ConversationStatus.AGENT_HANDLING || c.agentId !== me.id) await this.claim(id, me);
    await this.send(id, { sender: 'agent', text, authorId: me.id, meta: check.hits.length ? { riskWords: check.hits.map((h) => h.matched) } : undefined });
    return this.detail(id);
  }

  /** 交还 AI 继续接待。 */
  async release(id: string, me: AuthUser) {
    await this.conv(id);
    await this.prisma.conversation.update({ where: { id }, data: { status: ConversationStatus.AI_HANDLING, agentId: null, waitingSince: null, escalatedAt: null, handoffReason: null, unmatched: 0 } });
    await this.prisma.message.create({ data: { conversationId: id, sender: 'system', text: `${me.name} 把会话交还给 AI 接待` } });
    return this.detail(id);
  }

  async setStatus(id: string, status: 'DIVERTED' | 'CLOSED', me: AuthUser) {
    await this.conv(id);
    await this.prisma.conversation.update({ where: { id }, data: { status, waitingSince: null } });
    await this.prisma.message.create({ data: { conversationId: id, sender: 'system', text: `${me.name} 标记为${status === 'DIVERTED' ? '已引流' : '已关闭'}` } });
    return this.detail(id);
  }

  /** 半自动模式：客服已把这条回复复制到小红书发出去。 */
  async markSent(messageId: string) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    if (m.delivery !== 'to_send' && m.delivery !== 'failed') throw new ConflictException('这条消息不需要手动发送');
    return this.prisma.message.update({ where: { id: messageId }, data: { delivery: 'sent' } });
  }

  // ---------- 定时任务 ----------

  private get cronOn() {
    return this.config.get('CRON_ENABLED', 'true') !== 'false';
  }

  /** 每分钟：重试处理失败的消息（最多 5 次）、重发失败的回复（最多 3 次）、转人工超时升级。 */
  @Cron('30 * * * * *', { name: 'inbox-tick' })
  async tick(now = new Date(), force = false) {
    if (!force && !this.cronOn) return { retried: 0, escalated: 0 };
    const events = await this.prisma.inboundEvent.findMany({
      where: { channel: { in: ['api', 'manual'] }, status: { in: ['pending', 'failed'] }, attempts: { lt: 5 }, createdAt: { lte: new Date(now.getTime() - 60_000) } },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    for (const ev of events) await this.process(ev.id);

    const failed = await this.prisma.message.findMany({ where: { delivery: 'failed', createdAt: { gte: new Date(now.getTime() - 3600_000) } }, take: 50 });
    for (const m of failed) {
      const tries = ((m.meta as { sendTries?: number } | null)?.sendTries ?? 0) + 1;
      if (tries > 3) continue;
      await this.prisma.message.update({ where: { id: m.id }, data: { meta: { ...((m.meta as object) ?? {}), sendTries: tries } } });
      await this.deliver(m.id);
    }

    const s = await this.settings();
    let escalated = 0;
    const waiting = await this.prisma.conversation.findMany({ where: { status: ConversationStatus.WAITING_AGENT, escalatedAt: null, waitingSince: { not: null } }, include: convInclude });
    for (const c of waiting) {
      const mins = workMinutesBetween(c.waitingSince!, now, s.workHours);
      if (mins < s.slaMinutes) continue;
      await this.notify.toRoles([Role.CS, Role.ADMIN], `【超时未接待】${c.account.name} · ${c.nickname ?? '客户'} 已等待 ${mins} 分钟（${c.handoffReason ?? '待人工'}），请尽快接待。`);
      await this.prisma.conversation.update({ where: { id: c.id }, data: { escalatedAt: now } });
      escalated++;
    }
    return { retried: events.length, escalated };
  }

  verifySignature(raw: Buffer | undefined, signature: string | undefined) {
    const secret = this.config.get<string>('INBOX_WEBHOOK_SECRET');
    if (!secret) throw new ServiceUnavailableException('未配置 INBOX_WEBHOOK_SECRET，消息接收接口未启用');
    if (!raw || !signature) throw new UnauthorizedException('缺少签名');
    const want = Buffer.from(sign(secret, raw));
    const got = Buffer.from(signature);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new UnauthorizedException('签名不对');
  }
}

const AGENTS = [Role.CS, Role.BIZ];

@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  /** 授权服务商推送消息（实时接入）。请求体用 INBOX_WEBHOOK_SECRET 做 HMAC-SHA256，放在 X-Hsj-Signature 头里。 */
  @Public()
  @Post('webhook')
  async webhook(@Req() req: { rawBody?: Buffer }, @Headers('x-hsj-signature') signature: string | undefined, @Body() body: unknown) {
    this.inbox.verifySignature(req.rawBody, signature);
    const parsed = WebhookInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
    let accepted = 0;
    for (const e of parsed.data.events) if (!(await this.inbox.ingest('api', e)).duplicate) accepted++;
    return { received: parsed.data.events.length, accepted };
  }

  /** 半自动：客服把小红书里的私信或评论贴进来，AI 马上给出回复。 */
  @Post('manual')
  @Roles(...AGENTS)
  async manual(@Body(new ZodPipe(ManualInput)) body: z.infer<typeof ManualInput>) {
    const id = randomUUID();
    await this.inbox.ingest('manual', { id, accountId: body.accountId, kind: body.kind, userId: `manual:${body.nickname}`, nickname: body.nickname, text: body.text, postUrl: body.postUrl }, { wait: true });
    return this.inbox.detailOfMessage(`manual:${id}`);
  }

  @Get('settings')
  settings() {
    return this.inbox.settings();
  }

  @Put('settings')
  @Roles(Role.ADMIN)
  saveSettings(@Body(new ZodPipe(SettingsSchema)) body: Settings) {
    return this.inbox.saveSettings(body);
  }

  @Get('conversations')
  @Roles(...AGENTS, Role.VIEWER)
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>, @CurrentUser() me: AuthUser) {
    return this.inbox.list(q, me);
  }

  @Get('conversations/:id')
  @Roles(...AGENTS, Role.VIEWER)
  detail(@Param('id') id: string) {
    return this.inbox.detail(id);
  }

  @Post('conversations/:id/claim')
  @Roles(...AGENTS)
  claim(@Param('id') id: string, @CurrentUser() me: AuthUser) {
    return this.inbox.claim(id, me);
  }

  @Post('conversations/:id/messages')
  @Roles(...AGENTS)
  reply(@Param('id') id: string, @Body(new ZodPipe(ReplyInput)) body: z.infer<typeof ReplyInput>, @CurrentUser() me: AuthUser) {
    return this.inbox.reply(id, body.text, me);
  }

  @Post('conversations/:id/summary')
  @Roles(...AGENTS)
  summary(@Param('id') id: string) {
    return this.inbox.summarize(id);
  }

  @Post('conversations/:id/handoff')
  @Roles(...AGENTS)
  async handoff(@Param('id') id: string, @Body(new ZodPipe(HandoffInput)) body: z.infer<typeof HandoffInput>) {
    await this.inbox.handoff(id, body.reason || HANDOFF.manual, undefined, { silent: true });
    return this.inbox.detail(id);
  }

  @Post('conversations/:id/release')
  @Roles(...AGENTS)
  release(@Param('id') id: string, @CurrentUser() me: AuthUser) {
    return this.inbox.release(id, me);
  }

  @Post('conversations/:id/status')
  @Roles(...AGENTS)
  setStatus(@Param('id') id: string, @Body(new ZodPipe(StatusInput)) body: z.infer<typeof StatusInput>, @CurrentUser() me: AuthUser) {
    return this.inbox.setStatus(id, body.status, me);
  }

  @Patch('messages/:id/sent')
  @Roles(...AGENTS)
  markSent(@Param('id') id: string) {
    return this.inbox.markSent(id);
  }
}

@Module({ imports: [RiskModule, LeadsModule], providers: [InboxService, ProviderClient], controllers: [InboxController], exports: [InboxService] })
export class InboxModule {}
