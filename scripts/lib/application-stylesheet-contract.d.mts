export type CssAsset = {
  readonly fileName: string;
  readonly source: string | Uint8Array;
};

export type StaticApplicationStylesheetContract = {
  readonly bytes: Buffer;
  readonly html: string;
  readonly publicPath: string;
  readonly sha256: string;
};

export function hasStaticApplicationStylesheetContract(
  source: string | Uint8Array,
): boolean;
export function assertStaticApplicationStylesheetBytes(
  source: string | Uint8Array,
  label?: string,
): Buffer;
export function extractStylesheetHrefs(html: string): string[];
export function injectStaticApplicationStylesheetLink(options: {
  readonly html: string;
  readonly cssAssets: readonly CssAsset[];
}): { readonly html: string; readonly publicPath: string };
export function readStaticApplicationStylesheetContract(
  outputRoot: string,
  options?: { readonly staticDirectory?: "." | "static" },
): Promise<StaticApplicationStylesheetContract>;
