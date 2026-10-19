import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
  Body,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { AuthUser, CurrentUser, IS_PUBLIC, Public, ROLES } from '../common/auth.decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { WecomClient } from '../wecom/wecom.client';

const TOKEN_TTL = '12h';

/** 全局守卫：校验登录令牌并按 @Roles 检查角色。每次请求都回查成员，停用或改角色立即生效。 */
@Injectable()
class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('请先登录');

    let sub: string;
    try {
      sub = (await this.jwt.verifyAsync<{ sub: string }>(token)).sub;
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    const user = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!user?.active) throw new UnauthorizedException('账号已停用');
    req.user = { id: user.id, name: user.name, roles: user.roles } satisfies AuthUser;

    const need = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (!need?.length || user.roles.includes(Role.ADMIN) || need.some((r) => user.roles.includes(r))) return true;
    throw new ForbiddenException('当前角色没有这个权限');
  }
}

@Controller('auth')
class AuthController {
  private readonly states = new Map<string, number>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly wecom: WecomClient,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** 前端据此决定显示哪种登录方式。 */
  @Public()
  @Get('options')
  options() {
    return { wecom: this.wecom.enabled, devLogin: this.devLoginEnabled };
  }

  /** 跳转到企业微信扫码页。 */
  @Public()
  @Get('wecom/login')
  wecomLogin(@Res() res: Response) {
    if (!this.wecom.enabled) throw new NotFoundException('未配置企业微信登录');
    const state = randomBytes(12).toString('hex');
    this.states.set(state, Date.now() + 10 * 60_000);
    res.redirect(this.wecom.loginUrl(`${this.apiOrigin}/api/auth/wecom/callback`, state));
  }

  /** 企业微信回调：只允许管理员已添加的成员登录，令牌放在 URL 片段里交给前端。 */
  @Public()
  @Get('wecom/callback')
  async wecomCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const exp = this.states.get(state);
    this.states.delete(state);
    if (!exp || exp < Date.now()) throw new UnauthorizedException('登录链接已失效，请重新扫码');
    const wecomId = await this.wecom.userIdByCode(code);
    const user = await this.prisma.user.findUnique({ where: { wecomId } });
    if (!user?.active) throw new ForbiddenException('你还没有被添加为工作台成员，请联系管理员');
    const token = await this.issue(user.id);
    await this.audit.log(user.id, 'auth.login', user.id, { via: 'wecom' });
    res.redirect(`${this.webOrigin}/login#token=${token}`);
  }

  /** 开发环境登录：AUTH_DEV_LOGIN=true 时可直接以某个成员身份登录，生产环境必须关闭。 */
  @Public()
  @Post('dev-login')
  async devLogin(@Body(new ZodPipe(z.object({ wecomId: z.string().min(1) }))) body: { wecomId: string }) {
    if (!this.devLoginEnabled) throw new NotFoundException();
    const user = await this.prisma.user.findUnique({ where: { wecomId: body.wecomId } });
    if (!user?.active) throw new UnauthorizedException('没有这个成员');
    return { token: await this.issue(user.id) };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  private issue(userId: string) {
    return this.jwt.signAsync({ sub: userId }, { expiresIn: TOKEN_TTL });
  }

  private get devLoginEnabled() {
    return this.config.get('AUTH_DEV_LOGIN') === 'true';
  }
  private get webOrigin() {
    return this.config.get('WEB_ORIGIN', 'http://localhost:5173');
  }
  private get apiOrigin() {
    return this.config.get('API_ORIGIN', 'http://localhost:3000');
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_SECRET') }),
    }),
  ],
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
