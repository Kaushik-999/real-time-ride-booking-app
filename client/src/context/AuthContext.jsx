import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, setAuthToken, setUnauthorizedHandler } from '../services/api';
import { connectSocket, disconnectSocket } from '../services/socket';

const AuthContext = createContext(null);
const STORAGE_KEY = 'ride.token';

// The token is kept in sessionStorage (cleared when the tab closes). The
// role shown in the UI comes from /auth/me, never from decoding the token.
export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(STORAGE_KEY));
  const [user, setUser] = useState(null);
  const [driverProfile, setDriverProfile] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [socket, setSocket] = useState(null);

  const logout = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setAuthToken(null);
    disconnectSocket();
    setSocket(null);
    setToken(null);
    setUser(null);
    setDriverProfile(null);
  }, []);

  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setAuthToken(token);
    setLoading(true);
    authApi
      .me()
      .then((data) => {
        if (cancelled) return;
        setUser(data.user);
        setDriverProfile(data.driverProfile || null);
        const sock = connectSocket(token);
        // The server tells a suspended user's open sessions to sign out.
        sock.on('account:suspended', () => logout());
        setSocket(sock);
      })
      .catch(() => !cancelled && logout())
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [token, logout]);

  const signIn = useCallback((result) => {
    sessionStorage.setItem(STORAGE_KEY, result.token);
    setToken(result.token);
  }, []);

  const refreshProfile = useCallback(async () => {
    const data = await authApi.me();
    setUser(data.user);
    setDriverProfile(data.driverProfile || null);
    return data;
  }, []);

  const value = useMemo(
    () => ({ token, user, driverProfile, setDriverProfile, loading, socket, signIn, logout, refreshProfile }),
    [token, user, driverProfile, loading, socket, signIn, logout, refreshProfile]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export { AuthContext };
