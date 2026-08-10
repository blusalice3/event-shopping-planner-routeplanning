import { createHash } from "node:crypto";
import {
  ZipReader,
  ZipWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
} from "@zip.js/zip.js";
import ExcelJS from "exceljs";
import { canonicalizeJson } from "../lib/canonical-json.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FIXED_ZIP_DATE = new Date("1980-01-02T00:00:00.000Z");

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const canonicalizeZipBytes = async (sourceBytes) => {
  const reader = new ZipReader(new Uint8ArrayReader(sourceBytes));
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    dataDescriptor: false,
    extendedTimestamp: false,
    keepOrder: true,
    level: 9,
    zip64: false,
  });
  try {
    const entries = await reader.getEntries();
    entries.sort((left, right) => compareUtf8(left.filename, right.filename));
    const paths = new Set();
    for (const entry of entries) {
      if (
        entry.encrypted ||
        entry.filename.length === 0 ||
        paths.has(entry.filename)
      ) {
        throw new Error("Source workbook ZIP contains an invalid entry");
      }
      paths.add(entry.filename);
      const contents = entry.directory
        ? undefined
        : await entry.getData(new Uint8ArrayWriter());
      await writer.add(
        entry.filename,
        contents === undefined ? undefined : new Uint8ArrayReader(contents),
        {
          creationDate: FIXED_ZIP_DATE,
          dataDescriptor: false,
          directory: entry.directory,
          extendedTimestamp: false,
          lastAccessDate: FIXED_ZIP_DATE,
          lastModDate: FIXED_ZIP_DATE,
          level: 9,
          zip64: false,
        },
      );
    }
    return Buffer.from(await writer.close(undefined, { zip64: false }));
  } finally {
    await reader.close();
  }
};

const makeSeededText = (seed, length) => {
  let state = seed >>> 0;
  let value = "";
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    value += String.fromCharCode(33 + ((state >>> 0) % 90));
  }
  return value;
};

export const buildCanonicalItems = ({
  rowCount,
  seed,
  paddingCharacters = 0,
}) => {
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount < 1 ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    !Number.isSafeInteger(paddingCharacters) ||
    paddingCharacters < 0
  ) {
    throw new Error("Canonical item generator input is invalid");
  }
  return Array.from({ length: rowCount }, (_, index) => {
    const suffix = String(index + 1).padStart(6, "0");
    return {
      id: `canonical-item-${suffix}`,
      circle: `計測サークル${suffix}`,
      eventDate: "1日目",
      block: `A${String(Math.floor(index / 100) + 1).padStart(3, "0")}`,
      number: String((index % 100) + 1).padStart(2, "0"),
      title: `計測頒布物${suffix}`,
      price: null,
      purchaseStatus: "None",
      quantity: 1,
      remarks:
        paddingCharacters === 0
          ? ""
          : makeSeededText(seed + index * 2_654_435_761, paddingCharacters),
      priorityLevel: "none",
      protectionLevel: "none",
      source: "app",
    };
  });
};

export const canonicalEventItemsSemanticSha256 = (eventName, items) => {
  if (
    typeof eventName !== "string" ||
    eventName.length === 0 ||
    !Array.isArray(items)
  ) {
    throw new Error("Canonical event semantic input is invalid");
  }
  const normalizedItems = items.map((item) => ({
    block: item.block ?? "",
    catalogPrice: item.catalogPrice ?? null,
    circle: item.circle ?? "",
    eventDate: item.eventDate ?? "",
    id: item.id ?? "",
    limitedPurchasedQuantity: item.limitedPurchasedQuantity ?? null,
    manualHallId: item.manualHallId ?? "",
    number: item.number ?? "",
    price: item.price ?? null,
    priorityLevel: item.priorityLevel ?? "none",
    protectionLevel: item.protectionLevel ?? "none",
    purchaseStatus: item.purchaseStatus ?? "None",
    quantity: item.quantity ?? 1,
    remarks: item.remarks ?? "",
    sheetRemarks: item.sheetRemarks ?? "",
    source: item.source ?? "app",
    title: item.title ?? "",
    url: item.url ?? "",
  }));
  return sha256(
    Buffer.from(
      canonicalizeJson({ eventName, items: normalizedItems }),
      "utf8",
    ),
  );
};

export const canonicalPersistencePayloadBytes = (payload) =>
  Buffer.from(canonicalizeJson(payload), "utf8");

export const buildCanonicalBackup = ({ rowCount, seed, eventName }) => {
  const items = buildCanonicalItems({ rowCount, seed });
  const document = {
    kind: "event-shopping-planner-backup",
    version: 1,
    exportedAt: "2026-08-09T00:00:00.000Z",
    eventSettings: { blockDetectionSettings: {} },
    data: {
      eventLists: { [eventName]: items },
      eventMetadata: {},
      executeModeItems: { [eventName]: { "1日目": [] } },
      dayModes: { [eventName]: { "1日目": "edit" } },
      mapData: {},
      mapRotationSettings: {},
      routeSettings: {},
      hallDefinitions: {},
      hallRouteSettings: {},
      mapViewportSettings: {},
    },
  };
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return Object.freeze({
    bytes,
    document,
    semanticSha256: canonicalEventItemsSemanticSha256(eventName, items),
    payloadSha256: sha256(bytes),
  });
};

export const buildCanonicalExportSnapshot = ({
  rowCount,
  seed,
  paddingCharacters = 0,
  eventName,
}) => {
  const items = buildCanonicalItems({
    rowCount,
    seed,
    paddingCharacters,
  });
  const snapshot = {
    schemaVersion: 1,
    eventName,
    items,
    options: {
      includeItems: true,
      includeLayoutInfo: true,
      includeMapData: false,
      includeRouteInfo: false,
      format: "full",
    },
    additionalData: {
      executeModeItems: { [eventName]: { "1日目": [] } },
      dayModes: { [eventName]: { "1日目": "edit" } },
    },
  };
  return Object.freeze({
    snapshot,
    semanticSha256: sha256(Buffer.from(JSON.stringify(snapshot), "utf8")),
  });
};

const WORKBOOK_COLUMNS = Object.freeze([
  ["ID", "id"],
  ["サークル名", "circle"],
  ["参加日", "eventDate"],
  ["ブロック", "block"],
  ["ナンバー", "number"],
  ["タイトル", "title"],
  ["価格", "price"],
  ["数量", "quantity"],
  ["ステータス", "purchaseStatus"],
  ["備考", "remarks"],
  ["URL", "url"],
  ["優先度", "priorityLevel"],
  ["保護レベル", "protectionLevel"],
  ["追加元", "source"],
  ["手動ホール", "manualHallId"],
  ["限数実購入数", "limitedPurchasedQuantity"],
  ["カタログ価格", "catalogPrice"],
  ["シート備考", "sheetRemarks"],
]);

export const buildCanonicalEventWorkbookBytes = async ({
  rowCount,
  seed,
  paddingCharacters = 0,
}) => {
  const items = buildCanonicalItems({
    rowCount,
    seed,
    paddingCharacters,
  });
  const fixedDate = new Date("2026-08-09T00:00:00.000Z");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "event-shopping-planner-performance-v1";
  workbook.created = fixedDate;
  workbook.modified = fixedDate;
  workbook.lastPrinted = fixedDate;
  const sheet = workbook.addWorksheet("アイテムデータ", {
    properties: { defaultRowHeight: 15 },
  });
  sheet.columns = WORKBOOK_COLUMNS.map(([header, key]) => ({
    header,
    key,
    width: 16,
  }));
  for (const item of items) {
    sheet.addRow({
      ...item,
      url: "",
      priorityLevel: "none",
      protectionLevel: "none",
      source: "app",
      manualHallId: "",
      limitedPurchasedQuantity: "",
      catalogPrice: "",
      sheetRemarks: "",
    });
  }
  const generatedBytes = Buffer.from(
    await workbook.xlsx.writeBuffer({
      useSharedStrings: true,
      useStyles: false,
    }),
  );
  const bytes = await canonicalizeZipBytes(generatedBytes);
  return Object.freeze({
    bytes,
    items,
    payloadSha256: sha256(bytes),
    semanticSha256: sha256(
      Buffer.from(
        JSON.stringify({
          generator: "valid-event-workbook-v1",
          rowCount,
          seed,
          paddingCharacters,
          itemIds: items.map(({ id }) => id),
        }),
        "utf8",
      ),
    ),
  });
};

export const buildCorruptWorkbookBytes = (compressedBytes) => {
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 4) {
    throw new Error("Corrupt workbook size is invalid");
  }
  const bytes = Buffer.alloc(compressedBytes);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 131 + 17) & 0xff;
  }
  bytes.set(Buffer.from("NOT-ZIP", "ascii"), 0);
  return bytes;
};

export const buildOpaqueWorkbookBytes = (compressedBytes) => {
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 1) {
    throw new Error("Opaque workbook size is invalid");
  }
  return Buffer.alloc(compressedBytes, 0x5a);
};

export const buildCompressionRatioWorkbookBytes = async ({
  compressionRatio,
}) => {
  if (!Number.isSafeInteger(compressionRatio) || compressionRatio < 2) {
    throw new Error("Compression-ratio fixture input is invalid");
  }
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const uncompressedSize = 1024 * 1024;
  await writer.add(
    "xl/worksheets/sheet1.xml",
    new Uint8ArrayReader(new Uint8Array(uncompressedSize)),
    {
      level: 9,
      lastModDate: new Date("1980-01-01T00:00:00.000Z"),
    },
  );
  const archive = Buffer.from(await writer.close());
  if (uncompressedSize / archive.length <= compressionRatio) {
    throw new Error("Generated ZIP does not exceed the required ratio");
  }
  return archive;
};

export const sha256Bytes = sha256;
