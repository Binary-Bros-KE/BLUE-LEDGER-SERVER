import path from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env.js";
import { errorHandler } from "./middleware/error-handler.js";
import { accountsRouter } from "./routes/accounts.js";
import { activationRouter } from "./routes/activation.js";
import { authRouter } from "./routes/auth.js";
import { billingMpesaRouter } from "./routes/billing-mpesa.js";
import { mobileRouter } from "./routes/mobile.js";
import { mpesaRouter } from "./routes/mpesa.js";
import { outletsRouter } from "./routes/outlets.js";
import { plansRouter } from "./routes/plans.js";
import { shareRouter } from "./routes/share.js";
import { syncRouter } from "./routes/sync.js";
import { tenantsRouter } from "./routes/tenants.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS }));
app.use(morgan("dev"));
// Default express.json() limit is 100kb — comfortably exceeded by a single sync push batch of
// nested documents (sales/quotations/purchases carry items/serviceCharges/delivery inline). The
// desktop client now chunks pushes into bounded batches (see sync-engine.ts's PUSH_BATCH_SIZE), so
// this is headroom for one unusually heavy batch, not a substitute for that chunking.
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// electron-updater's "generic" provider feed — plain static files (the NSIS installer, its
// .blockmap, and latest.yml), no API logic needed at all. Requested by DESKTOP's main process via
// Node's own HTTP client, not a browser fetch, so helmet's CORS/CORP headers above never apply to
// it. Manually populated after each `npm run dist:win` — see RELEASES_DIR's own env.ts comment.
app.use("/releases", express.static(path.resolve(env.RELEASES_DIR)));

app.use("/auth", authRouter);
app.use("/tenants", tenantsRouter);
app.use("/accounts", accountsRouter);
app.use("/outlets", outletsRouter);
app.use("/plans", plansRouter);
app.use("/activation", activationRouter);
app.use("/sync", syncRouter);
app.use("/mobile", mobileRouter);
app.use("/share", shareRouter);
app.use("/mpesa", mpesaRouter);
app.use("/billing-mpesa", billingMpesaRouter);

// Must be registered last — Express only treats a 4-arg function as an error handler.
app.use(errorHandler);
