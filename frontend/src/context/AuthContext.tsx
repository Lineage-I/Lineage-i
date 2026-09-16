import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { Actor } from '../types';

interface AuthContextValue {
  actor: Actor | null;
  token: string | null;
  login: (actor: Actor, token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Decode a JWT payload without verifying the signature (client-side only).
 * Returns null if the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    // atob handles standard base64; replace URL-safe chars first
    const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns true if the JWT has not yet expired (client-side clock check).
 * The backend still validates the token cryptographically on each request —
 * this check is only used to avoid loading obviously-expired sessions from
 * localStorage.
 */
function isTokenValid(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const exp = payload['exp'];
  if (typeof exp !== 'number') return false;
  // exp is in seconds; add a 30-second tolerance for clock skew
  return exp * 1000 > Date.now() - 30_000;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(() => {
    try {
      const storedToken = localStorage.getItem('token');
      // Discard the stored session immediately if the token is expired.
      // This prevents old roles from persisting past their validity window.
      if (!storedToken || !isTokenValid(storedToken)) {
        localStorage.removeItem('actor');
        localStorage.removeItem('token');
        return null;
      }
      const stored = localStorage.getItem('actor');
      return stored ? (JSON.parse(stored) as Actor) : null;
    } catch {
      return null;
    }
  });

  const [token, setToken] = useState<string | null>(() => {
    const t = localStorage.getItem('token');
    return t && isTokenValid(t) ? t : null;
  });

  // Keep localStorage in sync whenever state changes
  useEffect(() => {
    if (actor) {
      localStorage.setItem('actor', JSON.stringify(actor));
    } else {
      localStorage.removeItem('actor');
    }
  }, [actor]);

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }, [token]);

  const login = useCallback((newActor: Actor, newToken: string) => {
    setActor(newActor);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    setActor(null);
    setToken(null);
    localStorage.removeItem('actor');
    localStorage.removeItem('token');
  }, []);

  return (
    <AuthContext.Provider value={{ actor, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
