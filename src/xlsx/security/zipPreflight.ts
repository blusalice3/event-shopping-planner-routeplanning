import {
  ERR_ENCRYPTED,
  ERR_INVALID_SIGNATURE,
  ERR_UNSUPPORTED_COMPRESSION,
  ERR_UNSUPPORTED_ENCRYPTION,
  type Entry,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
} from "@zip.js/zip.js";
import limitsDocument from "../../../config/xlsx-limits.json";
import type { XlsxProgress } from "../domain/types";

export type XlsxLimits = {
  schemaVersion: 1;
  digestAlgorithm: "SHA-256";
  maxCompressedBytes: number;
  maxEntryCount: number;
  maxEntryUncompressedBytes: number;
  maxTotalInflatedBytes: number;
  maxXmlNodes: number;
  maxXmlTextBytes: number;
  maxWorksheetCount: number;
  maxRowCount: number;
  maxCellCount: number;
  maxSharedStringCount: number;
  maxStyleCount: number;
  maxCompressionRatio: number;
  maxWallTimeMs: number;
  maxCpuTimeMs: number;
  progressIntervalMs: number;
};

export type XlsxPreflightErrorCode =
  | "ABORTED"
  | "CASE_COLLISION"
  | "CRC_MISMATCH"
  | "DTD_OR_ENTITY"
  | "ENCRYPTED_ENTRY"
  | "EXTERNAL_RELATIONSHIP"
  | "INFLATER_UNAVAILABLE"
  | "INVALID_LIMITS"
  | "INVALID_XLSX_STRUCTURE"
  | "INVALID_ZIP"
  | "PATH_TRAVERSAL"
  | "RESOURCE_LIMIT"
  | "UNSUPPORTED_COMPRESSION"
  | "ZIP64_UNSUPPORTED";

export class XlsxPreflightError extends Error {
  readonly code: XlsxPreflightErrorCode;
  readonly category:
    | "aborted"
    | "format"
    | "resource"
    | "security"
    | "unsupported";

  constructor(
    code: XlsxPreflightErrorCode,
    category: XlsxPreflightError["category"],
    message: string,
  ) {
    super(message);
    this.name = "XlsxPreflightError";
    this.code = code;
    this.category = category;
  }
}

export type XlsxPreflightResult = Readonly<{
  sha256: string;
  compressedBytes: number;
  entryCount: number;
  totalInflatedBytes: number;
  worksheetCount: number;
  rowCount: number;
  cellCount: number;
  sharedStringCount: number;
  styleCount: number;
  xmlNodeCount: number;
  xmlTextBytes: number;
}>;

type ZipEntry = {
  name: string;
  rawName: Uint8Array;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  compressedDataOffset: number;
};

export type XlsxPreflightOptions = {
  limits?: Partial<XlsxLimits>;
  signal?: AbortSignal;
  progress?: (value: XlsxProgress) => void;
  now?: () => number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const MAX_EOCD_SEARCH = 65_557;
const REQUIRED_XLSX_PATHS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
] as const;

const asSafePositiveInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new XlsxPreflightError(
      "INVALID_LIMITS",
      "format",
      `XLSX limit ${name} must be a positive safe integer.`,
    );
  }
  return Number(value);
};

export const resolveXlsxLimits = (
  overrides: Partial<XlsxLimits> = {},
): XlsxLimits => {
  const value = { ...limitsDocument, ...overrides } as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.digestAlgorithm !== "SHA-256") {
    throw new XlsxPreflightError(
      "INVALID_LIMITS",
      "format",
      "XLSX limit schema or digest algorithm is unsupported.",
    );
  }
  const integerKeys = [
    "maxCompressedBytes",
    "maxEntryCount",
    "maxEntryUncompressedBytes",
    "maxTotalInflatedBytes",
    "maxXmlNodes",
    "maxXmlTextBytes",
    "maxWorksheetCount",
    "maxRowCount",
    "maxCellCount",
    "maxSharedStringCount",
    "maxStyleCount",
    "maxWallTimeMs",
    "maxCpuTimeMs",
    "progressIntervalMs",
  ] as const;
  const normalized = {
    schemaVersion: 1,
    digestAlgorithm: "SHA-256",
  } as XlsxLimits;
  for (const key of integerKeys) {
    normalized[key] = asSafePositiveInteger(value[key], key) as never;
  }
  if (
    typeof value.maxCompressionRatio !== "number" ||
    !Number.isFinite(value.maxCompressionRatio) ||
    value.maxCompressionRatio < 1
  ) {
    throw new XlsxPreflightError(
      "INVALID_LIMITS",
      "format",
      "XLSX compression ratio limit is invalid.",
    );
  }
  normalized.maxCompressionRatio = value.maxCompressionRatio;
  return normalized;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw new XlsxPreflightError(
    "ABORTED",
    "aborted",
    "XLSX preflight was aborted.",
  );
};

const resourceLimit = (message: string): never => {
  throw new XlsxPreflightError("RESOURCE_LIMIT", "resource", message);
};

const ensureRange = (
  offset: number,
  length: number,
  total: number,
  label: string,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > total
  ) {
    throw new XlsxPreflightError(
      "INVALID_ZIP",
      "format",
      `${label} is outside the ZIP buffer.`,
    );
  }
};

const findEndOfCentralDirectory = (
  bytes: Uint8Array,
  view: DataView,
): number => {
  const start = Math.max(0, bytes.byteLength - MAX_EOCD_SEARCH);
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw new XlsxPreflightError(
    "INVALID_ZIP",
    "format",
    "ZIP end-of-central-directory record is missing.",
  );
};

const decodeFileName = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new XlsxPreflightError(
      "INVALID_ZIP",
      "format",
      "ZIP entry name is not valid UTF-8.",
    );
  }
};

const validateZipPath = (name: string): void => {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new XlsxPreflightError(
      "PATH_TRAVERSAL",
      "security",
      "ZIP entry path is unsafe.",
    );
  }
  const path = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path.length === 0 ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new XlsxPreflightError(
      "PATH_TRAVERSAL",
      "security",
      "ZIP entry path contains an unsafe segment.",
    );
  }
};

const containsZip64ExtraField = (extra: Uint8Array): boolean => {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const id = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (offset + 4 + length > extra.byteLength) {
      throw new XlsxPreflightError(
        "INVALID_ZIP",
        "format",
        "ZIP extra field is truncated.",
      );
    }
    if (id === ZIP64_EXTRA_FIELD_ID) return true;
    offset += 4 + length;
  }
  if (offset !== extra.byteLength) {
    throw new XlsxPreflightError(
      "INVALID_ZIP",
      "format",
      "ZIP extra field has trailing bytes.",
    );
  }
  return false;
};

const parseEntries = (
  bytes: Uint8Array,
  limits: XlsxLimits,
): { entries: ZipEntry[]; totalInflatedBytes: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new XlsxPreflightError(
      "ZIP64_UNSUPPORTED",
      "unsupported",
      "Multi-disk or ZIP64 archives are not supported.",
    );
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new XlsxPreflightError(
      "ZIP64_UNSUPPORTED",
      "unsupported",
      "ZIP64 archives are not supported.",
    );
  }
  if (entryCount > limits.maxEntryCount) {
    resourceLimit("ZIP entry count exceeds the XLSX limit.");
  }
  ensureRange(
    centralOffset,
    centralSize,
    bytes.byteLength,
    "ZIP central directory",
  );
  if (centralOffset + centralSize !== eocdOffset) {
    throw new XlsxPreflightError(
      "INVALID_ZIP",
      "format",
      "ZIP central directory boundary is inconsistent.",
    );
  }

  const entries: ZipEntry[] = [];
  const caseFoldedPaths = new Set<string>();
  let offset = centralOffset;
  let totalInflatedBytes = 0;
  let totalCompressedPayloadBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    ensureRange(offset, 46, bytes.byteLength, "ZIP central entry");
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new XlsxPreflightError(
        "INVALID_ZIP",
        "format",
        "ZIP central entry signature is invalid.",
      );
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const variableLength = fileNameLength + extraLength + commentLength;
    ensureRange(
      offset + 46,
      variableLength,
      bytes.byteLength,
      "ZIP central entry fields",
    );
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + fileNameLength);
    const extra = bytes.subarray(
      offset + 46 + fileNameLength,
      offset + 46 + fileNameLength + extraLength,
    );
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      containsZip64ExtraField(extra)
    ) {
      throw new XlsxPreflightError(
        "ZIP64_UNSUPPORTED",
        "unsupported",
        "ZIP64 entry fields are not supported.",
      );
    }
    if ((flags & 0x0001) !== 0) {
      throw new XlsxPreflightError(
        "ENCRYPTED_ENTRY",
        "security",
        "Encrypted XLSX entries are not accepted.",
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new XlsxPreflightError(
        "UNSUPPORTED_COMPRESSION",
        "unsupported",
        "XLSX entry uses an unsupported compression method.",
      );
    }
    const name = decodeFileName(nameBytes);
    validateZipPath(name);
    const folded = name.toLocaleLowerCase("en-US");
    if (caseFoldedPaths.has(folded)) {
      throw new XlsxPreflightError(
        "CASE_COLLISION",
        "security",
        "ZIP contains duplicate or case-colliding paths.",
      );
    }
    caseFoldedPaths.add(folded);
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      resourceLimit("A ZIP entry exceeds the inflated byte limit.");
    }
    if (compressedSize === 0 && uncompressedSize > 0) {
      resourceLimit("A ZIP entry has an unbounded compression ratio.");
    }
    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > limits.maxCompressionRatio
    ) {
      resourceLimit("A ZIP entry exceeds the compression ratio limit.");
    }
    totalInflatedBytes += uncompressedSize;
    totalCompressedPayloadBytes += compressedSize;
    if (
      !Number.isSafeInteger(totalInflatedBytes) ||
      totalInflatedBytes > limits.maxTotalInflatedBytes
    ) {
      resourceLimit("ZIP inflated bytes exceed the XLSX limit.");
    }
    if (
      totalCompressedPayloadBytes > 0 &&
      totalInflatedBytes / totalCompressedPayloadBytes >
        limits.maxCompressionRatio
    ) {
      resourceLimit("ZIP aggregate compression ratio exceeds the limit.");
    }

    ensureRange(localHeaderOffset, 30, centralOffset, "ZIP local file header");
    if (
      view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE
    ) {
      throw new XlsxPreflightError(
        "INVALID_ZIP",
        "format",
        "ZIP local file header signature is invalid.",
      );
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    if (localFlags !== flags || localMethod !== compressionMethod) {
      throw new XlsxPreflightError(
        "INVALID_ZIP",
        "format",
        "ZIP central and local entry metadata differ.",
      );
    }
    ensureRange(
      localHeaderOffset + 30,
      localNameLength + localExtraLength,
      centralOffset,
      "ZIP local entry fields",
    );
    const localName = decodeFileName(
      bytes.subarray(
        localHeaderOffset + 30,
        localHeaderOffset + 30 + localNameLength,
      ),
    );
    if (localName !== name) {
      throw new XlsxPreflightError(
        "INVALID_ZIP",
        "format",
        "ZIP central and local entry names differ.",
      );
    }
    const compressedDataOffset =
      localHeaderOffset + 30 + localNameLength + localExtraLength;
    ensureRange(
      compressedDataOffset,
      compressedSize,
      centralOffset,
      "ZIP entry data",
    );
    entries.push({
      name,
      rawName: nameBytes,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      compressedDataOffset,
    });
    offset += 46 + variableLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new XlsxPreflightError(
      "INVALID_ZIP",
      "format",
      "ZIP central directory entry count is inconsistent.",
    );
  }
  return { entries, totalInflatedBytes };
};

const zipBytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const invalidZipMetadata = (): never => {
  throw new XlsxPreflightError(
    "INVALID_ZIP",
    "format",
    "ZIP metadata differs between independent parsers.",
  );
};

const crossCheckZipEntry = (parsed: ZipEntry, engineEntry: Entry): void => {
  if (
    engineEntry.filename !== parsed.name ||
    !zipBytesEqual(engineEntry.rawFilename, parsed.rawName) ||
    engineEntry.offset !== parsed.localHeaderOffset ||
    !engineEntry.bitFlag ||
    engineEntry.bitFlag.dataDescriptor !== Boolean(parsed.flags & 0x0008) ||
    engineEntry.bitFlag.languageEncodingFlag !==
      Boolean(parsed.flags & 0x0800) ||
    engineEntry.bitFlag.level !== (parsed.flags & 0x0006) >> 1 ||
    engineEntry.filenameUTF8 !== Boolean(parsed.flags & 0x0800) ||
    engineEntry.compressionMethod !== parsed.compressionMethod ||
    engineEntry.signature !== parsed.crc32 ||
    engineEntry.compressedSize !== parsed.compressedSize ||
    engineEntry.uncompressedSize !== parsed.uncompressedSize ||
    engineEntry.diskNumberStart !== 0 ||
    engineEntry.encrypted ||
    engineEntry.zip64 ||
    engineEntry.directory !== parsed.name.endsWith("/")
  ) {
    invalidZipMetadata();
  }
};

const throwZipEngineError = (error: unknown, signal?: AbortSignal): never => {
  if (error instanceof XlsxPreflightError) throw error;
  if (
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    throwIfAborted(signal);
    throw new XlsxPreflightError(
      "ABORTED",
      "aborted",
      "XLSX preflight was aborted.",
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (message === ERR_INVALID_SIGNATURE) {
    throw new XlsxPreflightError(
      "CRC_MISMATCH",
      "security",
      "ZIP entry CRC does not match.",
    );
  }
  if (message === ERR_ENCRYPTED || message === ERR_UNSUPPORTED_ENCRYPTION) {
    throw new XlsxPreflightError(
      "ENCRYPTED_ENTRY",
      "security",
      "Encrypted XLSX entries are not accepted.",
    );
  }
  if (message === ERR_UNSUPPORTED_COMPRESSION) {
    throw new XlsxPreflightError(
      "UNSUPPORTED_COMPRESSION",
      "unsupported",
      "XLSX entry uses an unsupported compression method.",
    );
  }
  throw new XlsxPreflightError(
    "INVALID_ZIP",
    "format",
    "ZIP validation failed in the archive engine.",
  );
};

type CrossCheckedZip = Readonly<{
  reader: ZipReader<Uint8Array>;
  entries: Entry[];
}>;

const openCrossCheckedZip = async (
  bytes: Uint8Array,
  parsedEntries: ZipEntry[],
  signal: AbortSignal | undefined,
  startedAt: number,
  now: () => number,
  limits: XlsxLimits,
): Promise<CrossCheckedZip> => {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    checkAmbiguity: true,
    filenameEncoding: "utf-8",
    maxAppendedDataSize: 0,
    strictness: "strict",
    useWebWorkers: false,
  });
  try {
    const entries: Entry[] = [];
    for await (const entry of reader.getEntriesGenerator({
      checkAmbiguity: true,
      filenameEncoding: "utf-8",
      maxAppendedDataSize: 0,
      strictness: "strict",
    })) {
      throwIfAborted(signal);
      checkElapsed(startedAt, now, limits);
      if (entries.length >= parsedEntries.length) invalidZipMetadata();
      crossCheckZipEntry(parsedEntries[entries.length], entry);
      entries.push(entry);
    }
    if (entries.length !== parsedEntries.length) invalidZipMetadata();
    return { reader, entries };
  } catch (error) {
    try {
      await reader.close();
    } catch {
      // Preserve the original fail-closed validation error.
    }
    return throwZipEngineError(error, signal);
  }
};

const extractZipEntry = async (
  entry: Entry,
  expected: ZipEntry,
  signal: AbortSignal | undefined,
  startedAt: number,
  now: () => number,
  limits: XlsxLimits,
): Promise<Uint8Array> => {
  if (entry.directory) return new Uint8Array();
  try {
    return await entry.getData(new Uint8ArrayWriter(), {
      checkAmbiguity: true,
      checkOverlappingEntry: true,
      checkSignature: true,
      onend: (computedSize) => {
        throwIfAborted(signal);
        checkElapsed(startedAt, now, limits);
        if (computedSize !== expected.uncompressedSize) invalidZipMetadata();
      },
      onprogress: (progress, total) => {
        throwIfAborted(signal);
        checkElapsed(startedAt, now, limits);
        if (
          !Number.isSafeInteger(progress) ||
          !Number.isSafeInteger(total) ||
          progress < 0 ||
          total !== expected.compressedSize ||
          progress > total
        ) {
          invalidZipMetadata();
        }
      },
      onstart: (total) => {
        throwIfAborted(signal);
        checkElapsed(startedAt, now, limits);
        if (total !== expected.compressedSize) invalidZipMetadata();
      },
      signal,
      strictness: "strict",
      useWebWorkers: false,
    });
  } catch (error) {
    return throwZipEngineError(error, signal);
  }
};

let crcTable: Uint32Array | null = null;

const getCrcTable = (): Uint32Array => {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crcTable[value] = crc >>> 0;
  }
  return crcTable;
};

const crc32 = (bytes: Uint8Array): number => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const countMatches = (text: string, pattern: RegExp): number => {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text)) count += 1;
  return count;
};

const checkElapsed = (
  startedAt: number,
  now: () => number,
  limits: XlsxLimits,
): void => {
  const elapsed = now() - startedAt;
  if (elapsed > limits.maxWallTimeMs || elapsed > limits.maxCpuTimeMs) {
    resourceLimit("XLSX preflight exceeded its time budget.");
  }
};

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");

export const preflightXlsx = async (
  input: ArrayBuffer,
  options: XlsxPreflightOptions = {},
): Promise<XlsxPreflightResult> => {
  const limits = resolveXlsxLimits(options.limits);
  const signal = options.signal;
  const now =
    options.now ??
    (() =>
      typeof performance === "undefined" ? Date.now() : performance.now());
  const startedAt = now();
  throwIfAborted(signal);
  if (input.byteLength === 0 || input.byteLength > limits.maxCompressedBytes) {
    resourceLimit("Compressed XLSX bytes exceed the configured limit.");
  }
  const bytes = new Uint8Array(input);
  const { entries, totalInflatedBytes } = parseEntries(bytes, limits);
  const entryPaths = new Set(entries.map(({ name }) => name));
  if (REQUIRED_XLSX_PATHS.some((path) => !entryPaths.has(path))) {
    throw new XlsxPreflightError(
      "INVALID_XLSX_STRUCTURE",
      "format",
      "Required XLSX package entries are missing.",
    );
  }
  const worksheetCount = entries.filter(({ name }) =>
    /^xl\/worksheets\/[^/]+\.xml$/i.test(name),
  ).length;
  if (worksheetCount > limits.maxWorksheetCount) {
    resourceLimit("Worksheet count exceeds the XLSX limit.");
  }

  let xmlNodeCount = 0;
  let xmlTextBytes = 0;
  let rowCount = 0;
  let cellCount = 0;
  let sharedStringCount = 0;
  let styleCount = 0;
  let lastProgressAt = -Infinity;
  const report = (progress: XlsxProgress, force = false): void => {
    const timestamp = now();
    if (force || timestamp - lastProgressAt >= limits.progressIntervalMs) {
      lastProgressAt = timestamp;
      options.progress?.(progress);
    }
  };
  report(
    {
      phase: "preflight",
      completed: 0,
      total: entries.length,
    },
    true,
  );

  const archive = await openCrossCheckedZip(
    bytes,
    entries,
    signal,
    startedAt,
    now,
    limits,
  );
  try {
    for (let index = 0; index < entries.length; index += 1) {
      throwIfAborted(signal);
      checkElapsed(startedAt, now, limits);
      const entry = entries[index];
      if (entry.name.endsWith("/")) continue;
      const inflated = await extractZipEntry(
        archive.entries[index],
        entry,
        signal,
        startedAt,
        now,
        limits,
      );
      if (inflated.byteLength !== entry.uncompressedSize) {
        throw new XlsxPreflightError(
          "INVALID_ZIP",
          "format",
          "ZIP entry size does not match metadata.",
        );
      }
      if (crc32(inflated) !== entry.crc32) {
        throw new XlsxPreflightError(
          "CRC_MISMATCH",
          "security",
          "ZIP entry CRC does not match.",
        );
      }

      if (/\.xml$|\.rels$/i.test(entry.name)) {
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
        } catch {
          throw new XlsxPreflightError(
            "INVALID_XLSX_STRUCTURE",
            "format",
            "XLSX XML is not valid UTF-8.",
          );
        }
        if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
          throw new XlsxPreflightError(
            "DTD_OR_ENTITY",
            "security",
            "DTD and entity declarations are forbidden in XLSX XML.",
          );
        }
        if (
          /\.rels$/i.test(entry.name) &&
          /\bTargetMode\s*=\s*["']External["']/i.test(text)
        ) {
          throw new XlsxPreflightError(
            "EXTERNAL_RELATIONSHIP",
            "security",
            "External XLSX relationships are forbidden.",
          );
        }
        xmlTextBytes += inflated.byteLength;
        xmlNodeCount += countMatches(text, /<(?!!|\?|\/)[A-Za-z_][^>]*>/g);
        if (/^xl\/worksheets\//i.test(entry.name)) {
          rowCount += countMatches(text, /<row(?=[\s/>])/gi);
          cellCount += countMatches(text, /<c(?=[\s/>])/gi);
        } else if (/^xl\/sharedStrings\.xml$/i.test(entry.name)) {
          sharedStringCount += countMatches(text, /<si(?=[\s/>])/gi);
        } else if (/^xl\/styles\.xml$/i.test(entry.name)) {
          styleCount += countMatches(text, /<xf(?=[\s/>])/gi);
        }
        if (xmlTextBytes > limits.maxXmlTextBytes) {
          resourceLimit("XLSX XML text bytes exceed the limit.");
        }
        if (xmlNodeCount > limits.maxXmlNodes) {
          resourceLimit("XLSX XML node count exceeds the limit.");
        }
        if (rowCount > limits.maxRowCount) {
          resourceLimit("XLSX row count exceeds the limit.");
        }
        if (cellCount > limits.maxCellCount) {
          resourceLimit("XLSX cell count exceeds the limit.");
        }
        if (sharedStringCount > limits.maxSharedStringCount) {
          resourceLimit("XLSX shared-string count exceeds the limit.");
        }
        if (styleCount > limits.maxStyleCount) {
          resourceLimit("XLSX style count exceeds the limit.");
        }
      }
      report({
        phase: "inflate",
        completed: index + 1,
        total: entries.length,
      });
    }
  } finally {
    await archive.reader.close();
  }

  throwIfAborted(signal);
  checkElapsed(startedAt, now, limits);
  report({ phase: "digest", completed: 0, total: 1 }, true);
  if (!globalThis.crypto?.subtle) {
    throw new XlsxPreflightError(
      "INFLATER_UNAVAILABLE",
      "unsupported",
      "Web Crypto SHA-256 is unavailable.",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  report({ phase: "digest", completed: 1, total: 1 }, true);
  checkElapsed(startedAt, now, limits);

  return {
    sha256: toHex(new Uint8Array(digest)),
    compressedBytes: input.byteLength,
    entryCount: entries.length,
    totalInflatedBytes,
    worksheetCount,
    rowCount,
    cellCount,
    sharedStringCount,
    styleCount,
    xmlNodeCount,
    xmlTextBytes,
  };
};
