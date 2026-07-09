import { create } from 'zustand';

const THEME_KEY = 'jarvis-theme';

function getSystemTheme() {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return 'system';
  } catch {
    return 'system';
  }
}

export const useThemeStore = create((set, get) => ({
  preference: loadTheme(), // 'dark' | 'light' | 'system'
  resolved: 'dark',

  init: () => {
    const pref = get().preference;
    const resolved = pref === 'system' ? getSystemTheme() : pref;
    set({ resolved });
    document.documentElement.setAttribute('data-theme', resolved);

    // Listen for system theme changes
    if (typeof window !== 'undefined') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (get().preference === 'system') {
          const newTheme = e.matches ? 'dark' : 'light';
          set({ resolved: newTheme });
          document.documentElement.setAttribute('data-theme', newTheme);
        }
      });
    }
  },

  setTheme: (pref) => {
    const resolved = pref === 'system' ? getSystemTheme() : pref;
    set({ preference: pref, resolved });
    localStorage.setItem(THEME_KEY, pref);
    document.documentElement.setAttribute('data-theme', resolved);
  },

  toggle: () => {
    const next = get().resolved === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },
}));
