import { create } from 'zustand';

const API_BASE = '';

export const useAuthStore = create((set, get) => ({
  user: null,
  token: localStorage.getItem('jarvis_token') || null,
  isAuthenticated: !!localStorage.getItem('jarvis_token'),
  loginLoading: false,
  loginError: null,

  // Verify Telegram login data with backend
  loginWithTelegram: async (telegramData) => {
    set({ loginLoading: true, loginError: null });
    try {
      const res = await fetch(`${API_BASE}/api/auth/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telegramData),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem('jarvis_token', data.token);
      set({ user: data.user, token: data.token, isAuthenticated: true, loginLoading: false });
      return true;
    } catch (err) {
      set({ loginLoading: false, loginError: err.message });
      return false;
    }
  },

  // Verify stored token on app load
  verifyToken: async () => {
    const token = get().token;
    if (!token) return false;

    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Invalid token');

      const data = await res.json();
      set({ user: data.user, isAuthenticated: true });
      return true;
    } catch {
      localStorage.removeItem('jarvis_token');
      set({ user: null, token: null, isAuthenticated: false });
      return false;
    }
  },

  // Get auth headers for API calls
  getAuthHeaders: () => {
    const token = get().token;
    return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  },

  logout: () => {
    localStorage.removeItem('jarvis_token');
    localStorage.removeItem('widget-layout');
    set({ user: null, token: null, isAuthenticated: false });
  },
}));
