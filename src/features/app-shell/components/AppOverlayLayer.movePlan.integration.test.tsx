import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialAppOverlayState,
  reduceAppOverlayState,
  selectAppOverlayReadModel,
} from "../../../app/state/appOverlayState";
import AppOverlayLayer from "./AppOverlayLayer";

describe("AppOverlayLayer move plan integration", () => {
  it("shows smartphone selected/effective counts and submits explicit IDs", () => {
    const handleMoveToExecuteColumn = vi.fn();
    const overlay = selectAppOverlayReadModel(
      reduceAppOverlayState(createInitialAppOverlayState(), {
        type: "status/show-smart-insert-toast",
        requestId: "toast-1",
        message: "保存しました",
        tone: "success",
      }),
    );
    const props = {
      overlay,
      overlayCommands: {
        item: {},
        event: {},
        mapEditor: {},
      },
      model: {
        item: {
          items: [
            {
              id: "a",
              circle: "A",
              eventDate: "Day1",
              block: "A",
              number: "01",
              title: "",
              price: null,
              purchaseStatus: "None",
              quantity: 1,
              remarks: "",
            },
          ],
        },
        event: { activeEventName: "Event" },
        mapEditor: {},
        visitList: { layoutMode: "smartphone" },
        imports: {},
        list: {
          mainContentVisible: true,
          currentMode: "edit",
          selectedItemIds: new Set(["a", "b"]),
          showMoveButtons: true,
          hasCandidateSelection: true,
          candidateMovePlan: {
            requested: ["a", "b"],
            effective: ["a", "b", "c"],
            implicit: ["c"],
            excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
          },
          hasExecuteSelection: false,
          executeMovePlan: {
            requested: [],
            effective: [],
            implicit: [],
            excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
          },
        },
      },
      actions: {
        item: {},
        event: {},
        mapEditor: {},
        visitList: {},
        imports: {},
        list: {
          handleMoveToExecuteColumn,
          handleRemoveFromExecuteColumn: vi.fn(),
          handleBulkSort: vi.fn(),
          handleClearSelection: vi.fn(),
        },
      },
    } as unknown as ComponentProps<typeof AppOverlayLayer>;

    render(<AppOverlayLayer {...props} />);

    const moveButton = screen.getByRole("button", {
      name: "⇦実行列へ (選択2件（移動3件）)",
    });
    fireEvent.click(moveButton);

    expect(handleMoveToExecuteColumn).toHaveBeenCalledWith(["a", "b"]);

    const toast = screen.getByText("保存しました");
    expect(toast).toHaveClass(
      "bg-green-700",
      "animate-attention-outline",
      "attention-outline-green",
    );
    expect(toast).not.toHaveClass("animate-pulse");
  });
});
