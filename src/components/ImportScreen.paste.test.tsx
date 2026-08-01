// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import ImportScreen from "./ImportScreen";

const renderImportScreen = (
  onBulkAdd: ComponentProps<typeof ImportScreen>["onBulkAdd"] = vi.fn(),
) =>
  render(
    <ImportScreen
      onBulkAdd={onBulkAdd}
      activeEventName={null}
      itemToEdit={null}
      onUpdateItem={vi.fn()}
      onDoneEditing={vi.fn()}
    />,
  );

const getTextarea = (label: string) =>
  screen.getByLabelText(label) as HTMLTextAreaElement;

const pasteIntoCircle = (text: string) => {
  fireEvent.paste(getTextarea("M列 サークル名"), {
    clipboardData: {
      getData: () => text,
    },
  });
};

describe("ImportScreenの7列貼り付け", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("7列目を備考へ反映し、手入力済みのURLは変更しない", () => {
    renderImportScreen();
    const urlTextarea = getTextarea("URL（7列貼り付け対象外）");
    fireEvent.change(urlTextarea, {
      target: { value: "https://manual.example" },
    });

    pasteIntoCircle("サークルA\t1日目\t東A\t01a\t新刊\t1000\t取り置き希望");

    expect(getTextarea("M列 サークル名")).toHaveValue("サークルA");
    expect(getTextarea("N列 参加日")).toHaveValue("1日目");
    expect(getTextarea("O列 ブロック")).toHaveValue("東A");
    expect(getTextarea("P列 番号")).toHaveValue("01a");
    expect(getTextarea("Q列 タイトル")).toHaveValue("新刊");
    expect(getTextarea("R列 価格")).toHaveValue("1000");
    expect(getTextarea("W列 備考")).toHaveValue("取り置き希望");
    expect(urlTextarea).toHaveValue("https://manual.example");
  });

  it("列数が不正なら警告し、既存の全textareaを変更しない", () => {
    renderImportScreen();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const initialValues = [
      ["M列 サークル名", "既存サークル"],
      ["N列 参加日", "既存日"],
      ["O列 ブロック", "既存ブロック"],
      ["P列 番号", "既存番号"],
      ["Q列 タイトル", "既存タイトル"],
      ["R列 価格", "既存価格"],
      ["W列 備考", "既存備考"],
      ["URL（7列貼り付け対象外）", "https://existing.example"],
    ] as const;
    initialValues.forEach(([label, value]) => {
      fireEvent.change(getTextarea(label), { target: { value } });
    });

    pasteIntoCircle(
      [
        "正常\t1日目\t東A\t01a\t新刊\t1000\t備考",
        "不足\t2日目\t西B\t02b\t既刊\t500",
      ].join("\n"),
    );

    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining("2行目（6列・不足）"),
    );
    initialValues.forEach(([label, value]) => {
      expect(getTextarea(label)).toHaveValue(value);
    });
  });

  it("同名確認へ進む場合は入力内容を消さない", () => {
    const onBulkAdd = vi.fn(() => false);
    renderImportScreen(onBulkAdd);
    fireEvent.change(screen.getByLabelText("即売会名"), {
      target: { value: "既存イベント" },
    });
    pasteIntoCircle("サークルA\t1日目\t東A\t01a\t新刊\t1000\t取り置き希望");

    fireEvent.click(screen.getByRole("button", { name: "リストを作成" }));

    expect(onBulkAdd).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("即売会名")).toHaveValue("既存イベント");
    expect(getTextarea("M列 サークル名")).toHaveValue("サークルA");
    expect(getTextarea("W列 備考")).toHaveValue("取り置き希望");
  });

  it("新規URL取込でも不正数量の行を丸めず除外する", async () => {
    const makeCsvRow = (number: string, quantity: string) => {
      const cells = Array.from({ length: 27 }, () => "");
      cells[12] = "サークルA";
      cells[13] = "1日目";
      cells[14] = "東A";
      cells[15] = number;
      cells[16] = "新刊";
      cells[17] = "1000";
      cells[22] = "備考";
      cells[26] = quantity;
      return cells.join(",");
    };
    const csv = [
      Array.from({ length: 27 }, (_, index) =>
        index === 12 ? "サークル名" : `列${index}`,
      ).join(","),
      makeCsvRow("01a", "20"),
      makeCsvRow("02a", "21"),
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: vi.fn().mockResolvedValue(csv),
      }),
    );
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const onBulkAdd = vi.fn<ComponentProps<typeof ImportScreen>["onBulkAdd"]>(
      () => true,
    );
    renderImportScreen(onBulkAdd);
    fireEvent.change(screen.getByLabelText("即売会名"), {
      target: { value: "新イベント" },
    });
    fireEvent.change(
      screen.getByLabelText("スプレッドシートURLからインポート"),
      {
        target: {
          value: "https://docs.google.com/spreadsheets/d/example-document/edit",
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "URLからインポート" }));

    await waitFor(() => expect(onBulkAdd).toHaveBeenCalledTimes(1));
    const importedItems = onBulkAdd.mock.calls[0][1];
    expect(importedItems).toHaveLength(1);
    expect(importedItems[0]).toMatchObject({ number: "01a", quantity: 20 });
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining("21"));
    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining("1行は取り込みませんでした"),
    );
  });
});
