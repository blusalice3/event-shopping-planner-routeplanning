import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import {
  SpaceNavigatorProvider,
  useSpaceNavigator,
} from "../features/space-navigation/SpaceNavigatorContext";
import ShoppingList from "./ShoppingList";

const makeItem = (
  id: string,
  block: string,
  number: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate: "Day1",
  block,
  number,
  title: `タイトル${id}`,
  price: 500,
  purchaseStatus: "Purchased",
  quantity: 1,
  remarks: "",
  priorityLevel: "none",
  ...overrides,
});

const setWindowScrollY = (value: number) => {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value,
  });
};

function NavigatorProbe() {
  const navigator = useSpaceNavigator();
  return (
    <>
      <output data-testid="entry-count">
        {navigator.registration?.entries.length ?? 0}
      </output>
      <output data-testid="current-index">
        {navigator.registration?.currentIndex ?? -1}
      </output>
      <output data-testid="formal-index">
        {navigator.registration?.formalIndex ?? -1}
      </output>
      <output data-testid="entry-order">
        {navigator.registration?.entries.map((entry) => entry.id).join("|") ??
          ""}
      </output>
      <output data-testid="current-visit-id">
        {navigator.registration?.entries[navigator.registration.currentIndex]
          ?.id ?? ""}
      </output>
      <output data-testid="registration-id">
        {navigator.registration?.id ?? ""}
      </output>
      <output data-testid="history-depth">{navigator.history.length}</output>
      <output data-testid="inspect-state">
        {String(navigator.isInspecting)}
      </output>
      <output data-testid="temporary-mode">
        {navigator.temporaryMode ?? "none"}
      </output>
      <button
        type="button"
        onClick={() => void navigator.navigate(1, "temporary", true)}
      >
        一時移動
      </button>
      <button
        type="button"
        onClick={() => void navigator.navigate(1, "inspect")}
      >
        確認移動
      </button>
    </>
  );
}

function ShoppingListHarness({
  initialItems,
  onUpdateItem = vi.fn(),
  onSelectItem = vi.fn(),
  onMoveItem = vi.fn(),
  onToggleSpaceCollapse = vi.fn(),
  onAddItem = vi.fn(),
  onBulkStatusChange = vi.fn(),
}: {
  initialItems: ShoppingItem[];
  onUpdateItem?: (item: ShoppingItem) => void;
  onSelectItem?: (itemId: string, columnType?: "execute" | "candidate") => void;
  onMoveItem?: (
    dragId: string,
    hoverId: string,
    targetColumn?: "execute" | "candidate",
    sourceColumn?: "execute" | "candidate",
  ) => void;
  onToggleSpaceCollapse?: (groupKey: string) => void;
  onAddItem?: (item: Omit<ShoppingItem, "id">) => void;
  onBulkStatusChange?: (
    groupKey: string,
    targetStatus: ShoppingItem["purchaseStatus"],
    items: ShoppingItem[],
  ) => void;
}) {
  const [items, setItems] = useState(initialItems);
  const [currentDay, setCurrentDay] = useState("Day1");
  const [navigationEnabled, setNavigationEnabled] = useState(true);
  const [listMounted, setListMounted] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setItems((current) =>
            current.map((item) =>
              item.id === "b" ? { ...item, title: `${item.title}更新` } : item,
            ),
          )
        }
      >
        表示更新
      </button>
      <button type="button" onClick={() => setItems([])}>
        全件除外
      </button>
      <button type="button" onClick={() => setItems(initialItems)}>
        表示復元
      </button>
      <button
        type="button"
        onClick={() =>
          setItems((current) => current.filter((item) => item.id !== "a"))
        }
      >
        Aを除外
      </button>
      <button
        type="button"
        onClick={() =>
          setItems((current) => current.filter((item) => item.id !== "b"))
        }
      >
        Bを除外
      </button>
      <button type="button" onClick={() => setCurrentDay("Day2")}>
        Day2へ切替
      </button>
      <button type="button" onClick={() => setNavigationEnabled(false)}>
        ナビ無効化
      </button>
      <button type="button" onClick={() => setNavigationEnabled(true)}>
        ナビ再有効化
      </button>
      <button type="button" onClick={() => setListMounted(false)}>
        一覧をアンマウント
      </button>
      {listMounted && (
        <ShoppingList
          items={items}
          onUpdateItem={onUpdateItem}
          onMoveItem={onMoveItem}
          onEditRequest={vi.fn()}
          onDeleteRequest={vi.fn()}
          selectedItemIds={new Set()}
          onSelectItem={onSelectItem}
          columnType="execute"
          currentDay={currentDay}
          layoutMode="pc"
          viewMode={navigationEnabled ? "execute" : "edit"}
          showSpaceGroups
          collapsedSpaces={new Set()}
          onToggleSpaceCollapse={onToggleSpaceCollapse}
          onAddItem={onAddItem}
          onBulkStatusChange={onBulkStatusChange}
          skipLimitedPurchaseForSingleQuantity
        />
      )}
      <NavigatorProbe />
    </>
  );
}

describe("ShoppingList execution space navigator integration", () => {
  beforeEach(() => {
    localStorage.clear();
    setWindowScrollY(0);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "scrollBy", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("builds visits from the visible list and preserves temporary history across updates", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[
            makeItem("a1", "A", "01a"),
            makeItem("a2", "A", "01a2"),
            makeItem("b", "B", "02a"),
          ]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("current-index")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("1"),
    );

    fireEvent.click(screen.getByRole("button", { name: "表示更新" }));
    await waitFor(() =>
      expect(screen.getByText("タイトルb更新")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("history-depth")).toHaveTextContent("1");
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
  });

  it("keeps the selected visit through no-op wheel input and resumes tracking after scroll position changes", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[makeItem("a", "A", "01a"), makeItem("b", "B", "02a")]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("1");

    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => resolve(undefined)),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("1");

    act(() => {
      fireEvent.wheel(window);
      window.dispatchEvent(new Event("scroll"));
    });
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => resolve(undefined)),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("1");

    setWindowScrollY(120);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("current-index")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
  });

  it("re-resolves a surviving target by visit id when filtering changes its index during navigation", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[
            makeItem("a", "A", "01a"),
            makeItem("b", "B", "02a"),
            makeItem("c", "C", "03a"),
          ]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("3"),
    );
    fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    fireEvent.click(screen.getByRole("button", { name: "Aを除外" }));

    await waitFor(() =>
      expect(screen.getByTestId("entry-order")).toHaveTextContent(
        "B-02a:none|C-03a:none",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-visit-id")).toHaveTextContent(
        "B-02a:none",
      ),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("0");
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("temporary");
  });

  it("does not restore a deleted target or leave currentIndex out of range when filtering changes during navigation", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[
            makeItem("a", "A", "01a"),
            makeItem("b", "B", "02a"),
            makeItem("c", "C", "03a"),
          ]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("3"),
    );
    fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    fireEvent.click(screen.getByRole("button", { name: "Bを除外" }));

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-visit-id")).toHaveTextContent(
        "C-03a:none",
      ),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("1");
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("none");
  });

  it("resets navigation refs and target lock when the registration id changes", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[makeItem("a", "A", "01a"), makeItem("b", "B", "02a")]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("registration-id")).toHaveTextContent(
        "execute:Day1",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    expect(screen.getByTestId("current-index")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Day2へ切替" }));
    await waitFor(() =>
      expect(screen.getByTestId("registration-id")).toHaveTextContent(
        "execute:Day2",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("none");
    expect(screen.getByTestId("current-index")).toHaveTextContent("0");
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
    expect(screen.getByTestId("current-visit-id")).toHaveTextContent(
      "A-01a:none",
    );
  });

  it("invalidates an in-flight navigation when the hook is disabled before scrolling completes", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[makeItem("a", "A", "01a"), makeItem("b", "B", "02a")]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    fireEvent.click(screen.getByRole("button", { name: "ナビ無効化" }));
    fireEvent.click(screen.getByRole("button", { name: "Bを除外" }));

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("0"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "ナビ再有効化" }));
    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("0");
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
    expect(screen.getByTestId("current-visit-id")).toHaveTextContent(
      "A-01a:none",
    );
  });

  it("does not commit temporary history after an in-flight navigator hook is unmounted", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[makeItem("a", "A", "01a"), makeItem("b", "B", "02a")]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    fireEvent.click(screen.getByRole("button", { name: "一覧をアンマウント" }));

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("0"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("none");

    await act(async () => {
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => resolve(undefined)),
      );
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => resolve(undefined)),
      );
      await Promise.resolve();
    });

    expect(screen.getByTestId("entry-count")).toHaveTextContent("0");
    expect(screen.getByTestId("history-depth")).toHaveTextContent("0");
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("none");
  });

  it("keeps navigator visits in the same hall and priority order as rendered space groups", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[
            makeItem("normal", "A", "01a"),
            makeItem("priority", "B", "02a", { priorityLevel: "priority" }),
            makeItem("highest", "C", "03a", { priorityLevel: "highest" }),
          ]}
        />
      </SpaceNavigatorProvider>,
    );

    const expectedOrder = "C-03a:highest|B-02a:priority|A-01a:none";
    await waitFor(() =>
      expect(screen.getByTestId("entry-order")).toHaveTextContent(
        expectedOrder,
      ),
    );

    const renderedHeadingOrder = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-space-navigation-anchor="heading"]',
      ),
    ).map((element) => element.dataset.spaceNavigationVisitId);
    expect(renderedHeadingOrder).toEqual(expectedOrder.split("|"));
  });

  it("returns to the formal visit and clears temporary history when filtering leaves zero items", async () => {
    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[makeItem("a", "A", "01a"), makeItem("b", "B", "02a")]}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "一時移動" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("temporary");

    fireEvent.click(screen.getByRole("button", { name: "全件除外" }));
    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("0"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("history-depth")).toHaveTextContent("0"),
    );
    expect(screen.getByTestId("temporary-mode")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "表示復元" }));
    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    expect(screen.getByTestId("current-index")).toHaveTextContent("0");
    expect(screen.getByTestId("formal-index")).toHaveTextContent("0");
    expect(screen.getByTestId("current-visit-id")).toHaveTextContent(
      "A-01a:none",
    );
  });

  it("makes inspect mode read-only while keeping links and heading collapse available", async () => {
    const onUpdateItem = vi.fn();
    const onSelectItem = vi.fn();
    const onMoveItem = vi.fn();
    const onToggleSpaceCollapse = vi.fn();
    const onAddItem = vi.fn();
    const onBulkStatusChange = vi.fn();

    render(
      <SpaceNavigatorProvider>
        <ShoppingListHarness
          initialItems={[
            makeItem("a", "A", "01a"),
            makeItem("b", "B", "02a", {
              url: "https://example.com/item",
              remarks: "確認用備考",
            }),
          ]}
          onUpdateItem={onUpdateItem}
          onSelectItem={onSelectItem}
          onMoveItem={onMoveItem}
          onToggleSpaceCollapse={onToggleSpaceCollapse}
          onAddItem={onAddItem}
          onBulkStatusChange={onBulkStatusChange}
        />
      </SpaceNavigatorProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("entry-count")).toHaveTextContent("2"),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "確認移動" }));
    });
    await waitFor(() =>
      expect(screen.getByTestId("inspect-state")).toHaveTextContent("true"),
    );

    const targetCard = screen
      .getByText("タイトルb")
      .closest('[data-item-id="b"]');
    expect(targetCard).not.toBeNull();
    const card = targetCard as HTMLElement;
    expect(card).toHaveAttribute("draggable", "false");
    expect(within(card).getByRole("checkbox")).toBeDisabled();
    expect(
      within(card).getByRole("button", { name: /Current status/i }),
    ).toBeDisabled();
    expect(
      within(card).getByRole("link", { name: "URLを開く" }),
    ).toHaveAttribute("href", "https://example.com/item");

    fireEvent.change(within(card).getByPlaceholderText("備考"), {
      target: { value: "変更されない" },
    });
    expect(onUpdateItem).not.toHaveBeenCalled();
    expect(onSelectItem).not.toHaveBeenCalled();
    expect(onMoveItem).not.toHaveBeenCalled();
    expect(onAddItem).not.toHaveBeenCalled();
    expect(onBulkStatusChange).not.toHaveBeenCalled();

    const heading = document.querySelector<HTMLElement>(
      '[data-space-group-key="B-02a"]',
    );
    expect(heading).not.toBeNull();
    fireEvent.click(heading!);
    expect(onToggleSpaceCollapse).toHaveBeenCalledWith("B-02a");
  });
});
