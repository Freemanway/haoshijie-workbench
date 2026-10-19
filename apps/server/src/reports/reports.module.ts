import { Body, Controller, Get, Module, Param, Post, Put, Query, Res } from '@nestjs/common';
import { Platform, Role } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { InboxModule } from '../inbox/inbox.module';
import { BaselineInput, ReportQuery, ReportsService } from './reports.service';

const q = (r: Record<string, string>): ReportQuery => ({ from: r.from, to: r.to, platform: (r.platform || undefined) as Platform | undefined, accountId: r.accountId || undefined });
const GenerateInput = z.object({
  kind: z.enum(['week', 'month']),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  push: z.boolean().default(false),
});

/** M12 数据周报：看板（所有成员可看，只有汇总数字）、周报月报快照、明细导出。 */
@Controller('reports')
class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  dashboard(@Query() query: Record<string, string>) {
    return this.reports.dashboard(q(query));
  }

  @Get('export')
  async export(@CurrentUser() me: AuthUser, @Query() query: Record<string, string>, @Res({ passthrough: true }) res: Response) {
    const buf = await this.reports.exportXlsx(me, q(query));
    const name = `数据明细-${query.from}至${query.to}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.end(buf);
  }

  @Get('baseline')
  baseline() {
    return this.reports.baseline();
  }

  @Roles(Role.ADMIN)
  @Put('baseline')
  saveBaseline(@CurrentUser() me: AuthUser, @Body(new ZodPipe(BaselineInput)) b: BaselineInput) {
    return this.reports.saveBaseline(me, b);
  }

  @Get()
  list() {
    return this.reports.list();
  }

  @Roles(Role.ADMIN)
  @Post('generate')
  generate(@CurrentUser() me: AuthUser, @Body(new ZodPipe(GenerateInput)) b: z.infer<typeof GenerateInput>) {
    const period = b.from && b.to ? { from: b.from, to: b.to } : this.reports.lastPeriod(b.kind);
    return this.reports.generate(b.kind, period, { push: b.push, userId: me.id });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.reports.get(id);
  }
}

@Module({ imports: [InboxModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
