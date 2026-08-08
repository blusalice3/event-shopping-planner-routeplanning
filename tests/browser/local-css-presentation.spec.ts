import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type ThemeMode = "dark" | "light" | "system";
type ColorScheme = "dark" | "light";

type ThemeFrame = {
  readonly bodyBackgroundColor: string | null;
  readonly bodyColor: string | null;
  readonly darkClass: boolean;
  readonly dataTheme: string | null;
};

type VisualSignature = {
  readonly backgroundToken: string;
  readonly bodyBackgroundColor: string;
  readonly bodyColor: string;
  readonly darkClass: boolean;
  readonly dataTheme: string | null;
  readonly rootSurfaceBackgroundColor: string;
  readonly textToken: string;
};

const waitForApplication = async (page: Page): Promise<void> => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  await expect(page.locator("#loading-screen")).toHaveClass(/hidden/);
  await expect(page.locator("#loading-screen")).toBeHidden();
  await expect(page.locator("#root")).not.toBeEmpty();
};

const setStoredThemeBeforeNavigation = async (
  page: Page,
  theme: ThemeMode,
): Promise<void> => {
  await page.addInitScript((storedTheme) => {
    localStorage.setItem("themeMode", storedTheme);
  }, theme);
};

const openThemedApplication = async (
  context: BrowserContext,
  theme: ThemeMode,
  colorScheme: ColorScheme,
): Promise<Page> => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme });
  await setStoredThemeBeforeNavigation(page, theme);
  await waitForApplication(page);
  return page;
};

const collectVisualSignature = async (page: Page): Promise<VisualSignature> =>
  page.evaluate(() => {
    const html = document.documentElement;
    const bodyStyle = getComputedStyle(document.body);
    const rootSurface = document.querySelector<HTMLElement>("#root > *");
    if (!rootSurface) throw new Error("Application root surface is missing.");
    const rootSurfaceStyle = getComputedStyle(rootSurface);
    return {
      backgroundToken: getComputedStyle(html)
        .getPropertyValue("--bg-primary")
        .trim(),
      bodyBackgroundColor: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      darkClass: html.classList.contains("dark"),
      dataTheme: html.getAttribute("data-theme"),
      rootSurfaceBackgroundColor: rootSurfaceStyle.backgroundColor,
      textToken: getComputedStyle(html)
        .getPropertyValue("--text-primary")
        .trim(),
    };
  });

test("prepaints every stored theme before the first rendered frame", async ({
  context,
}) => {
  const cases = [
    {
      colorScheme: "light",
      expected: { darkClass: true, theme: "dark" },
      storedTheme: "dark",
    },
    {
      colorScheme: "dark",
      expected: { darkClass: false, theme: "light" },
      storedTheme: "light",
    },
    {
      colorScheme: "dark",
      expected: { darkClass: true, theme: "system" },
      storedTheme: "system",
    },
    {
      colorScheme: "light",
      expected: { darkClass: false, theme: "system" },
      storedTheme: "system",
    },
  ] as const;

  for (const testCase of cases) {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: testCase.colorScheme });
    await page.addInitScript((storedTheme) => {
      localStorage.setItem("themeMode", storedTheme);
      const runtime = globalThis as typeof globalThis & {
        __localCssFirstPaintFrames?: ThemeFrame[];
      };
      const frames: ThemeFrame[] = [];
      runtime.__localCssFirstPaintFrames = frames;
      const capture = (): void => {
        const html = document.documentElement;
        const body = document.body;
        const bodyStyle = body ? getComputedStyle(body) : null;
        frames.push({
          bodyBackgroundColor: bodyStyle?.backgroundColor ?? null,
          bodyColor: bodyStyle?.color ?? null,
          darkClass: html.classList.contains("dark"),
          dataTheme: html.getAttribute("data-theme"),
        });
      };
      requestAnimationFrame(() => {
        capture();
        requestAnimationFrame(capture);
      });
    }, testCase.storedTheme);

    await waitForApplication(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __localCssFirstPaintFrames?: ThemeFrame[];
              }
            ).__localCssFirstPaintFrames?.length ?? 0,
        ),
      )
      .toBe(2);
    const frames = await page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __localCssFirstPaintFrames?: ThemeFrame[];
          }
        ).__localCssFirstPaintFrames ?? [],
    );

    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.dataTheme).toBe(testCase.expected.theme);
      expect(frame.darkClass).toBe(testCase.expected.darkClass);
      expect(frame.bodyBackgroundColor).not.toBeNull();
      expect(frame.bodyColor).not.toBeNull();
    }
    expect(frames[1]).toEqual(frames[0]);
    await page.close();
  }
});

test("keeps explicit light and dark computed visual signatures distinct", async ({
  context,
}) => {
  const lightPage = await openThemedApplication(context, "light", "dark");
  const light = await collectVisualSignature(lightPage);
  await lightPage.close();

  const darkPage = await openThemedApplication(context, "dark", "light");
  const dark = await collectVisualSignature(darkPage);
  await darkPage.close();

  expect(light).toEqual({
    backgroundToken: "#f8fafc",
    bodyBackgroundColor: "rgb(248, 250, 252)",
    bodyColor: "rgb(30, 41, 59)",
    darkClass: false,
    dataTheme: "light",
    rootSurfaceBackgroundColor: "rgb(248, 250, 252)",
    textToken: "#1e293b",
  });
  expect(dark).toEqual({
    backgroundToken: "#0f172a",
    bodyBackgroundColor: "rgb(15, 23, 42)",
    bodyColor: "rgb(241, 245, 249)",
    darkClass: true,
    dataTheme: "dark",
    rootSurfaceBackgroundColor: "rgb(15, 23, 42)",
    textToken: "#f1f5f9",
  });
  expect(dark).not.toEqual(light);
});

test("renders without horizontal overflow at smartphone and desktop breakpoints", async ({
  context,
}) => {
  const cases = [
    { expectedProbePosition: "fixed", height: 844, width: 390 },
    { expectedProbePosition: "absolute", height: 900, width: 1440 },
  ] as const;
  const measurements: Array<{ rootWidth: number; viewportWidth: number }> = [];

  for (const testCase of cases) {
    const page = await context.newPage();
    await page.setViewportSize({
      height: testCase.height,
      width: testCase.width,
    });
    await setStoredThemeBeforeNavigation(page, "light");
    await waitForApplication(page);
    const measurement = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>("#root");
      const rootSurface = root?.firstElementChild as HTMLElement | null;
      if (!root || !rootSurface)
        throw new Error("Application root is missing.");
      const probe = document.createElement("div");
      probe.className = "fixed sm:absolute";
      document.body.append(probe);
      const probePosition = getComputedStyle(probe).position;
      probe.remove();
      const rootRect = root.getBoundingClientRect();
      const surfaceRect = rootSurface.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      return {
        horizontalOverflow:
          Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          ) - viewportWidth,
        probePosition,
        rootDisplay: getComputedStyle(root).display,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
        rootWidth: rootRect.width,
        surfaceHeight: surfaceRect.height,
        surfaceVisibility: getComputedStyle(rootSurface).visibility,
        viewportWidth,
      };
    });

    expect(measurement.probePosition).toBe(testCase.expectedProbePosition);
    expect(measurement.rootDisplay).not.toBe("none");
    expect(measurement.surfaceVisibility).toBe("visible");
    expect(measurement.surfaceHeight).toBeGreaterThan(0);
    expect(measurement.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(measurement.rootLeft).toBeGreaterThanOrEqual(-1);
    expect(measurement.rootRight).toBeLessThanOrEqual(
      measurement.viewportWidth + 1,
    );
    expect(measurement.rootWidth).toBeGreaterThanOrEqual(
      measurement.viewportWidth - 1,
    );
    measurements.push({
      rootWidth: measurement.rootWidth,
      viewportWidth: measurement.viewportWidth,
    });
    await page.close();
  }

  expect(measurements[0]?.viewportWidth).toBeLessThan(
    measurements[1]?.viewportWidth ?? 0,
  );
  expect(measurements[0]?.rootWidth).toBeLessThan(
    measurements[1]?.rootWidth ?? 0,
  );
});

test("renders under print media and produces a valid in-memory PDF", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", media: "print" });
  await setStoredThemeBeforeNavigation(page, "light");
  await waitForApplication(page);
  const printState = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("#root");
    if (!root) throw new Error("Application root is missing.");
    const rect = root.getBoundingClientRect();
    return {
      display: getComputedStyle(root).display,
      height: rect.height,
      printMedia: matchMedia("print").matches,
      visibility: getComputedStyle(root).visibility,
      width: rect.width,
    };
  });
  expect(printState).toMatchObject({
    display: "block",
    printMedia: true,
    visibility: "visible",
  });
  expect(printState.height).toBeGreaterThan(0);
  expect(printState.width).toBeGreaterThan(0);

  const pdf = await page.pdf({
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true,
  });
  expect(pdf.byteLength).toBeGreaterThan(1_000);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(pdf.subarray(-1_024).toString("latin1")).toContain("%%EOF");
});

test("validates the runtime manifest and Chromium installability contract", async ({
  context,
  page,
}) => {
  await setStoredThemeBeforeNavigation(page, "system");
  await waitForApplication(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (
    !(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
  ) {
    await page.reload();
    await expect(page.locator("#loading-screen")).toBeHidden();
    await expect(page.locator("#root")).not.toBeEmpty();
  }

  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    return (await response.json()) as {
      background_color: string;
      display: string;
      icons: Array<{ sizes: string; src: string; type: string }>;
      lang: string;
      name: string;
      orientation: string;
      short_name: string;
      start_url: string;
      theme_color: string;
    };
  });
  expect(manifest).toMatchObject({
    background_color: "#f8fafc",
    display: "standalone",
    lang: "ja",
    name: "即売会 購入巡回表",
    orientation: "portrait",
    short_name: "巡回表",
    start_url: "/",
    theme_color: "#2563eb",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", type: "image/png" }),
    ]),
  );

  const client = await context.newCDPSession(page);
  try {
    await client.send("Page.enable");
    const [installability, appManifest] = await Promise.all([
      client.send("Page.getInstallabilityErrors"),
      client.send("Page.getAppManifest"),
    ]);
    expect(installability.installabilityErrors).toEqual([]);
    expect(appManifest.errors).toEqual([]);
    expect(appManifest.url).toMatch(/\/manifest\.webmanifest$/);
  } finally {
    await client.detach();
  }
});
