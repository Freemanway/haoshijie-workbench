import { BadRequestException, Body, Controller, Delete, Get, Module, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { LeadsModule } from '../leads/leads.module';
import { CommitInput, FileInput, ManualDeal, OrdersService } from './orders.service';

const VIEW = [Role.CS, Role.BIZ, Role.VIEWER];
const HANDLE = [Role.CS, Role.BIZ];

/** M11 成交导入：订单表导入（预览 → 确认映射 → 导入）、人工关联、人工录入成交。 */
@Controller('orders')
class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Roles(...VIEW)
  @Get('fields')
  fields() {
    return this.orders.fields();
  }

  @Roles(Role.CS)
  @Post('import/preview')
  preview(@Body(new ZodPipe(FileInput)) body: FileInput) {
    return this.orders.preview(body);
  }

  @Roles(Role.CS)
  @Post('import')
  commit(@CurrentUser() me: AuthUser, @Body(new ZodPipe(CommitInput)) body: CommitInput) {
    return this.orders.commit(me, body);
  }

  @Roles(...VIEW)
  @Get('imports')
  imports() {
    return this.orders.imports();
  }

  @Roles(Role.ADMIN)
  @Delete('imports/:id')
  removeImport(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.orders.removeImport(me, id);
  }

  @Roles(...HANDLE)
  @Post('manual')
  manual(@CurrentUser() me: AuthUser, @Body(new ZodPipe(ManualDeal)) body: ManualDeal) {
    return this.orders.createManual(me, body);
  }

  @Roles(...VIEW)
  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: Record<string, string>) {
    return this.orders.list(me, q);
  }

  @Roles(...HANDLE)
  @Post(':id/link')
  link(@CurrentUser() me: AuthUser, @Param('id') id: string, @Body() body: { leadId?: string }) {
    if (!body?.leadId) throw new BadRequestException('请选择要关联的线索');
    return this.orders.linkManual(me, id, body.leadId);
  }

  @Roles(...HANDLE)
  @Post(':id/unlink')
  unlink(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.orders.unlink(me, id);
  }

  @Roles(...HANDLE)
  @Post(':id/reveal')
  reveal(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.orders.reveal(me, id);
  }

  @Roles(...HANDLE)
  @Delete(':id')
  remove(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    return this.orders.removeManual(me, id);
  }
}

@Module({ imports: [LeadsModule], controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
