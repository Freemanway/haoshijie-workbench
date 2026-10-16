import { Body, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { Audience, Platform, Role } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

const AccountInput = z.object({
  platform: z.nativeEnum(Platform),
  name: z.string().min(1, '请填写账号名称'),
  audience: z.nativeEnum(Audience),
  externalId: z.string().optional(),
  dailyPostCap: z.number().int().min(1).max(20).default(2),
});

/** M1-3 平台账号绑定：一期小红书多账号，每个账号对应客群和每日发布上限。 */
@Controller('accounts')
class AccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.prisma.platformAccount.findMany({ orderBy: { createdAt: 'asc' } });
  }

  @Roles(Role.ADMIN)
  @Post()
  async create(@CurrentUser() me: AuthUser, @Body(new ZodPipe(AccountInput)) body: z.infer<typeof AccountInput>) {
    const account = await this.prisma.platformAccount.create({ data: body });
    await this.audit.log(me.id, 'account.create', account.id, { platform: body.platform, name: body.name });
    return account;
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodPipe(AccountInput.partial())) body: Partial<z.infer<typeof AccountInput>>,
  ) {
    const account = await this.prisma.platformAccount.update({ where: { id }, data: body });
    await this.audit.log(me.id, 'account.update', id, body);
    return account;
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  async remove(@CurrentUser() me: AuthUser, @Param('id') id: string) {
    await this.prisma.platformAccount.delete({ where: { id } });
    await this.audit.log(me.id, 'account.delete', id);
    return { ok: true };
  }
}

@Module({ controllers: [AccountsController] })
export class AccountsModule {}
