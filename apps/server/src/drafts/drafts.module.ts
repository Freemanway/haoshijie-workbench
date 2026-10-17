import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  OnApplicationShutdown,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { checkXhsDraft } from '@hsj/shared';
import { DraftStatus, Platform, Role, Topic } from '@prisma/client';
import { z } from 'zod';
import { AiService } from '../ai/ai.module';
import { DraftTopic, REWRITE_MODES, rewrite, RewriteMode, xhsDraft, XhsVersion } from '../ai/prompts';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { RiskModule, RiskService } from '../risk/risk.module';
import { JobQueue } from './job-queue';

/** 可以改稿的状态；进入审核后由审核人处理（M6）。 */
const EDITABLE: DraftStatus[] = [DraftStatus.DRAFT, DraftStatus.REJECTED];

const VersionInput = z.object({
  title: z.string().trim().min(1, '请填写标题'),
  body: z.string().trim().min(1, '请填写正文'),
  tags: z.array(z.string().trim().min(1)).default([]),
  coverPrompt: z.string().default(''),
  imageTips: z.array(z.string().trim().min(1)).default([]),
});
const RewriteInput = z.object({
  versionId: z.string().optional(),
  mode: z.enum(Object.keys(REWRITE_MODES) as [RewriteMode, ...RewriteMode[]]),
  instruction: z.string().trim().max(500).optional(),
});
const GenerateInput = z.object({
  topicId: z.string().min(1),
  versions: z.number().int().min(1).max(4).default(2),
});

const toDraftTopic = (t: Topic): DraftTopic => ({
  title: t.title,
  audience: t.audience,
  category: t.category,
  seasonTag: t.seasonTag,
  reason: t.reason,
});
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

@Injectable()
export class DraftsService implements OnApplicationShutdown {
  private readonly queue = new JobQueue(2);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly risk: RiskService,
  ) {}

  /** 等后台生成任务全部完成。 */
  idle() {
    return this.queue.idle();
  }

  async onApplicationShutdown() {
    await this.queue.idle();
  }

  /** 为选题建一个小红书稿件，后台生成多个版本（默认 2 个）。 */
  async generate(topicId: string, versions = 2, userId?: string) {
    const topic = await this.prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic) throw new NotFoundException('选题不存在');
    const draft = await this.prisma.draft.create({ data: { topicId, platform: Platform.XHS, status: DraftStatus.GENERATING } });
    this.queue.push(() => this.runGeneration(draft.id, topic, versions, userId));
    return draft;
  }

  async retry(id: string, userId?: string) {
    const draft = await this.prisma.draft.findUnique({ where: { id }, include: { topic: true } });
    if (!draft) throw new NotFoundException('稿件不存在');
    if (draft.status !== DraftStatus.GENERATE_FAILED) throw new ConflictException('只有生成失败的稿件可以重试');
    await this.prisma.draft.update({ where: { id }, data: { status: DraftStatus.GENERATING, error: null } });
    this.queue.push(() => this.runGeneration(id, draft.topic, 2, userId));
    return { ok: true };
  }

  /** 品牌知识库是唯一事实依据：知识条目 + 适用客群的 FAQ；合规口径单独作为改写规则。 */
  private async facts(audience: Topic['audience']) {
    const [items, faqs] = await Promise.all([
      this.prisma.knowledgeItem.findMany({ orderBy: { kind: 'asc' }, take: 60 }),
      this.prisma.faqItem.findMany({ where: { OR: [{ audience: null }, { audience }] }, take: 15 }),
    ]);
    return {
      facts: [
        ...items.filter((i) => i.kind !== 'compliance').map((i) => ({ title: i.title, content: clip(i.content, 300) })),
        ...faqs.map((f) => ({ title: f.question, content: clip(f.answer, 300) })),
      ],
      rules: items.filter((i) => i.kind === 'compliance').map((i) => ({ avoid: i.title, instead: clip(i.content.replace(/^改为[:：]\s*/, ''), 200) })),
    };
  }

  private async runGeneration(draftId: string, topic: Topic, versions: number, userId?: string) {
    try {
      const kb = await this.facts(topic.audience);
      const res = await this.ai.run(
        xhsDraft,
        { topic: toDraftTopic(topic), ...kb, versions },
        {
          userId,
          refType: 'draft',
          refId: draftId,
          check: (o) => {
            const out = o as { versions: XhsVersion[] };
            const p = out.versions.flatMap((v, i) => checkXhsDraft(v).map((x) => `版本${i + 1}${x}`));
            if (out.versions.length < versions) p.push(`只写了 ${out.versions.length} 个版本，需要 ${versions} 个`);
            return p;
          },
        },
      );
      const list = res.output.versions.slice(0, versions);
      for (const [i, v] of list.entries()) {
        await this.saveVersion(draftId, i + 1, v, { chosen: i === 0, modelName: res.model, note: '首次生成', llmCallId: res.callId });
      }
      await this.prisma.draft.update({ where: { id: draftId }, data: { status: DraftStatus.DRAFT, error: null } });
    } catch (e) {
      await this.prisma.draft.update({
        where: { id: draftId },
        data: { status: DraftStatus.GENERATE_FAILED, error: (e as Error).message.slice(0, 500) },
      });
    }
  }

  private async saveVersion(
    draftId: string,
    index: number,
    v: XhsVersion,
    meta: { chosen: boolean; modelName: string | null; note: string; llmCallId?: string },
  ) {
    if (meta.chosen) await this.prisma.draftVersion.updateMany({ where: { draftId }, data: { chosen: false } });
    const version = await this.prisma.draftVersion.create({
      data: { draftId, index, title: v.title, body: v.body, tags: v.tags, coverPrompt: v.coverPrompt, imageTips: v.imageTips, ...meta },
    });
    // 记录命中日志，用于每周高频风险词汇总
    await this.risk.check({ text: [v.title, v.body, v.tags.join(' ')].join('\n'), platform: Platform.XHS, source: 'draft', sourceId: version.id });
    return version;
  }

  private async editable(id: string) {
    const draft = await this.prisma.draft.findUnique({
      where: { id },
      include: { topic: true, versions: { orderBy: { index: 'asc' } } },
    });
    if (!draft) throw new NotFoundException('稿件不存在');
    if (!EDITABLE.includes(draft.status)) throw new ConflictException('当前状态不能修改稿件');
    return draft;
  }

  async editVersion(id: string, versionId: string, input: z.infer<typeof VersionInput>) {
    const draft = await this.editable(id);
    if (!draft.versions.some((v) => v.id === versionId)) throw new NotFoundException('版本不存在');
    const index = draft.versions.length + 1;
    return this.saveVersion(id, index, { ...input }, { chosen: true, modelName: null, note: `人工修改（基于版本 ${draft.versions.find((v) => v.id === versionId)!.index}）` });
  }

  async rewrite(id: string, input: z.infer<typeof RewriteInput>, userId: string) {
    const draft = await this.editable(id);
    const base = draft.versions.find((v) => (input.versionId ? v.id === input.versionId : v.chosen)) ?? draft.versions.at(-1);
    if (!base) throw new BadRequestException('还没有可改写的版本');
    if ((input.mode === 'tone' || input.mode === 'reject_reason') && !input.instruction) {
      throw new BadRequestException(input.mode === 'tone' ? '请填写想要的语气' : '请填写驳回原因');
    }
    const res = await this.ai.run(
      rewrite,
      {
        topic: toDraftTopic(draft.topic),
        draft: { title: base.title, body: base.body, tags: base.tags, coverPrompt: base.coverPrompt ?? '', imageTips: base.imageTips },
        mode: input.mode,
        instruction: input.instruction,
        ...(await this.facts(draft.topic.audience)),
      },
      { userId, refType: 'draft', refId: id, check: (o) => checkXhsDraft(o as XhsVersion) },
    );
    const note = `${REWRITE_MODES[input.mode]}（基于版本 ${base.index}）${input.instruction ? `：${input.instruction}` : ''}`;
    return this.saveVersion(id, draft.versions.length + 1, res.output, { chosen: true, modelName: res.model, note, llmCallId: res.callId });
  }

  async choose(id: string, versionId: string) {
    const draft = await this.editable(id);
    if (!draft.versions.some((v) => v.id === versionId)) throw new NotFoundException('版本不存在');
    await this.prisma.$transaction([
      this.prisma.draftVersion.updateMany({ where: { draftId: id }, data: { chosen: false } }),
      this.prisma.draftVersion.update({ where: { id: versionId }, data: { chosen: true } }),
    ]);
    return { ok: true };
  }

  /** 稿件详情：每个版本带风控结果（标题、正文、标签分别检测，便于高亮）和规格检查，另附推荐素材。 */
  async detail(id: string) {
    const draft = await this.prisma.draft.findUnique({
      where: { id },
      include: { topic: true, versions: { orderBy: { index: 'desc' } } },
    });
    if (!draft) throw new NotFoundException('稿件不存在');
    const versions = await Promise.all(
      draft.versions.map(async (v) => {
        const [title, body, tags] = await Promise.all(
          [v.title, v.body, v.tags.join(' ')].map((text) => this.risk.check({ text, platform: draft.platform })),
        );
        return { ...v, risk: { blocked: title.blocked || body.blocked || tags.blocked, title: title.hits, body: body.hits, tags: tags.hits }, problems: checkXhsDraft(v) };
      }),
    );
    const chosen = draft.versions.find((v) => v.chosen);
    const wanted = [...new Set([draft.topic.category, draft.topic.seasonTag, ...(chosen?.tags ?? [])].filter((x): x is string => !!x))];
    const assets = wanted.length ? await this.prisma.asset.findMany({ where: { tags: { hasSome: wanted } }, take: 24 }) : [];
    const score = (t: string[]) => t.filter((x) => wanted.includes(x)).length;
    return { ...draft, versions, assets: assets.sort((a, b) => score(b.tags) - score(a.tags)).slice(0, 8) };
  }
}

@Controller('drafts')
class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Query('status') status?: string, @Query('topicId') topicId?: string) {
    const statuses = status?.split(',').filter((s): s is DraftStatus => s in DraftStatus);
    return this.prisma.draft.findMany({
      where: { ...(statuses?.length ? { status: { in: statuses } } : {}), ...(topicId ? { topicId } : {}) },
      include: {
        topic: { select: { id: true, title: true, audience: true, category: true, suggestedDate: true } },
        versions: { where: { chosen: true }, select: { id: true, title: true } },
        _count: { select: { versions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.drafts.detail(id);
  }

  @Roles(Role.CONTENT)
  @Post()
  generate(@CurrentUser() me: AuthUser, @Body(new ZodPipe(GenerateInput)) body: z.infer<typeof GenerateInput>) {
    return this.drafts.generate(body.topicId, body.versions, me.id);
  }

  @Roles(Role.CONTENT)
  @Post(':id/retry')
  retry(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.drafts.retry(id, me.id);
  }

  @Roles(Role.CONTENT, Role.REVIEWER)
  @Post(':id/rewrite')
  rewrite(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(RewriteInput)) body: z.infer<typeof RewriteInput>) {
    return this.drafts.rewrite(id, body, me.id);
  }

  @Roles(Role.CONTENT)
  @Patch(':id/versions/:versionId')
  edit(@Param('id') id: string, @Param('versionId') versionId: string, @Body(new ZodPipe(VersionInput)) body: z.infer<typeof VersionInput>) {
    return this.drafts.editVersion(id, versionId, body);
  }

  @Roles(Role.CONTENT)
  @Post(':id/versions/:versionId/choose')
  choose(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.drafts.choose(id, versionId);
  }
}

@Module({ imports: [RiskModule], controllers: [DraftsController], providers: [DraftsService], exports: [DraftsService] })
export class DraftsModule {}
