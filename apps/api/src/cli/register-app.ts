import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import express from "express";
import { mergeEnvFile } from "../modules/app-registration/env-file.js";
import {
  buildManifest,
  registrationOptionsSchema,
  toEnvironment,
} from "../modules/app-registration/manifest.js";
import { createRegistrationRouter } from "../modules/app-registration/registration.router.js";

/**
 * Registers a GitHub App for PR Buddy from a manifest and writes its credentials to an
 * environment file. It serves one page on this machine, and stops when the app is registered
 * or after an hour. It never prints a secret. See docs/GITHUB_APP.md, section 2.
 *
 *   register-app --webhook-url https://smee.io/<channel> [--name <name>]
 *                [--public-url http://localhost:3000] [--write-to .env] [--port 3999]
 *                [--public] [--contents]
 */

const STATE_BYTES = 32;
/** GitHub gives an hour to finish; after that the code it sends back is worthless. */
const GIVE_UP_AFTER_MS = 60 * 60 * 1_000;
const OWNER_ONLY = 0o600;

/** The flag behind each option, for a message that names what the person typed. */
const FLAGS: Readonly<Record<string, string>> = {
  name: "--name",
  webhookUrl: "--webhook-url",
  publicUrl: "--public-url",
  port: "--port",
};

const USAGE = `Usage: register-app --webhook-url <address> [options]

  --webhook-url <address>  Where GitHub sends webhooks: your relay, or the service's
                           own /webhooks/github address. Required.
  --name <name>            The app's name on GitHub. Must be unused there.
                           Default: pr-buddy-dev
  --public-url <address>   Where the dashboard is reached. Default: http://localhost:3000
  --write-to <path>        The file to write the credentials to. Default: .env
  --port <number>          The port of the page this command serves. Default: 3999
  --public                 Let anyone install the app. Default: only you.
  --contents               Ask to read all code, not the one configuration file.
                           Saves a manual step; grants more.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    "webhook-url": { type: "string" },
    name: { type: "string", default: "pr-buddy-dev" },
    "public-url": { type: "string", default: "http://localhost:3000" },
    // Not "--env-file": Node.js takes a flag of that name for itself, wherever it stands.
    "write-to": { type: "string", default: ".env" },
    port: { type: "string", default: "3999" },
    public: { type: "boolean", default: false },
    contents: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const parsed = registrationOptionsSchema.safeParse({
  name: values.name,
  webhookUrl: values["webhook-url"] ?? "",
  publicUrl: values["public-url"],
  isPublic: values.public,
  configAccess: values.contents ? "contents" : "single-file",
  port: Number(values.port),
});
if (!parsed.success) {
  fail(
    parsed.error.issues
      .map((issue) => `${FLAGS[String(issue.path[0])] ?? "option"}: ${issue.message}`)
      .join("\n"),
  );
}
const options = parsed.data;
const envFile = resolve(values["write-to"]);
const state = randomBytes(STATE_BYTES).toString("base64url");

const app = express();
app.disable("x-powered-by");
app.use(
  createRegistrationRouter({
    manifest: buildManifest(options),
    state,
    needsFilePath: options.configAccess === "single-file",
    onRegistered: (credentials) => {
      const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
      if (before !== "") {
        // The previous credentials may be the only copy of another app's key.
        const backup = `${envFile}.before-register-app`;
        copyFileSync(envFile, backup);
        chmodSync(backup, OWNER_ONLY);
      }
      writeFileSync(envFile, mergeEnvFile(before, toEnvironment(credentials, options.publicUrl)), {
        mode: OWNER_ONLY,
      });
      process.stdout.write(
        `Registered the GitHub App "${credentials.slug}" (ID ${String(credentials.id)}).\n` +
          `Its credentials are in ${envFile}.\n` +
          (before === "" ? "" : `The previous file was kept as ${envFile}.before-register-app.\n`) +
          `Next steps are on the page in your browser.\n`,
      );
      return Promise.resolve();
    },
    onFinished: (outcome) => {
      // Let the last page reach the browser before the process ends.
      server.close();
      setTimeout(() => process.exit(outcome === "registered" ? 0 : 1), 500).unref();
    },
  }),
);

const server = app.listen(options.port, () => {
  process.stdout.write(
    `Open http://localhost:${String(options.port)}/ in your browser to register the app.\n` +
      `Waiting for up to an hour. Press Ctrl+C to give up; nothing is saved until GitHub answers.\n`,
  );
});

setTimeout(() => {
  process.stderr.write("Gave up after an hour. Nothing was saved.\n");
  process.exit(1);
}, GIVE_UP_AFTER_MS).unref();
