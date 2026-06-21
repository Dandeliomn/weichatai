import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';

interface User { userId: number; email: string; role: string; wechatId?: string; displayName?: string; }
interface AuthCtx { user: User | null; loading: boolean; login: (email: string, password: string, captchaId?: string, captchaCode?: string) => Promise<void>; logout: () => void; }

const AuthContext = createContext<AuthCtx>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('access_token');
    if (token) api.get('/auth/me').then(({ data }) => setUser(data.user)).catch(() => localStorage.clear()).finally(() => setLoading(false));
    else setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string, captchaId?: string, captchaCode?: string) => {
    const payload: any = { email, password };
    if (captchaId) { payload.captchaId = captchaId; payload.captchaCode = captchaCode; }
    const { data } = await api.post('/auth/login', payload);
    localStorage.setItem('access_token', data.accessToken);
    localStorage.setItem('refresh_token', data.refreshToken);
    const me = await api.get('/auth/me');
    setUser(me.data.user);
  }, []);

  const logout = useCallback(() => { localStorage.clear(); setUser(null); }, []);
  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
