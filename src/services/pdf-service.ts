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
    const uint8 = await page.pdf({ format: "a4", printBackground: true });
    return Buffer.from(uint8);
  } finally {
    await page.close();
  }
}
