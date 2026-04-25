import React, { createContext, useContext, useState } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('cp_user');
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed.role) {
      parsed.role = parsed.is_admin ? 'admin' : 'contributor';
    }
    return parsed;
  });
  const [token, setToken] = useState(() => localStorage.getItem('cp_token'));

  function login(userData, jwt) {
    const normalized = { ...userData, role: userData.role || (userData.is_admin ? 'admin' : 'contributor') };
    setUser(normalized);
    setToken(jwt);
    localStorage.setItem('cp_user', JSON.stringify(normalized));
    localStorage.setItem('cp_token', jwt);
  }

  function logout() {
    setUser(null);
    setToken(null);
    localStorage.removeItem('cp_user');
    localStorage.removeItem('cp_token');
  }

  return (
    <AuthContext.Provider value={{ user, token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
