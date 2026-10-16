import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, Roles } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';

const CreateUser = z.object({
  wecomId: z.string().min(1, '请填写企业微信成员账号'),
  name: z.string().min(1, '请填写姓名'),
  roles: z.array(z.nativeEnum(Role)).min(1, '至少选择一个角色'),
});
const UpdateUser = CreateUser.omit({ wecomId: true }).partial().extend({ active: z.boolean().optional() });

/** M1-1 成员管理：只有管理员能增改成员和角色。 */
@Roles(Role.ADMIN)
@Controller('users')
class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  }

  @Post()
  async create(@CurrentUser() me: AuthUser, @Body(new ZodPipe(CreateUser)) body: z.infer<typeof CreateUser>) {
    const user = await this.prisma.user.create({ data: body });
    await this.audit.log(me.id, 'user.create', user.id, { roles: body.roles });
    return user;
  }

  @Patch(':id')
  async update(
    @CurrentUser() me: AuthUser,
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateUser)) body: z.infer<typeof UpdateUser>,
  ) {
    // 防止管理员把自己停用或撤掉管理员角色，导致没人能管理成员
    if (id === me.id && (body.active === false || (body.roles && !body.roles.includes(Role.ADMIN)))) {
      throw new BadRequestException('不能停用自己或撤掉自己的管理员角色');
    }
    const user = await this.prisma.user.update({ where: { id }, data: body });
    await this.audit.log(me.id, 'user.update', id, body);
    return user;
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
