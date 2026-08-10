const beacon = (eventName, requestId) => {
  void globalThis
    .fetch(
      `/__foundation-performance-worker-beacon?scenario=xlsx-worker-timeout&event=${eventName}&requestId=${encodeURIComponent(requestId)}`,
      { method: "POST", body: eventName, keepalive: true },
    )
    .catch(() => undefined);
};

globalThis.addEventListener("message", (event) => {
  const message = event.data;
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
        eventName: "late-timeout-result-must-not-commit",
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
