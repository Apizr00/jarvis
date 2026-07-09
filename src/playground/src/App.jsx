import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/authStore";
import DashboardLayout from "./components/Layout/DashboardLayout";
import LoginPage from "./pages/LoginPage";
import Dashboard from "./pages/Dashboard";
import ChatPage from "./pages/ChatPage";
import TasksPage from "./pages/TasksPage";
import NotesPage from "./pages/NotesPage";
import MemoryPage from "./pages/MemoryPage";
import PluginsPage from "./pages/PluginsPage";
import SettingsPage from "./pages/SettingsPage";
import WaktuSolatPage from "./pages/WaktuSolatPage";

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { isAuthenticated } = useAuthStore();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="notes" element={<NotesPage />} />
        <Route path="memory" element={<MemoryPage />} />
        <Route path="plugins" element={<PluginsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="waktu-solat" element={<WaktuSolatPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
