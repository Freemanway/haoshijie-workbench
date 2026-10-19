/**
 * 收货地址智能拆分（PRD 6.2，任务 M10-2）。
 * 客户一次性粘贴整段地址，拆成收件人、电话、省市区、详细地址，并校验配送范围。
 */
export interface ParsedAddress {
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  ok: boolean;
  outOfRange: boolean;
  message: string;
}

const PROVINCES = [
  '内蒙古', '黑龙江', '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '江苏', '浙江',
  '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南',
  '陕西', '甘肃', '青海', '台湾', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];
const MUNICIPALITIES = ['北京', '天津', '上海', '重庆'];

/** 默认不发鲜果的地区（示例配置，以运营确认的配送范围为准）。 */
export const DEFAULT_NO_SHIP = ['新疆', '西藏', '香港', '澳门', '台湾'];

const PHONE_RE = /(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}/;
const NAME_RE = /^[一-龥·]{2,5}$/;

export const isValidMobile = (s: string) => /^1[3-9]\d{9}$/.test(s);
export const maskPhone = (p: string) => (isValidMobile(p) ? `${p.slice(0, 3)}****${p.slice(7)}` : p);

export function parseAddress(raw: string, noShip: string[] = DEFAULT_NO_SHIP): ParsedAddress {
  let s = raw
    .replace(/(收件人|收货人|联系电话|电话|手机号?|详细地址|地址|所在地区)\s*[:：]?/g, ' ')
    .replace(/[，,;；\n\t]/g, ' ');
  const r: ParsedAddress = {
    name: '', phone: '', province: '', city: '', district: '', detail: '', ok: true, outOfRange: false, message: '',
  };

  const pm = s.match(PHONE_RE);
  if (pm) {
    r.phone = pm[0].replace(/\D/g, '').slice(-11);
    s = s.replace(pm[0], ' ');
  }

  let before = s;
  let after = '';
  const prov = PROVINCES.find((p) => s.includes(p));
  if (prov) {
    const m = s.match(new RegExp(`${prov}(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)?`))!;
    r.province = m[0];
    before = s.slice(0, m.index);
    after = s.slice(m.index! + m[0].length).trim();
    if (MUNICIPALITIES.includes(prov)) {
      r.city = `${prov}市`;
      after = after.replace(new RegExp(`^${prov}市`), '').trim();
    } else {
      // 先找“市/自治州/地区/盟”，避免把“杭州市”截成“杭州”；再兜底简称“州”（如“恩施州”）
      const c =
        after.match(/^([一-龥]{1,10}?(市|自治州|地区|盟))/) ?? after.match(/^([一-龥]{1,6}?州)/);
      if (c) {
        r.city = c[1];
        after = after.slice(c[1].length).trim();
      }
    }
    const d = after.match(/^([一-龥]{1,8}?(新区|区|县|旗|市))/);
    if (d) {
      r.district = d[1];
      after = after.slice(d[1].length).trim();
    }
  }

  const tail = after.split(/\s+/).filter(Boolean);
  const head = before.split(/\s+/).filter(Boolean);
  if (head.length) r.name = head.find((t) => NAME_RE.test(t)) ?? head[0];
  else if (tail.length > 1 && NAME_RE.test(tail[tail.length - 1])) r.name = tail.pop()!;
  r.detail = tail.join('');

  if (!r.phone) {
    r.ok = false;
    r.message = '没有识别到 11 位手机号，请补充';
  } else if (!r.province) {
    r.ok = false;
    r.message = '没有识别到省份，请检查地址';
  }
  if (prov && noShip.includes(prov)) {
    r.ok = false;
    r.outOfRange = true;
    r.message = `${r.province}不在鲜果配送范围内，已转人工处理`;
  }
  return r;
}

const toHalfWidth = (s: string) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');

/**
 * 订单匹配用的“收货人 + 地址”键（任务 M11-2）。
 * 团购工具导出的地址和私信里收的写法常有出入（带不带省、空格、全角数字），
 * 这里去掉省份、省市区县字样、空白和标点再比较；地址太短认不准时返回 null。
 */
export function addressKey(name: string | null | undefined, address: string | null | undefined): string | null {
  const n = toHalfWidth(name ?? '').replace(/\s/g, '');
  let a = toHalfWidth(address ?? '').replace(/[\s,，.。;；:：#\-—_()（）/\\]/g, '');
  for (let i = 0; i < 2; i++) {
    // 直辖市常写成“上海上海市”，剥两次
    const p = PROVINCES.find((x) => a.startsWith(x));
    if (!p) break;
    a = a.slice(p.length).replace(/^(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)/, '');
    if (!MUNICIPALITIES.includes(p)) break;
  }
  a = a.replace(/[省市区县]/g, '').toLowerCase();
  return n && a.length >= 4 ? `${n}|${a}` : null;
}
