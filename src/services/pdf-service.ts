import puppeteer, { type Browser } from "puppeteer";

// A single shared browser instance, launched lazily on first use and kept alive — spawning a fresh
// Chromium process per PDF request would be needlessly slow/expensive. Mirrors DESKTOP's own
// renderHtmlToPdfBuffer (Electron's webContents.printToPDF) closely enough that a document rendered
// here and one rendered there use the same underlying engine family, not just the same HTML/CSS.
let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }
  return browserPromise;
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // Mirrors DESKTOP's renderHtmlToPdfBuffer — see document-html.ts's LETTERHEAD_STYLES doc comment.
    // A no-op when the document has no `.items-frame` at all (delivery note doesn't use it). Passed
    // as a source string (not a function reference) so this file's own Node-only tsconfig (no DOM
    // lib) doesn't need to widen just to type-check a callback that only ever runs in the browser
    // context Puppeteer evaluates it in.
    await page.evaluate(`
      (function () {
        var frame = document.querySelector(".items-frame");
        if (frame && frame.getBoundingClientRect().height < 500) frame.classList.add("fill-page");
      })();
    `);
    const uint8 = await page.pdf({
      format: "a4",
      printBackground: true,
      // Real print margins on all four sides — see document-html.ts's LETTERHEAD_STYLES doc comment
      // for why body has no CSS padding of its own anymore; this is the single source of edge
      // whitespace on every page now, mirroring DESKTOP's own renderHtmlToPdfBuffer margins.
      margin: { top: "40px", bottom: "40px", left: "40px", right: "40px" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="width:100%;font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#83795f;text-align:center;">Page <span class="pageNumber"></span> out of <span class="totalPages"></span></div>'
    });
    return Buffer.from(uint8);
  } finally {
    await page.close();
  }
}
