import { Button, Result, Spin } from 'antd';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api, tokenStore } from './api';

export interface Me {
  id: string;
  name: string;
  roles: string[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => void;
  /** 是否有任一角色；管理员总是有权限，与后端守卫一致 */
  can: (...roles: string[]) => boolean;
}

const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      setMe(await api<Me>('/auth/me'));
    } catch {
      tokenStore.clear();
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = () => {
    tokenStore.clear();
    setMe(null);
  };
  const can = (...roles: string[]) => !!me && (me.roles.includes('ADMIN') || roles.some((r) => me.roles.includes(r)));

  return <Ctx.Provider value={{ me, loading, refresh, logout, can }}>{children}</Ctx.Provider>;
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spin style={{ display: 'block', marginTop: 120 }} />;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

/** 直接打开没有权限的页面（比如收藏的链接）时给出提示，而不是让页面请求接口报 403。 */
export function RequireRole({ roles, children }: { roles?: string[]; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!roles || can(...roles)) return children;
  return <Result status="403" title="没有权限" subTitle="这个页面不对你的角色开放，需要的话请联系管理员。" extra={<Link to="/overview"><Button type="primary">回到数据周报</Button></Link>} />;
}
