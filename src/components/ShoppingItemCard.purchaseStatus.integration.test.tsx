import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShoppingItemCard, {
  OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS,
} from "./ShoppingItemCard";
import type { ShoppingItem } from "../types/item";

const baseItem: ShoppingItem = {
  id: "item-1",
  circle: "Circle",
  eventDate: "Day1",
  block: "A",
  number: "01",
  title: "Title",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const defaultProps: ComponentProps<typeof ShoppingItemCard> = {
  item: baseItem,
  onUpdate: vi.fn(),
  isStriped: false,
  onEditRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
  isSelected: false,
  onSelectItem: vi.fn(),
  layoutMode: "pc",
  viewMode: "execute",
  skipLimitedPurchaseForSingleQuantity: true,
};

const renderCard = (
  overrides: Partial<ComponentProps<typeof ShoppingItemCard>> = {},
) => {
  const onUpdate = vi.fn();
  const props = {
    ...defaultProps,
    onUpdate,
    ...overrides,
    item: {
      ...baseItem,
      ...overrides.item,
    },
  };
  const renderResult = render(<ShoppingItemCard {...props} />);

  return {
    onUpdate,
    unmount: renderResult.unmount,
    rerender: (
      nextOverrides: Partial<ComponentProps<typeof ShoppingItemCard>>,
    ) => {
      renderResult.rerender(<ShoppingItemCard {...props} {...nextOverrides} />);
    },
  };
};

const getStatusButton = () =>
  screen.getByRole("button", { name: /Current status/i });
const getLimitedDialog = () =>
  screen.getByRole("dialog", { name: "限数購入の数量" });
const getDialog = () => screen.getByRole("dialog", { name: "購入状態を選択" });
const getOverlay = () => {
  const overlay = document.querySelector(
    '[data-purchase-status-overlay="item-1"]',
  );
  if (!overlay) throw new Error("purchase status overlay not found");
  return overlay as HTMLElement;
};

describe("ShoppingItemCard purchase status control", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { layoutMode: "pc" as const, viewMode: "execute" as const },
    { layoutMode: "smartphone" as const, viewMode: "edit" as const },
    { layoutMode: "smartphone" as const, viewMode: "focus" as const },
  ])(
    "keeps read-only semantics on form controls instead of the generic $layoutMode/$viewMode card",
    ({ layoutMode, viewMode }) => {
      renderCard({ layoutMode, viewMode, readOnly: true });

      const card = document.querySelector(
        "div.rounded-lg.transition-all.duration-300",
      );
      expect(card).toBeInTheDocument();
      expect(card).not.toHaveAttribute("aria-readonly");

      const remarks = screen.getByRole("textbox", { name: "利用者メモ" });
      expect(remarks).toHaveAttribute("readonly");
      expect(remarks).toHaveAttribute("aria-readonly", "true");
    },
  );

  it.each([
    {
      purchaseStatus: "None" as const,
      label: "未購入",
      classes: ["text-slate-600", "dark:text-slate-300"],
    },
    {
      purchaseStatus: "Postpone" as const,
      label: "後回し",
      classes: ["text-purple-600", "dark:text-purple-300"],
    },
    {
      purchaseStatus: "Late" as const,
      label: "遅参",
      classes: ["text-blue-600", "dark:text-blue-300"],
    },
  ])(
    "uses AA status text colors for $purchaseStatus",
    ({ purchaseStatus, label, classes }) => {
      renderCard({ item: { ...baseItem, purchaseStatus } });

      expect(screen.getByText(label, { selector: "span" })).toHaveClass(
        ...classes,
      );
    },
  );

  it("uses readable dark-mode colors for the PC quantity and price labels", () => {
    renderCard({ item: { ...baseItem, purchaseStatus: "Late" } });

    expect(screen.getByText("数量")).toHaveClass(
      "text-slate-600",
      "dark:text-slate-300",
    );
    expect(screen.getByText("購入金額")).toHaveClass(
      "text-slate-600",
      "dark:text-slate-300",
    );
  });

  it("keeps cycle mode as the default click behavior", () => {
    const { onUpdate } = renderCard();

    fireEvent.click(getStatusButton());

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseStatus: "Purchased" }),
    );
  });

  it("opens the limited purchase dialog without saving when cycle reaches LimitedPurchase", () => {
    const { onUpdate } = renderCard({
      item: { ...baseItem, purchaseStatus: "Late", quantity: 5 },
    });

    fireEvent.click(getStatusButton());

    expect(getLimitedDialog()).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(
      screen.queryByRole("dialog", { name: "限数購入の数量" }),
    ).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("converts limited purchase to purchased after app confirmation when actual equals planned", () => {
    const { onUpdate } = renderCard({
      item: {
        ...baseItem,
        purchaseStatus: "LimitedPurchase",
        quantity: 5,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "-/5" }));

    const dialog = getLimitedDialog();
    const [actualInput] = screen
      .getAllByRole("textbox")
      .filter((input) => dialog.contains(input));
    fireEvent.change(actualInput, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "購入済として保存しますか？" }),
      ).getByRole("button", { name: "購入済にする" }),
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseStatus: "Purchased",
        quantity: 5,
      }),
    );
    expect(onUpdate.mock.calls[0][0]).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });

  it("opens a three-choice confirmation for explicit radial LimitedPurchase on quantity 1", () => {
    const { onUpdate } = renderCard({
      purchaseStatusControlMode: "radial",
      item: { ...baseItem, purchaseStatus: "None", quantity: 1 },
    });

    fireEvent.click(getStatusButton());
    fireEvent.click(
      screen.getByRole("radio", { name: "LimitedPurchaseに変更" }),
    );

    const choiceDialog = screen.getByRole("dialog", {
      name: "限数にしますか？",
    });
    expect(choiceDialog).toBeInTheDocument();
    expect(screen.getByText(/数量が1のため/)).toBeInTheDocument();

    fireEvent.click(
      within(choiceDialog).getByRole("button", { name: "購入済" }),
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseStatus: "Purchased", quantity: 1 }),
    );
  });

  it("opens limited input from the quantity 1 three-choice confirmation without saving immediately", () => {
    const { onUpdate } = renderCard({
      purchaseStatusControlMode: "radial",
      item: { ...baseItem, purchaseStatus: "None", quantity: 1 },
    });

    fireEvent.click(getStatusButton());
    fireEvent.click(
      screen.getByRole("radio", { name: "LimitedPurchaseに変更" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "限数にしますか？" }),
      ).getByRole("button", {
        name: "限数",
      }),
    );

    expect(getLimitedDialog()).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("rechecks the latest item before saving limited input opened from the three-choice confirmation", () => {
    let latestItem: ShoppingItem = {
      ...baseItem,
      purchaseStatus: "None",
      quantity: 1,
    };
    const onNotify = vi.fn();
    const { onUpdate } = renderCard({
      purchaseStatusControlMode: "radial",
      item: latestItem,
      getLatestItemById: () => latestItem,
      onNotify,
    });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole("radio", { name: /^LimitedPurchase/ }));

    latestItem = { ...baseItem, purchaseStatus: "None", quantity: 2 };
    const choiceDialog = screen.getByRole("dialog", {
      name: "限数にしますか？",
    });
    fireEvent.click(within(choiceDialog).getByRole("button", { name: "限数" }));

    const dialog = getLimitedDialog();
    const [actualInput] = screen
      .getAllByRole("textbox")
      .filter((input) => dialog.contains(input));
    fireEvent.change(actualInput, { target: { value: "1" } });

    latestItem = { ...baseItem, purchaseStatus: "SoldOut", quantity: 2 };
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith(
      "対象のアイテムはすでに別の購入状態に変更されています",
    );
    expect(
      screen.queryByRole("button", { name: "保存" }),
    ).not.toBeInTheDocument();
  });

  it("converts limited purchase to purchased from the excess confirmation dialog", () => {
    const { onUpdate } = renderCard({
      item: {
        ...baseItem,
        purchaseStatus: "LimitedPurchase",
        quantity: 5,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "-/5" }));

    const dialog = getLimitedDialog();
    const [actualInput] = screen
      .getAllByRole("textbox")
      .filter((input) => dialog.contains(input));
    fireEvent.change(actualInput, { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const excessDialog = screen.getAllByRole("dialog")[1];
    fireEvent.click(
      within(excessDialog).getByRole("button", { name: "購入済にする" }),
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseStatus: "Purchased",
        quantity: 5,
      }),
    );
    expect(onUpdate.mock.calls[0][0]).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });

  it("does not save a limited dialog result when the latest item was deleted", () => {
    const { onUpdate } = renderCard({
      item: { ...baseItem, purchaseStatus: "Late", quantity: 5 },
      getLatestItemById: () => undefined,
    });

    fireEvent.click(getStatusButton());

    const dialog = getLimitedDialog();
    const [actualInput] = screen
      .getAllByRole("textbox")
      .filter((input) => dialog.contains(input));
    fireEvent.change(actualInput, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "限数購入の数量" }),
    ).not.toBeInTheDocument();
  });

  it("opens radial dialog with dialog aria on the status button", () => {
    renderCard({ purchaseStatusControlMode: "radial" });

    const button = getStatusButton();
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(getDialog()).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "購入状態" }),
    ).toBeInTheDocument();
  });

  it("positions the radial dialog at the status button center", () => {
    renderCard({ purchaseStatusControlMode: "radial" });

    const button = getStatusButton();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      bottom: 260,
      height: 60,
      left: 100,
      right: 180,
      top: 200,
      width: 80,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    });

    fireEvent.click(button);

    const menu = document.querySelector<HTMLElement>(
      '[data-purchase-status-menu="item-1"]',
    );
    expect(menu).not.toBeNull();
    expect(menu).toHaveAttribute("data-layout-left", "140px");
    expect(menu).toHaveAttribute("data-layout-top", "230px");
    expect(menu).not.toHaveAttribute("style");
  });

  it("selects an arbitrary status directly and closes", () => {
    const { onUpdate } = renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole("radio", { name: "Lateに変更" }));

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseStatus: "Late" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "購入状態を選択" }),
    ).not.toBeInTheDocument();
    expect(getStatusButton()).toHaveFocus();
  });

  it("allows deferring quantity input after selecting limited purchase from the radial menu", () => {
    const { onUpdate } = renderCard({
      purchaseStatusControlMode: "radial",
      item: { ...baseItem, quantity: 5 },
    });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole("radio", { name: /^LimitedPurchase/ }));

    const dialog = getLimitedDialog();
    fireEvent.click(within(dialog).getAllByRole("button")[0]);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseStatus: "LimitedPurchase",
        quantity: 5,
      }),
    );
    expect(onUpdate.mock.calls[0][0]).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });

  it("notifies when limited quantity input is deferred", () => {
    const onLimitedPurchaseDefer = vi.fn();
    const { onUpdate } = renderCard({
      purchaseStatusControlMode: "radial",
      item: { ...baseItem, quantity: 5 },
      onLimitedPurchaseDefer,
    });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole("radio", { name: /^LimitedPurchase/ }));
    fireEvent.click(screen.getByRole("button", { name: "この商品を後で入力" }));

    expect(onLimitedPurchaseDefer).toHaveBeenCalledTimes(1);
    expect(onLimitedPurchaseDefer).toHaveBeenCalledWith(
      expect.objectContaining({ id: baseItem.id }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not notify defer when limited quantity input is saved", () => {
    const onLimitedPurchaseDefer = vi.fn();
    const { onUpdate } = renderCard({
      item: {
        ...baseItem,
        purchaseStatus: "LimitedPurchase",
        quantity: 5,
      },
      onLimitedPurchaseDefer,
    });

    fireEvent.click(screen.getByRole("button", { name: "-/5" }));

    const dialog = getLimitedDialog();
    const [actualInput] = screen
      .getAllByRole("textbox")
      .filter((input) => dialog.contains(input));
    fireEvent.change(actualInput, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onLimitedPurchaseDefer).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not notify defer when limited quantity input becomes purchased", () => {
    const onLimitedPurchaseDefer = vi.fn();
    const { onUpdate } = renderCard({
      item: {
        ...baseItem,
        purchaseStatus: "LimitedPurchase",
        quantity: 5,
      },
      onLimitedPurchaseDefer,
    });

    fireEvent.click(screen.getByRole("button", { name: "-/5" }));

    const dialog = getLimitedDialog();
    const [actualInput] = screen
      .getAllByRole("textbox")
      .filter((input) => dialog.contains(input));
    fireEvent.change(actualInput, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "購入済として保存しますか？" }),
      ).getByRole("button", { name: "購入済にする" }),
    );

    expect(onLimitedPurchaseDefer).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("closes without update when selecting the current status", () => {
    const { onUpdate } = renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole("radio", { name: "Noneに変更" }));

    expect(onUpdate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "購入状態を選択" }),
    ).not.toBeInTheDocument();
  });

  it("cancels by cancel button and Escape without update", () => {
    const { onUpdate } = renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(getStatusButton()).toHaveFocus();

    fireEvent.click(getStatusButton());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "購入状態を選択" }),
    ).not.toBeInTheDocument();
    expect(getStatusButton()).toHaveFocus();
  });

  it("does not prevent default for overlay pointer events", () => {
    renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    const overlay = getOverlay();
    const PointerEventCtor = window.PointerEvent ?? MouseEvent;
    const pointerDown = new PointerEventCtor("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    const pointerUp = new PointerEventCtor("pointerup", {
      bubbles: true,
      cancelable: true,
    });

    overlay.dispatchEvent(pointerDown);
    overlay.dispatchEvent(pointerUp);

    expect(pointerDown.defaultPrevented).toBe(false);
    expect(pointerUp.defaultPrevented).toBe(false);
  });

  it("prevents default for overlay mouse and click events", () => {
    renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    const overlay = getOverlay();
    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    const mouseUp = new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    overlay.dispatchEvent(mouseDown);
    overlay.dispatchEvent(mouseUp);
    overlay.dispatchEvent(click);

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(mouseUp.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
  });

  it("keeps overlay until click or fallback after pointerup", () => {
    vi.useFakeTimers();
    renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    fireEvent.pointerUp(getOverlay());

    expect(getOverlay()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
    });

    expect(
      screen.queryByRole("dialog", { name: "購入状態を選択" }),
    ).not.toBeInTheDocument();
  });

  it("clears delayed pointerup fallback when captured click arrives", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    const overlay = getOverlay();
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
    });
    expect(
      screen.queryByRole("dialog", { name: "購入状態を選択" }),
    ).not.toBeInTheDocument();
  });

  it("clears delayed pointerup fallback when the menu receives input or unmounts", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = renderCard({ purchaseStatusControlMode: "radial" });

    fireEvent.click(getStatusButton());
    fireEvent.pointerUp(getOverlay());
    fireEvent.pointerDown(getDialog());

    expect(clearTimeoutSpy).toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
    });
    expect(getDialog()).toBeInTheDocument();

    fireEvent.pointerUp(getOverlay());
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("closes on mode change without stealing external focus", () => {
    const onUpdate = vi.fn();
    const props = {
      ...defaultProps,
      onUpdate,
      purchaseStatusControlMode: "radial" as const,
    };
    const { rerender } = render(
      <>
        <input aria-label="settings focus target" />
        <ShoppingItemCard {...props} />
      </>,
    );

    fireEvent.click(getStatusButton());
    screen.getByLabelText("settings focus target").focus();

    rerender(
      <>
        <input aria-label="settings focus target" />
        <ShoppingItemCard {...props} purchaseStatusControlMode="cycle" />
      </>,
    );

    expect(
      screen.queryByRole("dialog", { name: "購入状態を選択" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("settings focus target")).toHaveFocus();
  });

  it("focuses current status on open and leaves controls tabbable", async () => {
    const user = userEvent.setup();
    renderCard({
      purchaseStatusControlMode: "radial",
      item: { ...baseItem, purchaseStatus: "Postpone" },
    });

    fireEvent.click(getStatusButton());

    expect(screen.getByRole("radio", { name: "Postponeに変更" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "キャンセル" }),
    ).not.toHaveAttribute("tabindex", "-1");

    await user.tab();
    expect(document.activeElement).toBeInstanceOf(HTMLElement);
  });

  it("stops portal overlay events from React parents and document bubble mouse listeners", () => {
    const parentClick = vi.fn();
    const documentMouseDown = vi.fn();
    const documentMouseUp = vi.fn();
    const documentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ShoppingItemCard
          {...defaultProps}
          purchaseStatusControlMode="radial"
        />
      </div>,
    );

    fireEvent.click(getStatusButton());
    parentClick.mockClear();
    document.addEventListener("mousedown", documentMouseDown);
    document.addEventListener("mouseup", documentMouseUp);
    document.addEventListener("click", documentClick);

    const overlay = getOverlay();
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    fireEvent.click(overlay);

    expect(parentClick).not.toHaveBeenCalled();
    expect(documentMouseDown).not.toHaveBeenCalled();
    expect(documentMouseUp).not.toHaveBeenCalled();
    expect(documentClick).not.toHaveBeenCalled();

    document.removeEventListener("mousedown", documentMouseDown);
    document.removeEventListener("mouseup", documentMouseUp);
    document.removeEventListener("click", documentClick);
  });

  it("documents jsdom click-through limits while blocking background click in simulated bubbling", () => {
    // jsdom cannot prove real coordinate click-through. A Playwright/browser check is
    // strongly recommended for the final guarantee that overlay coordinates do not
    // trigger background UI.
    const backgroundClick = vi.fn();
    render(
      <>
        <button onClick={backgroundClick}>background action</button>
        <ShoppingItemCard
          {...defaultProps}
          purchaseStatusControlMode="radial"
        />
      </>,
    );

    fireEvent.click(getStatusButton());
    fireEvent.click(getOverlay());

    expect(backgroundClick).not.toHaveBeenCalled();
  });

  it("enables radial behavior in smartphone edit and execute layouts", () => {
    const { rerender } = renderCard({
      purchaseStatusControlMode: "radial",
      layoutMode: "smartphone",
      viewMode: "edit",
    });

    expect(getStatusButton()).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(getStatusButton());
    expect(getDialog()).toBeInTheDocument();

    rerender({
      purchaseStatusControlMode: "radial",
      layoutMode: "smartphone",
      viewMode: "execute",
    });
    expect(getStatusButton()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("uses the dense smartphone focus card without inactive selection controls", () => {
    renderCard({
      layoutMode: "smartphone",
      viewMode: "focus",
      item: {
        ...baseItem,
        url: "https://example.com/item",
        remarks: "memo",
      },
    });

    const card = screen.getByTestId("shopping-item-card-smartphone-compact");
    expect(card.querySelector("[data-drag-handle]")).toBeNull();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "利用者メモ" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "購入予定数量" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "購入金額" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "URLを開く" })).toBeInTheDocument();
    expect(getStatusButton()).toBeInTheDocument();
  });

  it("uses the dense smartphone execute card without selection controls", () => {
    renderCard({
      layoutMode: "smartphone",
      viewMode: "execute",
      hallIndex: 0,
    });

    const card = screen.getByTestId("shopping-item-card-smartphone-compact");
    expect(card.querySelector("[data-drag-handle]")).toBeNull();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "購入予定数量" }),
    ).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "購入金額" })).toBeEnabled();
    expect(getStatusButton()).toBeEnabled();
  });
});
