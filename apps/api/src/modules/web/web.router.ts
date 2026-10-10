import { join } from "node:path";
import express, { Router, type RequestHandler } from "express";

/**
 * What a dashboard page may load and do: everything from its own origin, nothing else. There is
 * no inline-script allowance, so text that reached the page as markup still could not run.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Headers for everything the dashboard serves. */
export const setDashboardHeaders: RequestHandler = (_request, response, next) => {
  response.set({
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  next();
};

/**
 * Serves the built web application. Files under `assets/` have a content hash in their name and
 * may be cached for good; the page itself is never cached, so a new release is picked up at once.
 * Any other path gets the page, and the application's own router decides what to show.
 */
export function createWebRouter(webRoot: string): Router {
  const router = Router();

  router.use(
    "/assets",
    express.static(join(webRoot, "assets"), {
      index: false,
      setHeaders: (response) => {
        response.set("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
      },
    }),
    // A missing asset is an error, not a reason to send the page in its place.
    (_request, response) => {
      response.status(404).json({ error: "not_found" });
    },
  );

  router.get(/.*/, (_request, response, next) => {
    response.sendFile("index.html", { root: webRoot }, (error) => {
      if (error !== undefined) {
        next(error);
      }
    });
  });

  return router;
}
