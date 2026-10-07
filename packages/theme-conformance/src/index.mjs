#!/usr/bin/env node
/** Neutral, packed-install runtime gate for ENG-038. */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "baselines.json");
const require = createRequire(import.meta.url);
const pnpm = (cwd, args) =>
  execFile("corepack", ["pnpm@12.8.1", ...args], {
    cwd,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
    maxBuffer: 10_000_000,
  });
const blocks = [
  "hero",
  "incidentBar",
  "pillarGrid",
  "featureGrid",
  "splitList",
  "chipList",
  "testimonials",
  "faq",
  "callout",
  "relatedServices",
  "cta",
  "richText",
  "contact",
  "media",
  "imageText",
  "gallery",
  "logoStrip",
  "video",
];
const id = (value) =>
  `77777777-7777-4777-8777-${String(value).padStart(12, "0")}`;
const appearance = {
  background: "default",
  width: "content",
  spacing: "default",
  motionIntent: "signature",
  logoTone: "default",
};
const block = (value, type, data) => ({
  id: id(value),
  type,
  hidden: false,
  appearance: { ...appearance },
  ...data,
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Normalize only the transient browser state used for visual capture. Behavior
 * checks run before this so keyboard focus remains part of conformance.
 */
export async function stabilizeCaptureState(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const rootScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    document.documentElement.style.scrollBehavior = rootScrollBehavior;
  });
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 1, viewport.height - 1);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
async function assertVisualBaselines(actual, { file, record, identity }) {
  if (!file) throw new Error(`No visual baseline is configured for ${identity.name}@${identity.themeVersion}. Pass baselineFile, or use recordBaselines with a caller-owned baselineFile.`);
  if (record) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ identity, screenshots: actual }, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(await readFile(file, "utf8"));
  const screenshots = expected.screenshots || expected;
  if (expected.identity && JSON.stringify(expected.identity) !== JSON.stringify(identity)) throw new Error(`Visual baseline identity does not match ${identity.name}@${identity.themeVersion}.`);
  if (JSON.stringify(actual) !== JSON.stringify(screenshots)) {
    throw new Error(
      `Visual baseline changed. Review artifacts/theme-starter-conformance and run UPDATE_THEME_CONFORMANCE_BASELINES=1 pnpm conformance:starter to accept an intentional change.`,
    );
  }
}

function fixture() {
  const media = [
    {
      id: id(201),
      filename: "sample-image.svg",
      alt: "Neutral sample image",
      decorative: false,
      width: 800,
      height: 500,
      mimeType: "image/svg+xml",
    },
    {
      id: id(202),
      filename: "sample-logo.svg",
      alt: "Neutral sample logo",
      decorative: false,
      width: 240,
      height: 120,
      mimeType: "image/svg+xml",
    },
    {
      id: id(203),
      filename: "sample-video.webm",
      alt: "Neutral sample video",
      decorative: false,
      mimeType: "video/webm",
    },
    {
      id: id(204),
      filename: "sample-poster.svg",
      alt: "Neutral sample poster",
      decorative: false,
      width: 800,
      height: 500,
      mimeType: "image/svg+xml",
    },
    {
      id: id(205),
      filename: "sample-captions.vtt",
      alt: "Neutral captions",
      decorative: true,
      mimeType: "text/vtt",
    },
  ];
  const page = {
    id: id(1),
    sectionId: id(100),
    title: "Neutral matrix",
    summary: "Neutral conformance fixture.",
    slug: "matrix",
    template: "standard",
    status: "published",
    publishedAt: "2026-10-01T00:00:00.000Z",
    blocks: [
      block(1, "hero", {
        heading: "Neutral matrix",
        body: "UnbrokenNeutralContent".repeat(40),
      }),
      block(2, "incidentBar", { message: "Neutral incident message." }),
      block(3, "pillarGrid", {
        heading: "Pillars",
        items: [{ title: "Pillar", body: "Short copy.", href: "/" }],
      }),
      block(4, "featureGrid", {
        heading: "Features",
        items: [{ title: "Feature", body: "Short copy." }],
      }),
      block(5, "splitList", {
        heading: "Steps",
        items: [{ title: "Step", body: "Short copy." }],
      }),
      block(6, "chipList", { heading: "Chips", chips: ["Neutral"] }),
      block(7, "testimonials", {
        items: [
          {
            quote: "Neutral testimonial.",
            attribution: "Neutral author",
            permissionConfirmed: true,
          },
        ],
      }),
      block(8, "faq", {
        heading: "Questions",
        items: [{ question: "Question?", answer: "Neutral answer." }],
      }),
      block(9, "callout", { heading: "Callout", body: "Neutral callout." }),
      block(10, "relatedServices", {
        heading: "Related",
        pageIds: [],
        links: [{ label: "Home", href: "/" }],
      }),
      block(11, "cta", {
        heading: "Call to action",
        body: "Neutral action.",
        cta: { label: "Home", href: "/" },
      }),
      block(12, "richText", { body: "Neutral rich text." }),
      block(13, "contact", {
        heading: "Contact",
        body: "Neutral contact.",
        inquiryForm: true,
        inquiryTopicLabel: "Topic",
        inquiryTopics: [{ value: "general", label: "General inquiry" }],
        inquiryConsentLabel: "I consent to this neutral inquiry.",
        contactDetails: {
          channels: [
            {
              kind: "email",
              label: "Email",
              value: "contact@example.test",
              href: "mailto:contact@example.test",
            },
          ],
        },
      }),
      block(14, "media", { mediaId: id(201) }),
      block(15, "imageText", {
        heading: "Image and text",
        body: "Neutral image text.",
        mediaId: id(201),
      }),
      block(16, "gallery", { mediaIds: [id(201)] }),
      { ...block(17, "logoStrip", { mediaIds: [id(202)] }), appearance: { ...appearance, background: "inverse", logoTone: "inverse" } },
      block(19, "logoStrip", { mediaIds: [id(202)] }),
      block(18, "video", {
        mediaId: id(203),
        posterMediaId: id(204),
        captionsMediaId: id(205),
        transcript: "Neutral transcript.",
      }),
    ],
  };
  const templates = [
    "landing",
    "listing",
    "pillar",
    "service",
    "article",
    "job",
  ];
  const pages = [
    page,
    ...templates.map((template, index) => ({
      id: id(20 + index),
      sectionId: id(100),
      ...(template === "service" ? { parentId: id(22) } : {}),
      title: `Neutral ${template}`,
      summary: "Neutral template fixture.",
      slug: `neutral-${template}`,
      template,
      status: "published",
      publishedAt: "2026-10-01T00:00:00.000Z",
      blocks: [
        template === "landing"
          ? block(50 + index, "hero", {
              heading: "Neutral landing",
              body: "Short copy.",
            })
          : block(
              50 + index,
              template === "pillar" ||
                template === "article" ||
                template === "job"
                ? "richText"
                : "hero",
              template === "pillar" ||
                template === "article" ||
                template === "job"
                ? { body: "Short copy." }
                : { heading: `Neutral ${template}`, body: "Short copy." },
            ),
      ],
    })),
  ];
  const backgrounds = [
    "default",
    "subtle",
    "brand",
    "accent",
    "highlight",
    "inverse",
  ];
  const motionIntents = ["none", "subtle", "ambient", "signature"];
  page.blocks.forEach((item, index) => {
    item.appearance = {
      ...item.appearance,
      background: backgrounds[index % backgrounds.length],
      logoTone: index % 2 ? "inverse" : "default",
      motionIntent: motionIntents[index % motionIntents.length],
    };
  });
  return {
    settings: {
      contractVersion: "1.7.0",
      siteName: "Neutral starter",
      homepageId: id(20),
      defaultLocale: "en",
      sections: [
        {
          id: id(100),
          name: "General",
          slug: "general",
          allowedTemplates: [
            "landing",
            "standard",
            "listing",
            "pillar",
            "service",
            "article",
            "job",
          ],
          pageIds: pages.map((item) => item.id),
        },
      ],
      themeSettings: {},
    },
    pages,
    media,
    redirects: [],
    changeSets: [
      { id: id(900), name: "Neutral fixture", state: "approved", revision: 1 },
    ],
  };
}

async function consumer(temp) {
  const tarballs = join(temp, "tarballs");
  await mkdir(tarballs);
  for (const path of [
    "packages/contract",
    "packages/engine",
    "packages/theme-starter",
  ]) {
    await pnpm(join(root, path), ["build"]);
    await pnpm(join(root, path), ["pack", "--pack-destination", tarballs]);
  }
  const zodStore = (await readdir(join(root, "node_modules/.pnpm"))).find(
    (name) => name.startsWith("zod@"),
  );
  if (!zodStore)
    throw new Error("Public workspace has no packed zod dependency.");
  const zod = join(root, "node_modules/.pnpm", zodStore, "node_modules/zod");
  await pnpm(zod, ["pack", "--pack-destination", tarballs]);
  const files = await readdir(tarballs);
  const tar = (prefix) =>
    `file:${join(
      tarballs,
      files.find((file) => file.startsWith(prefix) && file.endsWith(".tgz")),
    )}`;
  const directory = join(temp, "consumer");
  await mkdir(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "neutral-conformance-consumer",
      private: true,
      dependencies: {
        "@site-engine/contract": tar("site-engine-contract"),
        "@site-engine/engine": tar("site-engine-engine"),
        "@site-engine/theme-starter": tar("site-engine-theme-starter"),
      },
    }),
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    `overrides:\n  '@site-engine/contract': '${tar("site-engine-contract")}'\n  '@site-engine/engine': '${tar("site-engine-engine")}'\n  '@site-engine/theme-starter': '${tar("site-engine-theme-starter")}'\n  zod: '${tar("zod-")}'\n`,
  );
  await pnpm(directory, [
    "install",
    "--offline",
    "--ignore-scripts",
    "--store-dir",
    join(temp, "store"),
  ]);
  return directory;
}

async function installedVersions(installed) {
  const packageVersion = async (name) =>
    JSON.parse(
      await readFile(
        join(installed, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version;
  return {
    contractVersion: await packageVersion("@site-engine/contract"),
    engineVersion: await packageVersion("@site-engine/engine"),
    themeVersion: await packageVersion("@site-engine/theme-starter"),
  };
}

async function requireActionableRequiredFieldRejection() {
  const { parseSiteSnapshot } = await import("@site-engine/contract");
  const invalid = fixture();
  invalid.pages[0].blocks[0].heading = "";
  try {
    parseSiteSnapshot(invalid);
  } catch (error) {
    if (
      error?.issues?.some(
        (issue) => issue.path.join(".") === "pages.0.blocks.0.heading",
      ) ||
      String(error?.message).includes("pages[0].blocks[0].heading")
    )
      return;
    throw new Error(
      `Required field rejection did not identify the missing hero heading: ${error.message}`,
    );
  }
  throw new Error("Contract accepted an empty required hero heading.");
}

const glyphSelector = (tone) =>
  `:is([data-logo-tone="${tone}"][data-block-type="logoStrip"], [data-logo-tone="${tone}"][data-block="logoStrip"], [data-logo-tone="${tone}"] [data-block-type="logoStrip"], [data-logo-tone="${tone}"] [data-block="logoStrip"]) img`;

async function renderedGlyphVisibility(page) {
  const glyphs = await page.evaluate(async () => {
    const selector = (tone) =>
      `:is([data-logo-tone="${tone}"][data-block-type="logoStrip"], [data-logo-tone="${tone}"][data-block="logoStrip"], [data-logo-tone="${tone}"] [data-block-type="logoStrip"], [data-logo-tone="${tone}"] [data-block="logoStrip"]) img`;
    const result = [];
    for (const tone of ["default", "inverse"]) {
      const image = document.querySelector(selector(tone));
      if (!(image instanceof HTMLImageElement)) return [];
      try {
        await image.decode();
      } catch {
        return [];
      }
      const rectangle = image.getBoundingClientRect();
      if (!rectangle.width || !rectangle.height || !image.getClientRects().length)
        return [];
      result.push({ tone });
    }
    return result;
  });
  if (glyphs.length !== 2) return false;

  const pixels = async (visible, reference) =>
    page.evaluate(async ({ visible, reference }) => {
      const decode = (bytes) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = `data:image/png;base64,${bytes}`;
        });
      const [painted, background] = await Promise.all([
        decode(visible),
        decode(reference),
      ]);
      if (painted.width !== background.width || painted.height !== background.height)
        return false;
      const canvas = document.createElement("canvas");
      canvas.width = painted.width;
      canvas.height = painted.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return false;
      context.drawImage(painted, 0, 0);
      const paintedPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(background, 0, 0);
      const backgroundPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visiblePixels = 0;
      let contrastPixels = 0;
      for (let index = 0; index < paintedPixels.length; index += 4) {
        const difference = Math.max(
          Math.abs(paintedPixels[index] - backgroundPixels[index]),
          Math.abs(paintedPixels[index + 1] - backgroundPixels[index + 1]),
          Math.abs(paintedPixels[index + 2] - backgroundPixels[index + 2]),
        );
        if (difference > 24) {
          visiblePixels += 1;
          if (difference > 80) contrastPixels += 1;
        }
      }
      const coverage = visiblePixels / (canvas.width * canvas.height);
      return coverage > 0.01 && coverage < 0.7 && contrastPixels > 24;
    },
    { visible: visible.toString("base64"), reference: reference.toString("base64") },
  );

  for (const { tone } of glyphs) {
    const selector = glyphSelector(tone);
    const clip = await page.evaluate(async ({ selector }) => {
      const image = document.querySelector(selector);
      if (!(image instanceof HTMLImageElement)) return null;
      image.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rectangle = image.getBoundingClientRect();
      return {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
      };
    }, { selector });
    if (!clip || !clip.width || !clip.height) return false;
    // Capture the rendered page before changing the image. This includes every
    // ancestor's compositing, filters, opacity, and surface paint.
    const visible = await page.screenshot({ clip, animations: "disabled" });
    const previous = await page.evaluate((selector) => {
      const image = document.querySelector(selector);
      if (!(image instanceof HTMLImageElement)) return null;
      return { value: image.style.getPropertyValue("visibility"), priority: image.style.getPropertyPriority("visibility") };
    }, selector);
    if (!previous) return false;
    await page.evaluate((selector) => {
      const image = document.querySelector(selector);
      if (image instanceof HTMLImageElement)
        image.style.setProperty("visibility", "hidden", "important");
    }, selector);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const reference = await page.screenshot({ clip, animations: "disabled" });
    await page.evaluate(({ selector, previous }) => {
      const image = document.querySelector(selector);
      if (image instanceof HTMLImageElement) {
        if (previous.value) image.style.setProperty("visibility", previous.value, previous.priority);
        else image.style.removeProperty("visibility");
      }
    }, { selector, previous });
    if (!(await pixels(visible, reference))) return false;
  }
  return true;
}

async function browserState(page, requireFormError, requireTokenCoverage) {
  if (requireFormError) {
    await page.locator("[data-inquiry-form]").dispatchEvent("submit");
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-inquiry-form] [aria-invalid="true"]')
          .length >= 4,
    );
    await page
      .locator('[data-inquiry-form] [name="name"]')
      .evaluate((element) => element.blur());
  }
  const state = await page.evaluate(
    async ({ requireFormError, requireTokenCoverage }) => {
      await document.fonts.ready;
      return {
        motion:
          document.documentElement.dataset.motion === "reduce" &&
          [...document.querySelectorAll("[data-motion-effect]")].every(
            (element) =>
              getComputedStyle(element).animationPlayState === "paused",
          ),
        overflow: document.body.scrollWidth <= innerWidth,
        images: [...document.images].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
        font: [...document.fonts].some((face) => face.status === "loaded"),
        formError:
          !requireFormError || !document.querySelector("[data-inquiry-form]") ||
          document.querySelectorAll('[data-inquiry-form] [aria-invalid="true"]')
            .length >= 4,
        optionalEmpty:
          !requireTokenCoverage ||
          !document.querySelector(
            `[data-block-id="${"77777777-7777-4777-8777-000000000009"}"] a, [data-block-id="${"77777777-7777-4777-8777-000000000009"}"] ul`,
          ),
        backgrounds:
          !requireTokenCoverage ||
          new Set([...document.querySelectorAll("[data-background], [class*='theme-']")].flatMap((element) => [element.dataset.background, ...[...element.classList].filter((name) => /^theme-(default|subtle|brand|accent|highlight|inverse)$/.test(name)).map((name) => name.slice(6))]).filter(Boolean)).size === 6,
        logoTones:
          !requireTokenCoverage ||
          new Set(
            [...document.querySelectorAll("[data-logo-tone]")].map(
              (element) => element.dataset.logoTone,
            ),
          ).size === 2,
        motionIntents:
          !requireTokenCoverage ||
          new Set([...document.querySelectorAll("[data-motion-intent], [class*='motion-']")].flatMap((element) => [element.dataset.motionIntent, ...[...element.classList].filter((name) => /^motion-(none|subtle|ambient|signature)$/.test(name)).map((name) => name.slice(7))]).filter(Boolean)).size === 4,
        value: document.documentElement.dataset.motion,
      };
    },
    { requireFormError, requireTokenCoverage },
  );
  return state;
}

/**
 * Render a theme against the neutral publishing contract fixture.
 * @param {{ themePackage: string, artifactsDir?: string, updateBaselines?: boolean }} options
 */
export async function runThemeConformance({ themePackage = "@site-engine/theme-starter", artifactsDir, baselineFile, recordBaselines = false } = {}) {
  const temp = await mkdtemp(
    join(tmpdir(), "site-engine-starter-conformance-"),
  );
  try {
    const consumerRequire = createRequire(join(process.cwd(), "package.json"));
    const themeManifest = themePackage.includes("/") && !themePackage.startsWith("@")
      ? join(resolve(themePackage), "theme.json")
      : (() => { try { return consumerRequire.resolve(`${themePackage}/theme.json`); } catch { return require.resolve(`${themePackage}/theme.json`); } })();
    const starter = dirname(themeManifest);
    const engineEntry = fileURLToPath(import.meta.resolve("@site-engine/engine"));
    const validator = join(dirname(engineEntry), "theme-package-cli.js");
    const packageVersion = async (entry) => JSON.parse(await readFile(join(dirname(entry), "..", "package.json"), "utf8")).version;
    const versionPins = {
      contractVersion: await packageVersion(fileURLToPath(import.meta.resolve("@site-engine/contract"))),
      engineVersion: await packageVersion(engineEntry),
      themeVersion: JSON.parse(await readFile(themeManifest, "utf8")).version,
    };
    await execFile(process.execPath, [validator, starter]);
    const manifest = JSON.parse(await readFile(themeManifest, "utf8"));
    const identity = { name: manifest.name, themeVersion: versionPins.themeVersion, engineVersion: versionPins.engineVersion };
    const isBundledStarter = themePackage === "@site-engine/theme-starter";
    if (recordBaselines && !baselineFile) throw new Error("recordBaselines requires an explicit caller-owned baselineFile.");
    const selectedBaseline = baselineFile ? resolve(baselineFile) : isBundledStarter ? baselinePath : undefined;
    delete manifest.contractSurface.components.blockRenderer;
    const invalid = join(temp, "invalid-theme");
    await (
      await import("node:fs/promises")
    ).cp(await realpath(starter), invalid, { recursive: true });
    await writeFile(join(invalid, "theme.json"), JSON.stringify(manifest));
    await execFile(process.execPath, [validator, invalid]).then(
      () => {
        throw new Error(
          "Validator accepted a missing required contract component.",
        );
      },
      (error) => {
        if (!String(error.stderr).includes("blockRenderer")) throw error;
      },
    );
    await requireActionableRequiredFieldRejection();
    const { buildSnapshot } = await import(
      new URL("../harness/build-snapshot.mjs", import.meta.url).href
    );
    const outputRoot = join(temp, "output");
    await mkdir(outputRoot);
    const input = join(temp, "fixture.json");
    await writeFile(input, JSON.stringify(fixture()));
    const built = await buildSnapshot({
      input,
      publicOrigin: "https://example.test",
      outputRoot,
      themeComponentsRoot: await realpath(join(starter, "src/components")),
      versionPins,
    });
    const html = await readFile(
      join(built.output, "general/matrix/index.html"),
      "utf8",
    );
    for (const type of blocks)
      if (!html.includes(`data-block="${type}"`) && !html.includes(`data-block-type="${type}"`))
        throw new Error(`Installed starter omitted ${type}.`);
    const evidence = resolve(artifactsDir || join(process.cwd(), "artifacts/theme-conformance"));
    await mkdir(evidence, { recursive: true });
    const server = createServer(async (request, response) => {
      const raw = decodeURIComponent(
        new URL(request.url || "/", "http://localhost").pathname,
      ).replace(/^\/+/, "");
      const relative =
        raw && !extname(raw)
          ? `${raw.replace(/\/$/, "")}/index.html`
          : raw.replace(/\/$/, "/index.html") || "index.html";
      if (relative.split("/").includes(".."))
        return response.writeHead(400).end();
      try {
        const bytes = await readFile(join(built.output, relative));
        response
          .writeHead(200, {
            "content-type":
              {
                ".html": "text/html",
                ".css": "text/css",
                ".js": "text/javascript",
                ".svg": "image/svg+xml",
                ".woff2": "font/woff2",
                ".ttf": "font/ttf",
                ".webm": "video/webm",
                ".vtt": "text/vtt",
              }[extname(relative)] || "application/octet-stream",
          })
          .end(bytes);
      } catch {
        response.writeHead(404).end("missing");
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const port = server.address().port;
    const { chromium } = await import("@playwright/test");
    const axe = (await import("axe-core")).default.source;
    const browser = await chromium.launch({ headless: true });
    const paths = [
      "",
      "general/matrix",
      "general/neutral-listing",
      "general/neutral-pillar",
      "general/neutral-pillar/neutral-service",
      "general/neutral-article",
      "general/neutral-job",
    ];
    const screenshots = {};
    try {
      for (const path of paths)
        for (const width of [1440, 390]) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          await page.goto(`http://127.0.0.1:${port}/${path}`, {
            waitUntil: "networkidle",
          });
          await page.addScriptTag({ content: axe });
          const violations = await page.evaluate(
            async () => (await window.axe.run()).violations,
          );
          const state = await browserState(
            page,
            path === "general/matrix",
            path === "general/matrix",
          );
          if (path === "general/matrix") {
            const glyphPage = await context.newPage();
            try {
              await glyphPage.goto(`http://127.0.0.1:${port}/${path}`, {
                waitUntil: "networkidle",
              });
              await glyphPage.addStyleTag({
                content:
                  "*,*::before,*::after { animation: none !important; transition: none !important; }",
              });
              state.logoVisibility = await renderedGlyphVisibility(glyphPage);
            } finally {
              await glyphPage.close();
            }
          } else state.logoVisibility = true;
          if (
            violations.length ||
            !state.motion ||
            !state.overflow ||
            !state.images ||
            !state.font ||
            !state.formError ||
            !state.optionalEmpty ||
            !state.backgrounds ||
            !state.logoTones ||
            !state.logoVisibility ||
            !state.motionIntents
          )
            throw new Error(
              `${path} ${width}px failed public conformance: ${JSON.stringify({ violations: violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.target) })), ...state })}`,
            );
          if (path === "general/matrix") {
            await page.reload({ waitUntil: "networkidle" });
            await page.evaluate(() => document.fonts.ready);
            await page.evaluate(async () => {
              const videos = [...document.querySelectorAll("video")];
              const waitFor = (video, event) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 10_000);
                video.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
              });
              for (const video of videos) {
                if (video.readyState < HTMLMediaElement.HAVE_METADATA)
                  await waitFor(video, "loadedmetadata");
                if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
                  await waitFor(video, "canplay");
                video.muted = true;
                await video.play();
                await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                if (video.currentTime <= 0 || video.paused)
                  throw new Error("Video did not play after canplay.");
                video.pause();
                video.currentTime = 0;
                // Native controls include a transient Chromium loading spinner.
                // Playback above verifies the control's media source; removing
                // the controls only for the screenshot makes its pixels stable.
                video.removeAttribute("controls");
              }
            });
          }
          await page.addStyleTag({
            content:
              "*,*::before,*::after { animation: none !important; caret-color: transparent !important; transition: none !important; } [data-inquiry-form] { display: none !important; }",
          });
          await stabilizeCaptureState(page);
          const filename = `${path.replaceAll("/", "_") || "home"}-${width}.png`;
          const screenshot = join(evidence, filename);
          await page.screenshot({ path: screenshot, fullPage: true });
          screenshots[filename] = sha256(await readFile(screenshot));
          await writeFile(
            join(
              evidence,
              `${path.replaceAll("/", "_") || "home"}-${width}-axe.json`,
            ),
            JSON.stringify({ violations }, null, 2),
          );
          await context.close();
        }
      await assertVisualBaselines(screenshots, { file: selectedBaseline, record: recordBaselines, identity });
      await writeFile(join(evidence, "conformance-report.json"), `${JSON.stringify({ identity, blocks: blocks.length, cases: paths.length * 2, baselineFile: selectedBaseline }, null, 2)}\n`);
    } finally {
      await browser.close();
      await new Promise((done) => server.close(done));
    }
    return { blocks: blocks.length, cases: paths.length * 2 };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runThemeConformance().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    },
  );

// Gallery rendering and conformance intentionally share one synthetic fixture.
export { fixture as createConformanceFixture };
