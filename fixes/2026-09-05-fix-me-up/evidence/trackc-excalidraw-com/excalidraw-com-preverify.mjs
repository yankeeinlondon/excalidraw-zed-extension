// Track C pre-verify: load a hand-injected `exportWithDarkMode: true`
// .excalidraw file on excalidraw.com (normal path: drop onto the canvas) and
// read the export dialog "Dark mode" checkbox. Also runs a keyless control
// in a fresh browser context.
//
// Usage: node excalidraw-com-preverify.mjs <file-with-key> <file-without-key> <outdir>
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const [,, withKey, withoutKey, outdir] = process.argv;
fs.mkdirSync(outdir, { recursive: true });

async function dropFile(page, file) {
  const buf = [...fs.readFileSync(file)];
  const name = path.basename(file);
  return page.evaluate(async ({ bytes, name: fname }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(bytes)], fname, { type: "application/json" }));
    const target = document.querySelector(".excalidraw") || document.querySelector("canvas") || document.body;
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return { target: target.tagName };
  }, { bytes: buf, name });
}

async function readExportDialog(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".ImageExportModal__settings__setting")];
    const out = {};
    for (const row of rows) {
      const label = ((row.querySelector("label") || {}).textContent || "").trim();
      const input = row.querySelector("input");
      if (label && input) out[label] = { checked: input.checked, type: input.type };
    }
    return out;
  });
}

async function runCase(name, file) {
  const record = { case: name, steps: [], pageErrors: [] };
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => record.pageErrors.push(String(e).slice(0, 300)));
  try {
    await page.goto("https://excalidraw.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4500);
    record.undoDisabledBefore = await page.$eval('[data-testid="button-undo"]', b => b.disabled).catch(() => null);
    record.titleBefore = await page.title();

    const drop = await dropFile(page, file);
    record.steps.push(`dropped onto <${drop.target}>`);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(outdir, `${name}-2-loaded.png`) });
    record.undoDisabledAfter = await page.$eval('[data-testid="button-undo"]', b => b.disabled).catch(() => null);
    record.titleAfter = await page.title();

    await page.click('[data-testid="main-menu-trigger"]');
    await page.waitForTimeout(800);
    await page.click('[data-testid="image-export-button"]');
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(outdir, `${name}-3-export-dialog.png`) });
    await page.waitForSelector(".ImageExportModal", { timeout: 10000 });
    record.exportDialogControls = await readExportDialog(page);
    record.assetUrls = await page.evaluate(() =>
      performance.getEntriesByType("resource").map(r => r.name).filter(u => /static\/js|excalidraw.*\.js/i.test(u)).slice(0, 6)
    ).catch(() => []);
    return record;
  } finally {
    fs.writeFileSync(path.join(outdir, `${name}-record.json`), JSON.stringify(record, null, 2));
    await browser.close();
  }
}

const results = [];
results.push(await runCase("with-key", withKey));
results.push(await runCase("without-key", withoutKey));
console.log("SUMMARY");
for (const r of results) {
  const dm = r.exportDialogControls && r.exportDialogControls["Dark mode"];
  console.log(`${r.case}: sceneLoaded=${r.undoDisabledBefore === true && r.undoDisabledAfter === false} darkModeCheckbox=${dm ? dm.checked : "n/a"} title=${JSON.stringify(r.titleAfter)} pageErrors=${r.pageErrors.length}`);
}
fs.writeFileSync(path.join(outdir, "results.json"), JSON.stringify(results.map(r => ({
  case: r.case,
  undoDisabledBefore: r.undoDisabledBefore,
  undoDisabledAfter: r.undoDisabledAfter,
  titleAfter: r.titleAfter,
  exportDialogControls: r.exportDialogControls,
  pageErrors: r.pageErrors,
  assetUrls: r.assetUrls,
})), null, 2));
