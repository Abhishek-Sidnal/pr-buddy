import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import {
  appCredentialsSchema,
  CONFIG_FILE_PATH,
  type AppCredentials,
  type AppManifest,
} from "./manifest.js";

export interface RegistrationDependencies {
  readonly manifest: AppManifest;
  /** An unguessable value that ties GitHub's answer to the request this command started. */
  readonly state: string;
  /** Whether the path of the configuration file still has to be entered by hand. */
  readonly needsFilePath: boolean;
  /** Called once with the credentials GitHub returned. It stores them; it must not print them. */
  readonly onRegistered: (credentials: AppCredentials) => Promise<void>;
  /** Called after the last page was sent, whether the registration worked or not. */
  readonly onFinished: (outcome: "registered" | "failed") => void;
  /** Replaces the global `fetch`; used by tests. */
  readonly fetch?: typeof fetch;
}

const GITHUB_NEW_APP_URL = "https://github.com/settings/apps/new";
const GITHUB_API_URL = "https://api.github.com";
/** GitHub's codes are short and plain; anything unlike one is not sent to GitHub. */
const CODE_FORMAT = /^[A-Za-z0-9_-]{1,256}$/;
const EXCHANGE_TIMEOUT_MS = 20_000;

const BAD_REQUEST = 400;
const BAD_GATEWAY = 502;
const GONE = 410;

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}

function isSameText(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The two pages of registering a GitHub App from a manifest: one that sends the manifest to
 * GitHub, and one GitHub sends the browser back to. It serves one registration and then
 * answers nothing more. See docs/DESIGN-OPERATIONS.md, section 6.
 */
export function createRegistrationRouter(dependencies: RegistrationDependencies): Router {
  const { manifest, state, onRegistered, onFinished } = dependencies;
  const send = dependencies.fetch ?? fetch;
  const router = Router();
  let isUsed = false;

  router.use((_request, response, next) => {
    // Nothing here may be framed, cached or read by another site's script.
    response.set({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    next();
  });

  router.get("/", (_request, response) => {
    const permissions = Object.entries(manifest.default_permissions)
      .map(([name, access]) => `<li>${escapeHtml(name)}: ${escapeHtml(access)}</li>`)
      .join("");
    response.type("html").send(
      page(
        "Register a GitHub App for PR Buddy",
        `<p>This sends GitHub a description of the app. GitHub then asks you to confirm, and sends you back here.</p>
<ul>
<li>Name: <strong>${escapeHtml(manifest.name)}</strong></li>
<li>Webhooks go to: <code>${escapeHtml(manifest.hook_attributes.url)}</code></li>
<li>Sign-in comes back to: <code>${escapeHtml(manifest.callback_urls[0] ?? "")}</code></li>
<li>Anyone may install it: ${manifest.public ? "yes" : "no"}</li>
</ul>
<p>Permissions:</p>
<ul>${permissions}</ul>
<form method="post" action="${GITHUB_NEW_APP_URL}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit" style="font: inherit; padding: 0.5rem 1rem">Continue on GitHub</button>
</form>`,
      ),
    );
  });

  router.get("/callback", async (request, response) => {
    const code = typeof request.query["code"] === "string" ? request.query["code"] : "";
    const receivedState = typeof request.query["state"] === "string" ? request.query["state"] : "";

    if (isUsed) {
      response
        .status(GONE)
        .type("html")
        .send(page("Already done", "<p>This registration has already been completed.</p>"));
      return;
    }
    if (!isSameText(state, receivedState) || !CODE_FORMAT.test(code)) {
      // Not the answer to the request this command started. It may be tried again.
      response
        .status(BAD_REQUEST)
        .type("html")
        .send(
          page(
            "Not registered",
            "<p>This is not the answer to the request that was started here. Nothing was saved. Go back to the first page and try again.</p>",
          ),
        );
      return;
    }
    isUsed = true;

    let credentials: AppCredentials;
    try {
      const reply = await send(`${GITHUB_API_URL}/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      if (!reply.ok) {
        throw new Error(`GitHub answered ${reply.status}.`);
      }
      credentials = appCredentialsSchema.parse(await reply.json());
      await onRegistered(credentials);
    } catch {
      // The reason is not shown: it could carry part of what GitHub returned.
      response
        .status(BAD_GATEWAY)
        .type("html")
        .send(
          page(
            "Not registered",
            "<p>GitHub created the app, but its credentials could not be fetched or stored. Nothing was saved. Delete the app on GitHub and run the command again.</p>",
          ),
        );
      onFinished("failed");
      return;
    }

    const installUrl = `https://github.com/apps/${credentials.slug}/installations/new`;
    const permissionsUrl = `https://github.com/settings/apps/${credentials.slug}/permissions`;
    response.type("html").send(
      page(
        "The app is registered",
        `<p>Its credentials are in your environment file. They were not shown here and are not in this page.</p>
<ol>
${
  dependencies.needsFilePath
    ? `<li><strong>Enter the file's path.</strong> Open <a href="${permissionsUrl}">the app's permissions</a>, find <em>Single file</em> under repository permissions, add the path <code>${escapeHtml(CONFIG_FILE_PATH)}</code> and save. Do this before installing the app.</li>`
    : ""
}
<li><a href="${installUrl}">Install the app</a> on a repository.</li>
<li>Start PR Buddy again, so that it reads the new settings.</li>
</ol>
<p>You can close this tab.</p>`,
      ),
    );
    onFinished("registered");
  });

  return router;
}
