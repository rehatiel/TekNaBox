import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";

const ROLES = ["msp_admin", "msp_operator", "customer_viewer"];
const ROLE_LABELS = {
  super_admin:      "Super Admin",
  msp_admin:        "MSP Admin",
  msp_operator:     "Operator",
  customer_viewer:  "Viewer",
};
const ROLE_DESC = {
  msp_admin:       "Full access — can manage users, devices, tasks, and settings.",
  msp_operator:    "Can manage devices and run tasks. Cannot manage users.",
  customer_viewer: "Read-only access to assigned customers.",
};

function RoleBadge({ role }) {
  const colors = {
    super_admin:     "bg-purple-900/50 text-purple-300 border-purple-700",
    msp_admin:       "bg-cyan-900/50 text-cyan-300 border-cyan-800",
    msp_operator:    "bg-blue-900/50 text-blue-300 border-blue-800",
    customer_viewer: "bg-gray-800 text-gray-400 border-gray-700",
  };
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded border ${colors[role] || colors.customer_viewer}`}>
      {ROLE_LABELS[role] || role}
    </span>
  );
}

// ── Add / Edit User Modal ─────────────────────────────────────────────────────

function UserModal({ existing, onClose, onSaved, isSuper }) {
  const isEdit = !!existing;
  const [form, setForm] = useState({
    email:    existing?.email    || "",
    password: "",
    role:     existing?.role     || "msp_operator",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const availableRoles = isSuper
    ? ["super_admin", ...ROLES]
    : ROLES;

  async function handleSave() {
    if (!form.email) { setError("Email is required"); return; }
    if (!isEdit && !form.password) { setError("Password is required for new users"); return; }
    setSaving(true); setError("");
    try {
      if (isEdit) {
        const patch = { role: form.role };
        if (form.password) patch.password = form.password;
        if (form.email !== existing.email) patch.email = form.email;
        await api.patch(`/v1/operators/${existing.id}`, patch);
      } else {
        await api.post("/v1/operators", {
          email:    form.email,
          password: form.password,
          role:     form.role,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-semibold text-white mb-4">
          {isEdit ? "Edit User" : "Add User"}
        </h2>
        {error && (
          <div className="text-red-400 text-sm mb-4 bg-red-900/20 border border-red-800 rounded p-3">{error}</div>
        )}
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Email</label>
            <input
              type="email"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Password {isEdit && <span className="text-gray-600">(leave blank to keep current)</span>}
            </label>
            <input
              type="password"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm"
              placeholder={isEdit ? "••••••••" : ""}
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-2">Role</label>
            <div className="space-y-2">
              {availableRoles.map(r => (
                <label key={r}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    form.role === r
                      ? "border-cyan-700 bg-cyan-900/20"
                      : "border-gray-700 hover:border-gray-600"
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={r}
                    checked={form.role === r}
                    onChange={() => setForm(f => ({ ...f, role: r }))}
                    className="mt-0.5 accent-cyan-500"
                  />
                  <div>
                    <div className="text-white text-sm font-medium">{ROLE_LABELS[r]}</div>
                    {ROLE_DESC[r] && (
                      <div className="text-gray-500 text-xs mt-0.5">{ROLE_DESC[r]}</div>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-6 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-sm font-medium transition-colors disabled:opacity-50">
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Add User"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Confirm Deactivate Modal ──────────────────────────────────────────────────

function ConfirmModal({ user, action, onClose, onConfirm }) {
  const [loading, setLoading] = useState(false);
  async function go() {
    setLoading(true);
    await onConfirm();
    setLoading(false);
  }
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-sm shadow-xl">
        <h2 className="text-lg font-semibold text-white mb-2">
          {action === "deactivate" ? "Deactivate User" : "Reactivate User"}
        </h2>
        <p className="text-gray-400 text-sm mb-5">
          {action === "deactivate"
            ? `${user.email} will no longer be able to log in.`
            : `${user.email} will be able to log in again.`}
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button onClick={go} disabled={loading}
            className={`px-4 py-2 rounded text-sm font-medium text-white disabled:opacity-50 ${
              action === "deactivate" ? "bg-red-700 hover:bg-red-600" : "bg-green-700 hover:bg-green-600"
            }`}>
            {loading ? "…" : action === "deactivate" ? "Deactivate" : "Reactivate"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const { operator, isSuper } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null); // {user, action}
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await api.get("/v1/operators");
      setUsers(data);
    } catch (e) {
      setError(e.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleToggleActive(user) {
    try {
      await api.patch(`/v1/operators/${user.id}`, { is_active: !user.is_active });
      await load();
    } catch (e) {
      setError(e.message);
    }
    setConfirming(null);
  }

  const isSelf = (u) => u.id === operator?.id;
  const canManage = (u) => !isSelf(u) && (isSuper || u.role !== "super_admin");

  const activeUsers   = users.filter(u => u.is_active);
  const inactiveUsers = users.filter(u => !u.is_active);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Users</h1>
          <p className="text-gray-400 text-sm mt-1">
            Manage who has access to MSP Command
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-sm font-medium transition-colors"
        >
          + Add User
        </button>
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-3">{error}</div>
      )}

      {loading ? (
        <div className="text-center py-20 text-gray-500">Loading…</div>
      ) : (
        <div className="space-y-6">
          {/* Active Users */}
          <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Active Users <span className="text-gray-500 font-normal ml-1">({activeUsers.length})</span>
              </h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left">
                  <th className="px-4 py-3 text-gray-400 font-medium">User</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Role</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Last Login</th>
                  <th className="px-4 py-3 text-gray-400 font-medium">Created</th>
                  <th className="px-4 py-3 text-gray-400 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {activeUsers.map(u => (
                  <tr key={u.id} className="border-b border-gray-800 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                          <span className="text-sm font-bold text-gray-300">
                            {u.email[0].toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <div className="text-white font-medium">
                            {u.email}
                            {isSelf(u) && (
                              <span className="ml-2 text-xs text-cyan-500 bg-cyan-900/30 px-1.5 py-0.5 rounded">you</span>
                            )}
                          </div>
                          <div className="text-gray-600 text-xs font-mono">{u.id.slice(0, 8)}…</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {canManage(u) && (
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            onClick={() => setEditing(u)}
                            className="text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-gray-700"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setConfirming({ user: u, action: "deactivate" })}
                            className="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded hover:bg-red-900/20"
                          >
                            Deactivate
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Inactive Users */}
          {inactiveUsers.length > 0 && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden opacity-70">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="text-sm font-semibold text-gray-400">
                  Deactivated <span className="font-normal ml-1">({inactiveUsers.length})</span>
                </h2>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {inactiveUsers.map(u => (
                    <tr key={u.id} className="border-b border-gray-800">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center shrink-0">
                            <span className="text-sm font-bold text-gray-600">{u.email[0].toUpperCase()}</span>
                          </div>
                          <div>
                            <div className="text-gray-500">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                      <td className="px-4 py-3 text-gray-600 text-xs">
                        Deactivated {u.revoked_at ? new Date(u.revoked_at).toLocaleDateString() : ""}
                      </td>
                      <td className="px-4 py-3 text-right px-4">
                        {canManage(u) && (
                          <button
                            onClick={() => setConfirming({ user: u, action: "reactivate" })}
                            className="text-xs text-green-400 hover:text-green-300 transition-colors px-2 py-1 rounded hover:bg-green-900/20"
                          >
                            Reactivate
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showAdd && (
        <UserModal
          isSuper={isSuper}
          onClose={() => setShowAdd(false)}
          onSaved={load}
        />
      )}
      {editing && (
        <UserModal
          existing={editing}
          isSuper={isSuper}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
      {confirming && (
        <ConfirmModal
          user={confirming.user}
          action={confirming.action}
          onClose={() => setConfirming(null)}
          onConfirm={() => handleToggleActive(confirming.user)}
        />
      )}
    </div>
  );
}
