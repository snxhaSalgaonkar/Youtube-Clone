"use client";

import { createContext, useContext, useState, useEffect } from "react";
import api from "@/lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);  // null = not logged in
  const [loading, setLoading] = useState(true);  // true = still checking

  useEffect(() => {
    // On every page load/refresh, check if the user's cookie is still valid
    // This is what keeps the user "logged in" across browser refreshes
    api.get("/users/current-user")
      .then((res) => setUser(res.data.data))
      .catch(() => setUser(null)) // cookie missing or expired → treat as logged out
      .finally(() => setLoading(false));
  }, []);

  const login = (userData) => setUser(userData);

  const logout = async () => {
    await api.post("/users/logout");
    setUser(null);
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
};