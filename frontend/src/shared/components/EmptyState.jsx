import React from "react";
import { Inbox } from "lucide-react";

/** Estado vazio compacto ou amplo com linguagem visual consistente. */
export default function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className = "",
}) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-stone-800 bg-stone-900/40 px-5 text-center ${compact ? "py-5" : "py-10"} ${className}`}>
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-stone-800 text-stone-400" aria-hidden="true">
        <Icon size={19} />
      </span>
      <p className="text-sm font-semibold text-stone-200">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-stone-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
