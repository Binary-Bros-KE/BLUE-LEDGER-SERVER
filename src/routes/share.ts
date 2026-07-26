import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireDevice } from "../middleware/device-auth.js";
import { buildDocumentHtml, documentFilenameBase } from "../services/document-html.js";
import { renderHtmlToPdf } from "../services/pdf-service.js";
import * as shareService from "../services/share-service.js";

/** Minting a link is gated by requireDevice (the desktop's own {tenantId, deviceId}, same as every
 * /sync/* route). Resolving one is fully public — the token itself, not a session, is the
 * authorization, same model as any share-link product (Dropbox, Google Docs, etc.): unguessable,
 * scoped to one document, expires on its own. */
export const shareRouter = Router();

/** Basic scrape/abuse hygiene, not a credential-guessing defense — a share token is a signed JWT,
 * not a brute-forceable PIN, so this is nowhere near as strict as mobile-auth's loginLimiter. */
const shareViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

shareRouter.post("/links", requireDevice, async (req, res) => {
  const result = await shareService.createShareLink(req.body);
  res.status(201).json(result);
});

shareRouter.get("/:token", shareViewLimiter, async (req, res) => {
  const result = await shareService.getSharedDocument(req.params.token as string);
  res.json(result);
});

/** Serves the EXACT same HTML DESKTOP itself renders to PDF for this document (see document-html.ts)
 * — used ONLY for the public page's "Print" action (loaded into a hidden same-origin iframe, then
 * printed), never as the page's own on-screen preview — the landing page itself is its own
 * responsive React view (DocumentView.tsx etc.), which stayed genuinely mobile-friendly in a way this
 * letterhead-styled HTML deliberately isn't (A4-shaped, not built to reflow). Errors are caught here
 * (not left to the JSON error middleware) since this response is meant to be embedded — a broken/
 * expired link renders its own small HTML message instead of a raw JSON error inside the iframe. */
shareRouter.get("/:token/print", shareViewLimiter, async (req, res) => {
  try {
    const doc = await shareService.getSharedDocument(req.params.token as string);
    res.type("html").send(buildDocumentHtml(doc));
  } catch {
    res
      .type("html")
      .status(410)
      .send(
        "<!doctype html><html><body style=\"font-family:Arial,sans-serif;padding:40px;text-align:center;color:#666;\">" +
          "This link has expired or is no longer valid.</body></html>",
      );
  }
});

/** The real "Download" action — renders the same HTML to an actual PDF file (via puppeteer, see
 * pdf-service.ts) and serves it as a plain attachment. This is what makes the file save immediately
 * with no browser print dialog and no "type a filename" step: Content-Disposition's filename is
 * authoritative, so the browser just downloads it under the right name straight away. */
shareRouter.get("/:token/download", shareViewLimiter, async (req, res) => {
  const doc = await shareService.getSharedDocument(req.params.token as string);
  const pdf = await renderHtmlToPdf(buildDocumentHtml(doc));
  res
    .status(200)
    .type("application/pdf")
    .set("Content-Disposition", `attachment; filename="${documentFilenameBase(doc)}.pdf"`)
    .send(pdf);
});
