import { Outlet } from "react-router-dom";
import { useEffect } from "react";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import ChatPanel from "../Chat/ChatPanel";
import { useThemeStore } from "../../stores/themeStore";
import { useAuthStore } from "../../stores/authStore";
import "./DashboardLayout.css";

export default function DashboardLayout() {
  const init = useThemeStore((s) => s.init);
  const verifyToken = useAuthStore((s) => s.verifyToken);

  useEffect(() => {
    init();
    verifyToken();
  }, []);

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <div className="main-area">
        <TopBar />
        <main className="page-content">
          <Outlet />
        </main>
      </div>
      <ChatPanel />
    </div>
  );
}
