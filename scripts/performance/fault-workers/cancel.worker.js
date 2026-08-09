const beacon = (eventName, requestId) => {
  void globalThis
    .fetch(
      `/__foundation-performance-worker-beacon?scenario=xlsx-worker-cancel&event=${eventName}&requestId=${encodeURIComponent(requestId)}`,
      { method: "POST", body: eventName, keepalive: true },
    )
    .catch(() => undefined);
};

globalThis.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "XLSX_IMPORT_REQUEST") {
    globalThis.postMessage({
      type: "XLSX_PROGRESS",
      protocolVersion: 1,
      requestId: message.requestId,
      kind: "event-import",
      progress: { phase: "parse", completed: 1, total: 2 },
    });
    return;
  }
  if (message?.type !== "XLSX_CANCEL_REQUEST") return;
  beacon("cancel-received", message.requestId);
  globalThis.postMessage({
    type: "XLSX_IMPORT_RESULT",
    protocolVersion: 1,
    requestId: message.requestId,
    kind: "event-import",
    result: {
      kind: "event-import",
      value: {
        success: true,
        eventName: "late-result-must-not-commit",
        items: [],
        errors: [],
      },
    },
  });
  beacon("late-result-sent", message.requestId);
  globalThis.postMessage({
    type: "XLSX_ERROR",
    protocolVersion: 1,
    requestId: message.requestId,
    kind: "event-import",
    errorCode: "ABORTED",
  });
  beacon("cancel-ack-sent", message.requestId);
});
