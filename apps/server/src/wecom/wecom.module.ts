import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WecomClient } from './wecom.client';

/**
 * 站内提醒统一出口：配置了企业微信时推送应用消息，没配置时只写日志。
 * 推送失败不影响业务流程。
 */
@Injectable()
export class NotifyService {
  private readonly log = new Logger('Notify');
  /** 测试里用来检查发了什么 */
  readonly sent: { to: string[]; text: string }[] = [];

  constructor(
    private readonly wecom: WecomClient,
    private readonly prisma: PrismaService,
  ) {}

  /** 发给拥有任一角色的在用成员（管理员不额外打扰）。 */
  async toRoles(roles: Role[], text: string) {
    const users = await this.prisma.user.findMany({ where: { active: true, roles: { hasSome: roles } }, select: { wecomId: true } });
    await this.toUsers(users.map((u) => u.wecomId), text);
  }

  async toUsers(wecomIds: string[], text: string) {
    if (!wecomIds.length) return;
    this.sent.push({ to: wecomIds, text });
    if (this.sent.length > 100) this.sent.shift();
    if (!this.wecom.enabled) {
      this.log.log(`（未配置企业微信，仅记录）→ ${wecomIds.join(',')}：${text}`);
      return;
    }
    try {
      await this.wecom.sendText(wecomIds, text);
    } catch (e) {
      this.log.error(`企业微信提醒发送失败：${(e as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [WecomClient, NotifyService], exports: [WecomClient, NotifyService] })
export class WecomModule {}
