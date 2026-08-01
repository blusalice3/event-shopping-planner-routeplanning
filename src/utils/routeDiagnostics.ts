import type { ShoppingItem } from "../types/item";

export type RouteDiagnosticStatus =
  | "normal"
  | "missing-location"
  | "unreachable";

export interface MissingRouteLocationItem {
  id: string;
  circle: string;
  title: string;
}

export interface MissingRouteLocationGroup {
  key: string;
  label: string;
  itemCount: number;
  items: MissingRouteLocationItem[];
}

export interface RouteDiagnostics {
  statuses: RouteDiagnosticStatus[];
  missingItemCount: number;
  missingLocations: MissingRouteLocationGroup[];
  validLocationCount: number;
}

interface BuildRouteDiagnosticsParams {
  missingItemIds: string[];
  items: ShoppingItem[];
  validLocationCount: number;
  routeUnreachable: boolean;
}

const normalizeLocationPart = (value: string | null | undefined): string =>
  (value ?? "").replace(/\u3000/g, " ").trim();

const buildLocationIdentity = (
  item: Pick<ShoppingItem, "block" | "number">,
): { key: string; display: string } => {
  const block = normalizeLocationPart(item.block);
  const number = normalizeLocationPart(item.number);
  const display =
    block && number ? `${block}-${number}` : block || number || "場所情報なし";
  return {
    key: `${block.toLocaleLowerCase()}::${number.toLocaleLowerCase()}`,
    display,
  };
};

export const buildRouteDiagnostics = ({
  missingItemIds,
  items,
  validLocationCount,
  routeUnreachable,
}: BuildRouteDiagnosticsParams): RouteDiagnostics => {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const groupsByKey = new Map<
    string,
    {
      display: string;
      items: MissingRouteLocationItem[];
    }
  >();
  const seenMissingItemIds = new Set<string>();

  missingItemIds.forEach((itemId) => {
    if (seenMissingItemIds.has(itemId)) return;
    seenMissingItemIds.add(itemId);

    const item = itemsById.get(itemId);
    const identity = item
      ? buildLocationIdentity(item)
      : { key: `unknown::${itemId}`, display: "不明なアイテム" };
    const group = groupsByKey.get(identity.key) ?? {
      display: identity.display,
      items: [],
    };
    group.items.push({
      id: itemId,
      circle: item?.circle ?? "",
      title: item?.title ?? "",
    });
    groupsByKey.set(identity.key, group);
  });

  const missingLocations = Array.from(groupsByKey.entries()).map(
    ([key, group]) => ({
      key,
      label: `${group.display}（${group.items.length}アイテム）`,
      itemCount: group.items.length,
      items: group.items,
    }),
  );
  const statuses: RouteDiagnosticStatus[] = [];
  if (seenMissingItemIds.size > 0) statuses.push("missing-location");
  if (routeUnreachable && validLocationCount >= 2) statuses.push("unreachable");
  if (statuses.length === 0) statuses.push("normal");

  return {
    statuses,
    missingItemCount: seenMissingItemIds.size,
    missingLocations,
    validLocationCount,
  };
};

export const hasRouteDiagnosticIssue = (
  diagnostics: RouteDiagnostics,
): boolean => !diagnostics.statuses.includes("normal");
