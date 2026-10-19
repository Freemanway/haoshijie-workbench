import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 企业微信接口：扫码登录、应用消息推送。
 * 文档：https://developer.work.weixin.qq.com/document/path/98152（网页登录）
 *       https://developer.work.weixin.qq.com/document/path/90236（发送应用消息）
 */
@Injectable()
export class WecomClient {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return Boolean(this.config.get('WECOM_CORP_ID') && this.config.get('WECOM_AGENT_ID') && this.config.get('WECOM_SECRET'));
  }

  /** 企业微信扫码登录页地址。 */
  loginUrl(redirectUri: string, state: string) {
    const q = new URLSearchParams({
      login_type: 'CorpApp',
      appid: this.config.getOrThrow('WECOM_CORP_ID'),
      agentid: this.config.getOrThrow('WECOM_AGENT_ID'),
      redirect_uri: redirectUri,
      state,
    });
    return `https://login.work.weixin.qq.com/wwlogin/sso/login?${q}`;
  }

  /** 用回调里的 code 换成员 userid。 */
  async userIdByCode(code: string): Promise<string> {
    const token = await this.accessToken();
    const r = await this.get(`https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${token}&code=${encodeURIComponent(code)}`);
    const userId = (r.userid ?? r.UserId) as string | undefined;
    if (!userId) throw new UnauthorizedException('只有企业成员可以登录');
    return userId;
  }

  /** 以自建应用身份给成员发文本消息（成员 userid 即工作台里的企业微信账号）。 */
  async sendText(userIds: string[], content: string) {
    const token = await this.accessToken();
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userIds.join('|'),
        msgtype: 'text',
        agentid: Number(this.config.getOrThrow('WECOM_AGENT_ID')),
        text: { content },
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (body.errcode) throw new ServiceUnavailableException(`企业微信发消息失败：${body.errcode} ${body.errmsg}`);
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const q = new URLSearchParams({
      corpid: this.config.getOrThrow('WECOM_CORP_ID'),
      corpsecret: this.config.getOrThrow('WECOM_SECRET'),
    });
    const r = await this.get(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?${q}`);
    // 提前 5 分钟过期，避免临界时刻失效
    this.token = { value: r.access_token as string, expiresAt: Date.now() + ((r.expires_in as number) - 300) * 1000 };
    return this.token.value;
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    const res = await fetch(url);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.errcode) throw new ServiceUnavailableException(`企业微信接口出错：${body.errcode} ${body.errmsg}`);
    return body;
  }
}
