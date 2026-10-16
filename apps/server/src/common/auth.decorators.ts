import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';

/** 不需要登录即可访问（健康检查、登录接口）。 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** 允许访问的角色；管理员总是放行。不加此装饰器表示所有已登录成员都可访问。 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface AuthUser {
  id: string;
  name: string;
  roles: Role[];
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
