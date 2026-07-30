import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AppOverlayLayer from "./AppOverlayLayer";

describe("AppOverlayLayer move plan integration", () => {
  it("shows smartphone selected/effective counts and submits explicit IDs", () => {
    const handleMoveToExecuteColumn = vi.fn();
    const props = {
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
      editDialogItem: null,
      itemToDelete: null,
      showUpdateConfirmation: false,
      showUrlUpdateDialog: false,
      showRenameDialog: false,
      showExportOptions: false,
      blockDefinitionMode: false,
      simpleHallDefinitionMode: false,
      globalHallOrderPanelOpen: false,
      hallDefinitionMode: false,
      visitListPanelOpen: false,
      showVisitListConfirmDialog: false,
      vertexSelectionMode: null,
      mapImportDialogOpen: false,
      activeEventName: "Event",
      mainContentVisible: true,
      currentMode: "edit",
      layoutMode: "smartphone",
      selectedItemIds: new Set(["a", "b"]),
      showMoveButtons: true,
      hasCandidateSelection: true,
      candidateMovePlan: {
        requested: ["a", "b"],
        effective: ["a", "b", "c"],
        implicit: ["c"],
        excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
      },
      handleMoveToExecuteColumn,
      hasExecuteSelection: false,
      executeMovePlan: {
        requested: [],
        effective: [],
        implicit: [],
        excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
      },
      handleRemoveFromExecuteColumn: vi.fn(),
      handleBulkSort: vi.fn(),
      handleClearSelection: vi.fn(),
      smartInsertToast: null,
    } as unknown as ComponentProps<typeof AppOverlayLayer>;

    render(<AppOverlayLayer {...props} />);

    const moveButton = screen.getByRole("button", {
      name: "⇦実行列へ (選択2件（移動3件）)",
    });
    fireEvent.click(moveButton);

    expect(handleMoveToExecuteColumn).toHaveBeenCalledWith(["a", "b"]);
  });
});
