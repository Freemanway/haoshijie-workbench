import { BadRequestException, Body, Controller, Delete, Get, Module, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { LeadStatus, Role } from '@prisma/client';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { AddressInput, LeadCreate, LeadPatch, LeadSettings, LeadSettingsSchema, LeadsService } from './leads.service';

const FollowUpInput = z.object({
  note: z.string().trim().min(1, '请填写跟进内容').max(1000),
  nextFollowAt: z.coerce.date().nullable().optional(),
  status: z.nativeEnum(LeadStatus).optional(),
});
const LEAD_ROLES = [Role.CS, Role.BIZ, Role.VIEWER];
const EDITORS = [Role.CS, Role.BIZ];

/** M10 线索库：列表与详情（脱敏）、跟进、地址、分配、导出。 */
@Controller('leads')
class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  /** M10-2 地址智能拆分（按配置的配送范围判断）。 */
  @Post('parse-address')
  async parse(@Body() body: { raw?: string }) {
    if (typeof body?.raw !== 'string' || !body.raw.trim()) throw new BadRequestException('请传入客户发来的地址文本 raw');
    return this.leads.parse(body.raw);
  }

  @Roles(...LEAD_ROLES)
  @Get('settings')
  settings() {
    return this.leads.settings();
  }

  @Roles(Role.ADMIN)
  @Put('settings')
  saveSettings(@CurrentUser() me: AuthUser, @Body(new ZodPipe(LeadSettingsSchema)) body: LeadSettings) {
    return this.leads.saveSettings(me, body);
  }

  /** 明文导出（CSV，Excel 可直接打开），只有管理员。 */
  @Roles(Role.ADMIN)
  @Get('export')
  async export(@CurrentUser() me: AuthUser, @Query('audience') audience: string | undefined, @Res({ passthrough: true }) res: Response) {
    const csv = await this.leads.exportCsv(me, audience);
    const name = `线索-${audience ?? '全部'}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return csv;
  }

  @Roles(...LEAD_ROLES)
  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: Record<string, string>) {
    return this.leads.list(me, q);
  }

  @Roles(...EDITORS)
  @Post()
  create(@CurrentUser() me: AuthUser, @Body(new ZodPipe(LeadCreate)) body: LeadCreate) {
    return this.leads.createManual(me, body);
  }

  @Roles(...LEAD_ROLES)
  @Get(':id')
  detail(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.leads.detail(me, id);
  }

  @Roles(...EDITORS)
  @Patch(':id')
  update(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(LeadPatch)) body: LeadPatch) {
    return this.leads.update(me, id, body);
  }

  @Roles(...EDITORS)
  @Post(':id/reveal')
  reveal(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body() body: { addressId?: string }) {
    return this.leads.reveal(me, id, body?.addressId);
  }

  @Roles(...EDITORS)
  @Post(':id/follow-ups')
  followUp(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(FollowUpInput)) body: z.infer<typeof FollowUpInput>) {
    return this.leads.addFollowUp(me, id, body);
  }

  @Roles(...LEAD_ROLES)
  @Post(':id/script')
  script(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.leads.script(me, id);
  }

  @Roles(...EDITORS)
  @Post(':id/extract')
  extract(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.leads.reExtract(me, id);
  }

  @Roles(Role.ADMIN)
  @Post(':id/merge')
  async merge(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body() body: { otherId?: string }) {
    if (!body?.otherId) throw new BadRequestException('请指定要并进来的线索 otherId');
    await this.leads.merge(id, body.otherId, me);
    return this.leads.detail(me, id);
  }

  @Roles(...EDITORS)
  @Post(':id/addresses')
  addAddress(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body(new ZodPipe(AddressInput)) body: AddressInput) {
    return this.leads.addAddress(me, id, body);
  }

  @Roles(...EDITORS)
  @Post(':id/addresses/import')
  importAddresses(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body() body: { text?: string }) {
    if (typeof body?.text !== 'string' || !body.text.trim()) throw new BadRequestException('请粘贴地址，每行一个');
    return this.leads.importAddresses(me, id, body.text);
  }

  @Roles(...EDITORS)
  @Patch(':id/addresses/:addressId')
  updateAddress(@CurrentUser() me: AuthUser, @Param('id') id: string, @Param('addressId') addressId: string, @Body(new ZodPipe(AddressInput.partial())) body: Partial<AddressInput>) {
    return this.leads.updateAddress(me, id, addressId, body);
  }

  @Roles(...EDITORS)
  @Delete(':id/addresses/:addressId')
  removeAddress(@CurrentUser() me: AuthUser, @Param('id') id: string, @Param('addressId') addressId: string) {
    return this.leads.removeAddress(me, id, addressId);
  }
}

@Module({ controllers: [LeadsController], providers: [LeadsService], exports: [LeadsService] })
export class LeadsModule {}
