import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpError } from "../lib/http-error.js";

/** Central error handler — every route in this app can just `throw`, including inside async
 * handlers (Express 5 forwards rejected promises here automatically). Keep route code free of
 * try/catch for the error-shape concerns handled here. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", fieldErrors: err.flatten().fieldErrors });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "field";
      res.status(409).json({ error: `${target} already in use` });
      return;
    }
    if (err.code === "P2025") {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }

  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
