import React from "react";
import type { RouteDiagnostics } from "../../utils/routeDiagnostics";
import { hasRouteDiagnosticIssue } from "../../utils/routeDiagnostics";

interface RouteDiagnosticsOverlayProps {
  diagnostics: RouteDiagnostics;
  className?: string;
}

const RouteDiagnosticsOverlay: React.FC<RouteDiagnosticsOverlayProps> = ({
  diagnostics,
  className = "bottom-4 right-4",
}) => {
  if (!hasRouteDiagnosticIssue(diagnostics)) return null;

  const hasMissingLocation = diagnostics.statuses.includes("missing-location");
  const isUnreachable = diagnostics.statuses.includes("unreachable");

  return (
    <div
      className={`pointer-events-none absolute z-20 max-w-[min(22rem,calc(100%-2rem))] ${className}`}
      aria-live="polite"
    >
      <details className="pointer-events-auto rounded-lg border border-amber-300 bg-white/95 px-3 py-2 text-xs text-slate-800 shadow-md backdrop-blur-sm dark:border-amber-700 dark:bg-slate-900/95 dark:text-slate-100">
        <summary className="cursor-pointer select-none font-semibold">
          {isUnreachable
            ? "経路を作成できません"
            : `場所未確認 ${diagnostics.missingItemCount}アイテム`}
          {isUnreachable && hasMissingLocation
            ? ` ／ 場所未確認 ${diagnostics.missingItemCount}アイテム`
            : ""}
        </summary>
        <div className="mt-2 space-y-2">
          {isUnreachable && (
            <p className="text-red-700 dark:text-red-300">
              障害物を避けた経路が見つからないため、誤解を招く線は表示していません。
            </p>
          )}
          {hasMissingLocation && (
            <div>
              <p className="text-amber-800 dark:text-amber-200">
                次の訪問先を除外し、場所が分かる訪問先だけで経路を確認しています。
              </p>
              <ul className="mt-1 space-y-1">
                {diagnostics.missingLocations.map((location) => (
                  <li key={location.key}>
                    <details>
                      <summary className="cursor-pointer">
                        {location.label}
                      </summary>
                      <ul className="ml-4 mt-1 list-disc space-y-0.5">
                        {location.items.map((item) => (
                          <li key={item.id}>
                            {item.circle || item.title || item.id}
                            {item.circle && item.title ? `：${item.title}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </div>
  );
};

export default React.memo(RouteDiagnosticsOverlay);
