/** 后端接口调用：统一带登录令牌，401 时清掉令牌回到登录页。 */
const TOKEN_KEY = 'hsj_token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* 隐私模式下忽略 */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* 忽略 */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    tokenStore.clear();
    window.location.assign('/login');
  }
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join('；') : data?.message;
    throw new ApiError(res.status, data?.errors?.[0]?.message ?? msg ?? '请求失败', data?.errors);
  }
  return data as T;
}

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理员',
  CONTENT: '内容运营',
  REVIEWER: '审核人',
  CS: '客服',
  BIZ: '招商',
  VIEWER: '管理层（只读）',
};
export const PLATFORM_LABEL: Record<string, string> = { XHS: '小红书', DOUYIN: '抖音', WECHAT_CHANNELS: '视频号' };
export const AUDIENCE_LABEL: Record<string, string> = { C: 'C 端', B: 'B 端' };
