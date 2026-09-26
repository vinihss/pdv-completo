import React, { useState, useEffect } from "react";
import { auditLog, ACTION_LABEL } from "@/entities/audit";

export default function AuditTab() {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    auditLog({ limit: 100 }).then((r) => setLogs(r.data));
  }, []);
  return (
    <div className="p-5 max-w-2xl mx-auto space-y-2">
      {logs.map((l) => (
        <div key={l.id} className="flex items-center justify-between bg-stone-900 border border-stone-800 rounded-xl px-4 py-2.5 text-sm">
          <div>
            <div className="font-medium">{ACTION_LABEL[l.action] ?? l.action}</div>
            <div className="text-stone-500 text-xs">{l.userName} · {l.createdAt}</div>
          </div>
        </div>
      ))}
      {logs.length === 0 && <div className="text-stone-600 text-center py-10">Sem eventos registrados.</div>}
    </div>
  );
}