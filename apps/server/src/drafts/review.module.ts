import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { draftText } from '@hsj/shared';
import { DraftStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { NotifyService } from '../wecom/wecom.module';
import { DraftsModule, DraftsService, VersionInput } from './drafts.module';

const NoteInput = z.object({ note: z.string().trim().max(500).optional() });
const RejectInput = z.object({ reason: z.string().trim().min(1, '驳回必须填写原因').max(500) });
const CommentInput = z.object({ note: z.string().trim().min(1, '请填写批注').max(500), versionId: z.string().optional() });
const BatchInput = z.object({ ids: z.array(z.string()).min(1, '至少选择一篇稿件').max(100) });

/**
 * M6 审核流：草稿 → 待审核 → 已通过 / 驳回。
 * 拦截级风险词的稿件不能提交也不能通过；每一步都写审核记录（谁、什么时候、改了什么）。
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: DraftsService,
    private readonly notify: NotifyService,
  ) {}

  private async load(id: string) {
    const draft = await this.prisma.draft.findUnique({ where: { id }, include: { topic: { select: { title: true } } } });
    if (!draft) throw new NotFoundException('稿件不存在');
    return draft;
  }

  private log(draftId: string, reviewerId: string, action: string, extra: { note?: string | null; before?: string; after?: string; versionId?: string } = {}) {
    return this.prisma.reviewLog.create({ data: { draftId, reviewerId, action, ...extra } });
  }

  /** 采用版本不能含拦截词。 */
  private async assertClean(id: string) {
    const c = await this.drafts.chosenCheck(id);
    if (!c) throw new BadRequestException('还没有采用的版本');
    if (c.blocked) throw new ConflictException(`含拦截级风险词（${[...new Set(c.blockedWords)].join('、')}），请先修改`);
    return c;
  }

  async submit(id: string, me: AuthUser) {
    const draft = await this.load(id);
    if (draft.status !== DraftStatus.DRAFT && draft.status !== DraftStatus.REJECTED) throw new ConflictException('只有草稿或被驳回的稿件可以提交审核');
    const c = await this.assertClean(id);
    await this.prisma.draft.update({ where: { id }, data: { status: DraftStatus.PENDING_REVIEW } });
    await this.log(id, me.id, 'submit', { versionId: c.version.id, note: c.problems.length ? `提交时仍有规格问题：${c.problems.join('；')}` : null });
    await this.notify.toRoles([Role.REVIEWER], `【待审核】${me.name} 提交了稿件《${draft.topic.title}》，请到工作台“稿件”里审核。`);
    return { ok: true };
  }

  async withdraw(id: string, me: AuthUser) {
    const draft = await this.load(id);
    if (draft.status !== DraftStatus.PENDING_REVIEW) throw new ConflictException('只有待审核的稿件可以撤回');
    await this.prisma.draft.update({ where: { id }, data: { status: DraftStatus.DRAFT } });
    await this.log(id, me.id, 'withdraw');
    return { ok: true };
  }

  async approve(id: string, me: AuthUser, note?: string) {
    const draft = await this.load(id);
    if (draft.status !== DraftStatus.PENDING_REVIEW) throw new ConflictException('只有待审核的稿件可以通过');
    const c = await this.assertClean(id);
    await this.prisma.draft.update({ where: { id }, data: { status: DraftStatus.APPROVED, rejectReason: null } });
    await this.log(id, me.id, 'approve', { versionId: c.version.id, note });
    return { ok: true };
  }

  async reject(id: string, me: AuthUser, reason: string) {
    const draft = await this.load(id);
    if (draft.status !== DraftStatus.PENDING_REVIEW) throw new ConflictException('只有待审核的稿件可以驳回');
    const chosen = await this.prisma.draftVersion.findFirst({ where: { draftId: id, chosen: true } });
    await this.prisma.draft.update({ where: { id }, data: { status: DraftStatus.REJECTED, rejectReason: reason } });
    await this.log(id, me.id, 'reject', { note: reason, versionId: chosen?.id });
    await this.notify.toRoles([Role.CONTENT], `【驳回】稿件《${draft.topic.title}》被 ${me.name} 驳回：${reason}。可以在工作台里一键让 AI 按原因重写。`);
    return { ok: true };
  }

  async comment(id: string, me: AuthUser, note: string, versionId?: string) {
    await this.load(id);
    return this.log(id, me.id, 'comment', { note, versionId });
  }

  /** 审核人直接改稿：生成新版本并记录修改前后。 */
  async edit(id: string, versionId: string, input: z.infer<typeof VersionInput>, me: AuthUser) {
    const { base, version } = await this.drafts.editVersion(id, versionId, input, { statuses: [DraftStatus.PENDING_REVIEW], by: '审核人' });
    await this.log(id, me.id, 'edit', { versionId: version.id, before: draftText(base), after: draftText(version) });
    return version;
  }

  /** 批量通过：逐篇检查，含拦截词或状态不对的跳过并说明原因。 */
  async batchApprove(ids: string[], me: AuthUser) {
    const results: { id: string; ok: boolean; reason?: string }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        await this.approve(id, me);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, reason: (e as Error).message });
      }
    }
    return { approved: results.filter((r) => r.ok).length, results };
  }
}

@Controller('drafts')
class ReviewController {
  constructor(
    private readonly review: ReviewService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(Role.REVIEWER)
  @Post('batch-approve')
  batch(@CurrentUser() me: AuthUser, @Body(new ZodPipe(BatchInput)) body: z.infer<typeof BatchInput>) {
    return this.review.batchApprove(body.ids, me);
  }

  @Get(':id/reviews')
  reviews(@Param('id') id: string) {
    return this.prisma.reviewLog.findMany({
      where: { draftId: id },
      include: { reviewer: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Roles(Role.CONTENT)
  @Post(':id/submit')
  submit(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.review.submit(id, me);
  }

  @Roles(Role.CONTENT)
  @Post(':id/withdraw')
  withdraw(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.review.withdraw(id, me);
  }

  @Roles(Role.REVIEWER)
  @Post(':id/approve')
  approve(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(NoteInput)) body: z.infer<typeof NoteInput>) {
    return this.review.approve(id, me, body.note);
  }

  @Roles(Role.REVIEWER)
  @Post(':id/reject')
  reject(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(RejectInput)) body: z.infer<typeof RejectInput>) {
    return this.review.reject(id, me, body.reason);
  }

  @Roles(Role.REVIEWER, Role.CONTENT)
  @Post(':id/comments')
  comment(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(CommentInput)) body: z.infer<typeof CommentInput>) {
    return this.review.comment(id, me, body.note, body.versionId);
  }

  @Roles(Role.REVIEWER)
  @Patch(':id/review-versions/:versionId')
  edit(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body(new ZodPipe(VersionInput)) body: z.infer<typeof VersionInput>,
  ) {
    return this.review.edit(id, versionId, body, me);
  }
}

@Module({ imports: [DraftsModule], controllers: [ReviewController], providers: [ReviewService] })
export class ReviewModule {}
