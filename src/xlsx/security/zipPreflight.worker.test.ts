import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it, vi } from "vitest";
import { XlsxPreflightError, preflightXlsx } from "./zipPreflight";

type FixtureEntry = {
  name: string;
  text: string;
  flags?: number;
};

const encoder = new TextEncoder();

let crcTable: Uint32Array | null = null;
const crc32 = (bytes: Uint8Array): number => {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      crcTable[value] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.byteLength;
  });
  return result;
};

const createStoredZip = (entries: FixtureEntry[]): ArrayBuffer => {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  entries.forEach(({ name, text, flags = 0x0800 }) => {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);

    const local = new Uint8Array(30);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    const localRecord = concat([local, nameBytes, data]);
    localParts.push(localRecord);

    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    centralParts.push(concat([central, nameBytes]));
    localOffset += localRecord.byteLength;
  });

  const localBytes = concat(localParts);
  const centralBytes = concat(centralParts);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralBytes.byteLength, true);
  eocdView.setUint32(16, localBytes.byteLength, true);
  return concat([localBytes, centralBytes, eocd]).buffer as ArrayBuffer;
};

const findEndOfCentralDirectory = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      return offset;
    }
  }
  throw new Error("Test ZIP is missing its end-of-central-directory record.");
};

const mutateFirstLocalCrc = (input: ArrayBuffer): ArrayBuffer => {
  const output = input.slice(0);
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const localOffset = view.getUint32(centralOffset + 42, true);
  view.setUint32(
    localOffset + 14,
    view.getUint32(localOffset + 14, true) ^ 0xffffffff,
    true,
  );
  return output;
};

const mutateDeflatedPayload = (input: ArrayBuffer): ArrayBuffer => {
  const output = input.slice(0);
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  let centralOffset = view.getUint32(eocdOffset + 16, true);

  for (let index = 0; index < entryCount; index += 1) {
    const compressionMethod = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    if (compressionMethod === 8 && compressedSize > 0) {
      const localOffset = view.getUint32(centralOffset + 42, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      bytes[dataOffset + Math.floor(compressedSize / 2)] ^= 0x40;
      return output;
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("Test ZIP contains no deflated entry.");
};

const createDeflatedZip = async (
  entries: FixtureEntry[],
): Promise<ArrayBuffer> => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    level: 6,
    useWebWorkers: false,
    zip64: false,
  });
  for (const { name, text } of entries) {
    await writer.add(name, new TextReader(text), {
      extendedTimestamp: false,
      lastModDate: new Date("2000-01-01T00:00:00.000Z"),
      level: 6,
      useWebWorkers: false,
      zip64: false,
    });
  }
  const bytes = await writer.close(undefined, { zip64: false });
  return bytes.slice().buffer as ArrayBuffer;
};

const validEntries = (): FixtureEntry[] => [
  {
    name: "[Content_Types].xml",
    text: '<?xml version="1.0"?><Types></Types>',
  },
  {
    name: "_rels/.rels",
    text: '<?xml version="1.0"?><Relationships></Relationships>',
  },
  {
    name: "xl/workbook.xml",
    text: '<?xml version="1.0"?><workbook><sheets><sheet name="A"/></sheets></workbook>',
  },
  {
    name: "xl/worksheets/sheet1.xml",
    text: '<?xml version="1.0"?><worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>',
  },
  {
    name: "xl/sharedStrings.xml",
    text: '<?xml version="1.0"?><sst><si><t>A</t></si></sst>',
  },
  {
    name: "xl/styles.xml",
    text: '<?xml version="1.0"?><styleSheet><cellXfs><xf/></cellXfs></styleSheet>',
  },
];

describe("XLSX ZIP preflight worker gate", () => {
  it("validates a bounded workbook and returns a whole-buffer digest", async () => {
    const progress = vi.fn();
    const result = await preflightXlsx(createStoredZip(validEntries()), {
      progress,
    });
    expect(result).toMatchObject({
      entryCount: 6,
      worksheetCount: 1,
      rowCount: 1,
      cellCount: 1,
      sharedStringCount: 1,
      styleCount: 1,
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(progress).toHaveBeenCalledWith({
      phase: "digest",
      completed: 1,
      total: 1,
    });
  });

  it("extracts real deflate entries through the zip.js worker-safe path", async () => {
    const result = await preflightXlsx(await createDeflatedZip(validEntries()));
    expect(result).toMatchObject({
      entryCount: 6,
      worksheetCount: 1,
      rowCount: 1,
      cellCount: 1,
      sharedStringCount: 1,
      styleCount: 1,
    });
  });

  it("rejects local-header metadata that disagrees with the central directory", async () => {
    await expect(
      preflightXlsx(mutateFirstLocalCrc(createStoredZip(validEntries()))),
    ).rejects.toMatchObject({
      code: "INVALID_ZIP",
      category: "format",
    });
  });

  it("fails closed when a deflated payload is corrupted", async () => {
    const corrupted = mutateDeflatedPayload(
      await createDeflatedZip(validEntries()),
    );
    try {
      await preflightXlsx(corrupted);
      throw new Error("Corrupted deflate payload was unexpectedly accepted.");
    } catch (error) {
      expect(error).toBeInstanceOf(XlsxPreflightError);
      expect(["CRC_MISMATCH", "INVALID_ZIP"]).toContain(
        (error as XlsxPreflightError).code,
      );
    }
  });

  it.each([
    {
      label: "path traversal",
      mutate: (entries: FixtureEntry[]) => [
        ...entries,
        { name: "../evil.xml", text: "<evil/>" },
      ],
      code: "PATH_TRAVERSAL",
    },
    {
      label: "case collision",
      mutate: (entries: FixtureEntry[]) => [
        ...entries,
        { name: "XL/WORKBOOK.XML", text: "<workbook/>" },
      ],
      code: "CASE_COLLISION",
    },
    {
      label: "encrypted entry",
      mutate: (entries: FixtureEntry[]) =>
        entries.map((entry, index) =>
          index === 0 ? { ...entry, flags: 0x0801 } : entry,
        ),
      code: "ENCRYPTED_ENTRY",
    },
  ])("rejects $label before XML parsing", async ({ mutate, code }) => {
    await expect(
      preflightXlsx(createStoredZip(mutate(validEntries()))),
    ).rejects.toMatchObject({ code });
  });

  it("rejects external relationships without retaining their target", async () => {
    const entries = validEntries();
    entries[1] = {
      name: "_rels/.rels",
      text: '<Relationships><Relationship TargetMode="External" Target="https://private.example/secret"/></Relationships>',
    };
    await expect(preflightXlsx(createStoredZip(entries))).rejects.toMatchObject(
      {
        code: "EXTERNAL_RELATIONSHIP",
        category: "security",
      },
    );
  });

  it("rejects DTD and entity declarations", async () => {
    const entries = validEntries();
    entries[0] = {
      name: "[Content_Types].xml",
      text: '<!DOCTYPE Types [<!ENTITY xxe SYSTEM "file:///secret">]><Types>&xxe;</Types>',
    };
    await expect(preflightXlsx(createStoredZip(entries))).rejects.toMatchObject(
      { code: "DTD_OR_ENTITY" },
    );
  });

  it("enforces compressed byte and time budgets", async () => {
    const workbook = createStoredZip(validEntries());
    await expect(
      preflightXlsx(workbook, {
        limits: { maxCompressedBytes: workbook.byteLength - 1 },
      }),
    ).rejects.toBeInstanceOf(XlsxPreflightError);

    let tick = 0;
    await expect(
      preflightXlsx(workbook, {
        limits: { maxWallTimeMs: 1, maxCpuTimeMs: 1 },
        now: () => {
          tick += 2;
          return tick;
        },
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
      category: "resource",
    });
  });

  it.each([
    {
      label: "entry count",
      limits: { maxEntryCount: 5 },
    },
    {
      label: "single-entry inflated bytes",
      limits: { maxEntryUncompressedBytes: 32 },
    },
    {
      label: "aggregate inflated bytes",
      limits: { maxTotalInflatedBytes: 64 },
    },
  ])("enforces the $label limit before extraction", async ({ limits }) => {
    await expect(
      preflightXlsx(createStoredZip(validEntries()), { limits }),
    ).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
      category: "resource",
    });
  });

  it("enforces the compression-ratio limit before zip.js extraction", async () => {
    await expect(
      preflightXlsx(await createDeflatedZip(validEntries()), {
        limits: { maxCompressionRatio: 1 },
      }),
    ).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
      category: "resource",
    });
  });

  it("honors AbortSignal before reading the archive", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      preflightXlsx(createStoredZip(validEntries()), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("honors AbortSignal between zip.js entry extractions", async () => {
    const controller = new AbortController();
    let tick = 0;
    await expect(
      preflightXlsx(await createDeflatedZip(validEntries()), {
        limits: { progressIntervalMs: 1 },
        now: () => {
          tick += 1;
          return tick;
        },
        progress: ({ phase }) => {
          if (phase === "inflate") controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "ABORTED",
      category: "aborted",
    });
  });
});
