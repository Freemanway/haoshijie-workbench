import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 企业微信接口：扫码登录、应用消息推送、客户联系（渠道活码、获客链接、标签、欢迎语、客户群）。
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
    await this.post('message/send', {
      touser: userIds.join('|'),
      msgtype: 'text',
      agentid: Number(this.config.getOrThrow('WECOM_AGENT_ID')),
      text: { content },
    }, '企业微信发消息失败');
  }

  // ---------- 客户联系（需在企业微信后台“客户联系 > API”里把本应用设为可调用） ----------

  /** “联系我”二维码，文档 92228。一人用单人码，多人用多人码（轮流分配）。 */
  async addContactWay(users: string[], state: string, remark: string) {
    const r = await this.post('externalcontact/add_contact_way', { type: users.length > 1 ? 2 : 1, scene: 2, remark: remark.slice(0, 30), skip_verify: true, state, user: users });
    return { remoteId: r.config_id as string, qrCode: r.qr_code as string };
  }

  async updateContactWay(configId: string, users: string[], state: string, remark: string) {
    await this.post('externalcontact/update_contact_way', { config_id: configId, remark: remark.slice(0, 30), skip_verify: true, state, user: users });
  }

  async delContactWay(configId: string) {
    await this.post('externalcontact/del_contact_way', { config_id: configId });
  }

  /** 获客助手链接，文档 97297。链接后拼 customer_channel 参数，加微回调的 State 会带回它。 */
  async createLink(name: string, users: string[]) {
    const r = await this.post('externalcontact/customer_acquisition/create_link', { link_name: name.slice(0, 30), range: { user_list: users }, skip_verify: true });
    const link = r.link as { link_id: string; url: string };
    return { remoteId: link.link_id, url: link.url };
  }

  async updateLink(linkId: string, name: string, users: string[]) {
    await this.post('externalcontact/customer_acquisition/update_link', { link_id: linkId, link_name: name.slice(0, 30), range: { user_list: users }, skip_verify: true });
  }

  async deleteLink(linkId: string) {
    await this.post('externalcontact/customer_acquisition/delete_link', { link_id: linkId });
  }

  /** 找到或新建“来源渠道”标签组里的某个标签，返回标签 ID。 */
  async ensureTag(group: string, name: string) {
    const r = await this.post('externalcontact/get_corp_tag_list', {});
    const groups = (r.tag_group ?? []) as { group_id: string; group_name: string; tag: { id: string; name: string }[] }[];
    const g = groups.find((x) => x.group_name === group);
    const found = g?.tag.find((t) => t.name === name);
    if (found) return found.id;
    const created = await this.post('externalcontact/add_corp_tag', { ...(g ? { group_id: g.group_id } : { group_name: group }), tag: [{ name: name.slice(0, 30) }] });
    return (created.tag_group as { tag: { id: string }[] }).tag[0].id;
  }

  async markTag(staffId: string, externalUserId: string, tagIds: string[]) {
    await this.post('externalcontact/mark_tag', { userid: staffId, external_userid: externalUserId, add_tag: tagIds });
  }

  /** 加微欢迎语：WelcomeCode 20 秒内有效，只能用一次。 */
  async sendWelcome(welcomeCode: string, text: string, imageMediaId?: string) {
    await this.post('externalcontact/send_welcome_msg', {
      welcome_code: welcomeCode,
      text: { content: text },
      ...(imageMediaId ? { attachments: [{ msgtype: 'image', image: { media_id: imageMediaId } }] } : {}),
    });
  }

  async externalContact(externalUserId: string) {
    const token = await this.accessToken();
    const r = await this.get(`https://qyapi.weixin.qq.com/cgi-bin/externalcontact/get?access_token=${token}&external_userid=${encodeURIComponent(externalUserId)}`);
    const c = r.external_contact as { name?: string };
    const follow = (r.follow_user ?? []) as { userid: string; remark_mobiles?: string[]; state?: string }[];
    return { name: c?.name, follow };
  }

  // ---------- 客户群“加入群聊”（文档 92229） ----------

  async addJoinWay(w: JoinWayInput) {
    const r = await this.post('externalcontact/groupchat/add_join_way', this.joinWayBody(w));
    return r.config_id as string;
  }

  async updateJoinWay(configId: string, w: JoinWayInput) {
    await this.post('externalcontact/groupchat/update_join_way', { config_id: configId, ...this.joinWayBody(w) });
  }

  async joinWayQr(configId: string) {
    const r = await this.post('externalcontact/groupchat/get_join_way', { config_id: configId });
    return (r.join_way as { qr_code: string }).qr_code;
  }

  async delJoinWay(configId: string) {
    await this.post('externalcontact/groupchat/del_join_way', { config_id: configId });
  }

  async groupChat(chatId: string) {
    const r = await this.post('externalcontact/groupchat/get', { chat_id: chatId, need_name: 0 });
    const g = r.group_chat as { name: string; member_list: unknown[] };
    return { name: g.name, count: g.member_list.length };
  }

  /** 把图片（如群二维码）上传成临时素材，3 天内有效。 */
  async uploadImage(imageUrl: string) {
    const img = await this.fetch(imageUrl);
    if (!img.ok) throw new ServiceUnavailableException(`下载图片失败：${img.status}`);
    const form = new FormData();
    form.append('media', new Blob([await img.arrayBuffer()], { type: 'image/png' }), 'qrcode.png');
    const token = await this.accessToken();
    const res = await this.fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`, { method: 'POST', body: form });
    const body = (await res.json()) as Record<string, unknown>;
    if (body.errcode) throw new ServiceUnavailableException(`企业微信上传图片失败：${body.errcode} ${body.errmsg}`);
    return body.media_id as string;
  }

  /** 网络不通时给出能看懂的错误，而不是 500。 */
  private async fetch(url: string, init?: RequestInit) {
    try {
      return await fetch(url, init);
    } catch (e) {
      throw new ServiceUnavailableException(`连不上企业微信：${(e as Error).message}`);
    }
  }

  private joinWayBody(w: JoinWayInput) {
    return {
      scene: 2,
      remark: w.name.slice(0, 30),
      auto_create_room: w.autoCreate ? 1 : 0,
      ...(w.autoCreate ? { room_base_name: w.roomBaseName, room_base_id: w.roomBaseId ?? 1 } : {}),
      chat_id_list: w.chatIds,
      state: w.state,
    };
  }

  private async post(path: string, payload: unknown, errPrefix = '企业微信接口出错'): Promise<Record<string, unknown>> {
    const token = await this.accessToken();
    const res = await this.fetch(`https://qyapi.weixin.qq.com/cgi-bin/${path}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (body.errcode) throw new ServiceUnavailableException(`${errPrefix}：${body.errcode} ${body.errmsg}`);
    return body;
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
    const res = await this.fetch(url);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.errcode) throw new ServiceUnavailableException(`企业微信接口出错：${body.errcode} ${body.errmsg}`);
    return body;
  }
}

export interface JoinWayInput {
  name: string;
  chatIds: string[];
  autoCreate: boolean;
  roomBaseName?: string | null;
  roomBaseId?: number | null;
  state: string;
}
