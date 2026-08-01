// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LimitedPurchaseDialog from "./LimitedPurchaseDialog";

const renderDialog = (
  props: Partial<ComponentProps<typeof LimitedPurchaseDialog>> = {},
) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  render(
    <LimitedPurchaseDialog
      isOpen
      itemId="item-1"
      itemTitle="target item"
      initialPlanned={5}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />,
  );

  return { onSubmit, onCancel };
};

const getDialogInputs = () => {
  const dialog = screen.getByRole("dialog");
  const inputs = within(dialog).getAllByRole("textbox") as HTMLInputElement[];
  return {
    actualInput: inputs[0],
    plannedInput: inputs[1],
    dialog,
  };
};

const clickPrimaryButton = async (user: ReturnType<typeof userEvent.setup>) => {
  const dialog = screen.getByRole("dialog");
  const buttons = within(dialog).getAllByRole("button");
  await user.click(buttons[buttons.length - 1]);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LimitedPurchaseDialog", () => {
  it("prioritizes actual quantity errors when both fields are empty", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ initialPlanned: 5 });
    const { actualInput, plannedInput, dialog } = getDialogInputs();

    await user.clear(actualInput);
    await user.clear(plannedInput);
    await clickPrimaryButton(user);

    expect(
      within(dialog).getByText("実購入数を入力してください"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("treats non-decimal actual input as an integer error instead of blank", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    const { actualInput, plannedInput, dialog } = getDialogInputs();

    await user.type(actualInput, "abc");
    await user.clear(plannedInput);
    await clickPrimaryButton(user);

    expect(
      within(dialog).getByText("実購入数は整数で入力してください"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("defers with only planned quantity validation", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({ showDeferButton: true });
    const { actualInput, plannedInput, dialog } = getDialogInputs();

    await user.type(actualInput, "abc");
    await user.clear(plannedInput);
    await user.type(plannedInput, "06");
    await user.click(within(dialog).getAllByRole("button")[0]);

    expect(onSubmit).toHaveBeenCalledWith({ kind: "defer", planned: 6 });
  });

  it("converts to purchased after app confirmation when actual equals planned", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    const { onSubmit } = renderDialog();
    const { actualInput } = getDialogInputs();

    await user.type(actualInput, "5");
    await clickPrimaryButton(user);

    const confirmDialog = screen.getByRole("dialog", {
      name: "購入済として保存しますか？",
    });
    expect(confirmDialog).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    await user.click(
      within(confirmDialog).getByRole("button", { name: "購入済にする" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({ kind: "purchased", planned: 5 });
  });

  it("blocks saving and deferring when planned quantity is 1", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      initialPlanned: 1,
      showDeferButton: true,
    });
    const { actualInput, dialog } = getDialogInputs();

    await user.type(actualInput, "2");
    await clickPrimaryButton(user);

    expect(
      within(dialog).getByText(
        "限数として保存するには、購入予定数を2以上に変更してください。",
      ),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "この商品を後で入力" }),
    );

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows custom excess confirmation and can return to the input dialog", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    const { actualInput } = getDialogInputs();

    await user.type(actualInput, "6");
    await clickPrimaryButton(user);

    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(2);

    const excessDialog = dialogs[1];
    const excessButtons = within(excessDialog).getAllByRole("button");
    expect(excessButtons).toHaveLength(2);

    await user.click(excessButtons[0]);

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("converts to purchased from the custom excess confirmation", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();
    const { actualInput } = getDialogInputs();

    await user.type(actualInput, "8");
    await clickPrimaryButton(user);

    const excessDialog = screen.getAllByRole("dialog")[1];
    await user.click(within(excessDialog).getAllByRole("button")[1]);

    expect(onSubmit).toHaveBeenCalledWith({ kind: "purchased", planned: 5 });
  });

  it("resets inputs when the target item changes even if quantities are similar", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <LimitedPurchaseDialog
        isOpen
        itemId="item-a"
        initialActual={1}
        initialPlanned={5}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    let inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs[0]).toHaveValue("1");
    expect(inputs[1]).toHaveValue("5");

    await user.clear(inputs[0]);
    await user.type(inputs[0], "9");

    rerender(
      <LimitedPurchaseDialog
        isOpen
        itemId="item-b"
        initialActual={2}
        initialPlanned={6}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs[0]).toHaveValue("2");
    expect(inputs[1]).toHaveValue("6");
  });
});
