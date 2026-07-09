import { useState, useEffect } from "react";
import { useAuthStore } from "../stores/authStore";
import "./TasksPage.css";

export default function TasksPage() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newTitle, setNewTitle] = useState("");
  const [activeTab, setActiveTab] = useState("all");
  const getAuthHeaders = useAuthStore((s) => s.getAuthHeaders);

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tasks", { headers: getAuthHeaders() });
      if (!res.ok) throw new Error("Failed to fetch tasks");
      const data = await res.json();
      setTasks(data.tasks || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  const addTask = async (e) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ title: newTitle, priority: "medium" }),
      });
      if (!res.ok) throw new Error("Failed to create task");
      setNewTitle("");
      fetchTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await fetch(`/api/tasks/${id}`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ status }),
      });
      fetchTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteTask = async (id) => {
    try {
      await fetch(`/api/tasks/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      fetchTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredTasks =
    activeTab === "all" ? tasks : tasks.filter((t) => t.status === activeTab);

  const tabs = [
    { key: "all", label: "All" },
    { key: "todo", label: "📋 Todo" },
    { key: "in_progress", label: "🟡 In Progress" },
    { key: "done", label: "✅ Done" },
  ];

  if (loading) {
    return (
      <div className="page-loading">
        {Array(5)
          .fill(null)
          .map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 56 }} />
          ))}
      </div>
    );
  }

  return (
    <div className="tasks-page fade-in">
      {error && (
        <div className="login-error" style={{ marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      <form className="task-add-form" onSubmit={addTask}>
        <input
          type="text"
          placeholder="+ Add a new task..."
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={!newTitle.trim()}
        >
          Add
        </button>
      </form>

      <div className="task-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`btn btn-sm ${activeTab === tab.key ? "btn-primary" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="task-list">
        {filteredTasks.length === 0 ? (
          <div className="state-message" style={{ marginTop: 32 }}>
            <div className="state-icon">📋</div>
            <div className="state-title">No tasks</div>
            <div className="state-desc">Add your first task above.</div>
          </div>
        ) : (
          filteredTasks.map((task) => (
            <div key={task.id} className={`task-item ${task.status}`}>
              <div className="task-info">
                <div className="task-title">{task.title}</div>
                {task.description && (
                  <div className="task-desc">{task.description}</div>
                )}
                <div className="task-meta">
                  <span
                    className={`badge ${task.priority === "high" ? "badge-red" : task.priority === "medium" ? "badge-yellow" : "badge-green"}`}
                  >
                    {task.priority}
                  </span>
                  {task.due_date && (
                    <span className="task-date">
                      📅 {new Date(task.due_date).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="task-actions">
                {task.status !== "done" && (
                  <button
                    className="btn-icon"
                    title="Mark done"
                    onClick={() => updateStatus(task.id, "done")}
                  >
                    ✅
                  </button>
                )}
                {task.status === "todo" && (
                  <button
                    className="btn-icon"
                    title="Start"
                    onClick={() => updateStatus(task.id, "in_progress")}
                  >
                    ▶️
                  </button>
                )}
                <button
                  className="btn-icon"
                  title="Delete"
                  onClick={() => deleteTask(task.id)}
                >
                  🗑️
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
