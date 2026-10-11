import { z } from "zod";

/** The file PR Buddy reads from a repository, and the only one it needs. */
export const CONFIG_FILE_PATH = ".github/pr-buddy.json";

const APP_NAME_MAX_LENGTH = 34;

/** An `https://` address, or plain `http://` on this machine, without credentials. */
function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const isSafeScheme = url.protocol === "https:" || (url.protocol === "http:" && isLocal);
  return isSafeScheme && url.username === "" && url.password === "";
}

/** What the person registering the app decides. Everything else is fixed by what PR Buddy needs. */
export const registrationOptionsSchema = z.strictObject({
  /** GitHub allows up to 34 characters, and the name must be unused on GitHub. */
  name: z
    .string()
    .min(1)
    .max(APP_NAME_MAX_LENGTH)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "must be letters, digits, spaces, dots or hyphens"),
  /** Where GitHub delivers webhooks: a relay for development, the service itself otherwise. */
  webhookUrl: z.string().refine(isHttpUrl, "must be an https:// address"),
  /** Where people reach the dashboard. Sign-in comes back to it. */
  publicUrl: z
    .string()
    .refine(isHttpUrl, "must be https://, or http://localhost")
    .transform((value) => new URL(value).origin),
  /** Whether anyone may install the app. A development app is private. */
  isPublic: z.boolean(),
  /**
   * How the app reads `.github/pr-buddy.json`. "single-file" asks for that one file, which
   * needs its path entered by hand afterwards; "contents" asks to read all code, and needs
   * nothing more.
   */
  configAccess: z.enum(["single-file", "contents"]),
  /** The port of the page this command serves, where GitHub sends the browser back. */
  port: z.number().int().min(1024).max(65_535),
});

export type RegistrationOptions = z.infer<typeof registrationOptionsSchema>;

/** A GitHub App manifest, as GitHub documents it. */
export interface AppManifest {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly hook_attributes: { readonly url: string; readonly active: boolean };
  readonly redirect_url: string;
  readonly callback_urls: readonly string[];
  readonly setup_url: string;
  readonly setup_on_update: boolean;
  readonly public: boolean;
  readonly request_oauth_on_install: boolean;
  readonly default_events: readonly string[];
  readonly default_permissions: Readonly<Record<string, "read" | "write">>;
}

/** Where GitHub sends the browser once the app exists. Only this command listens there. */
export function redirectUrlFor(port: number): string {
  return `http://localhost:${port}/callback`;
}

/**
 * The app PR Buddy needs: it may comment on pull requests and read one file, it hears about
 * pull requests, and people who install it are sent to the dashboard's sign-in.
 */
export function buildManifest(options: RegistrationOptions): AppManifest {
  return {
    name: options.name,
    url: options.publicUrl,
    description: "Reviews pull requests with fixed rules and keeps one comment up to date.",
    hook_attributes: { url: options.webhookUrl, active: true },
    redirect_url: redirectUrlFor(options.port),
    callback_urls: [`${options.publicUrl}/auth/callback`],
    setup_url: `${options.publicUrl}/auth/login`,
    setup_on_update: true,
    public: options.isPublic,
    // GitHub would send people back in a way the dashboard's sign-in refuses (D-084).
    request_oauth_on_install: false,
    default_events: ["pull_request"],
    default_permissions: {
      metadata: "read",
      pull_requests: "write",
      // An organisation permission. Without it GitHub refuses to say whether the person signing
      // in is an owner of an organisation, and then nobody there may set its AI key (D-095).
      members: "read",
      ...(options.configAccess === "contents"
        ? { contents: "read" as const }
        : { single_file: "read" as const }),
    },
  };
}

/** The credentials GitHub hands over, once, in exchange for the code it sent the browser with. */
export const appCredentialsSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/),
  pem: z
    .string()
    .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/),
  webhook_secret: z.string().min(1),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

export type AppCredentials = z.infer<typeof appCredentialsSchema>;

/** The settings the service reads, from what GitHub returned. The key is put on one line. */
export function toEnvironment(
  credentials: AppCredentials,
  publicUrl: string,
): Readonly<Record<string, string>> {
  return {
    GITHUB_APP_ID: String(credentials.id),
    GITHUB_PRIVATE_KEY: credentials.pem.trim().split(/\r?\n/).join("\\n"),
    GITHUB_WEBHOOK_SECRET: credentials.webhook_secret,
    GITHUB_CLIENT_ID: credentials.client_id,
    GITHUB_CLIENT_SECRET: credentials.client_secret,
    GITHUB_APP_SLUG: credentials.slug,
    PUBLIC_URL: publicUrl,
  };
}
