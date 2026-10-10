import {
  cleanup,
  screen,
  waitFor,
  within,
  type BoundFunctions,
  type queries,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contactHref, httpsUrl } from "../src/operator-links.js";
import { fakeApi, ME, renderApp, type Answer } from "./helpers.js";

const OPERATOR = {
  name: "Acme Reviews Ltd",
  contact: "privacy@acme.example",
  privacyUrl: "https://acme.example/privacy",
  termsUrl: "https://acme.example/terms",
};
const UNNAMED = { name: null, contact: null, privacyUrl: null, termsUrl: null };

function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { appSlug: "pr-buddy-acme", operator: OPERATOR, retentionDays: 365, ...overrides };
}

function signedOut(answer: Answer = service()): ReturnType<typeof fakeApi> {
  return fakeApi({ "/api/me": 401, "/auth/service": answer });
}

const region = async (name: string): Promise<BoundFunctions<typeof queries>> =>
  within(await screen.findByRole("region", { name }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("links made from what an operator configured", () => {
  it.each([
    ["https://acme.example/privacy", "https://acme.example/privacy"],
    ["https://acme.example/p?lang=en#data", "https://acme.example/p?lang=en#data"],
    ["https://ACME.example", "https://acme.example/"],
  ])("keeps the https address %s", (value, expected) => {
    expect(httpsUrl(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "acme.example/privacy",
    "http://acme.example/privacy",
    "//acme.example/privacy",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "https://user:pw@acme.example/",
    `https://acme.example/${"a".repeat(500)}`,
  ])("makes no link from %j", (value) => {
    expect(httpsUrl(value)).toBeUndefined();
  });

  it("makes a mail link from an email address, and a plain link from an https address", () => {
    expect(contactHref("privacy@acme.example")).toBe("mailto:privacy@acme.example");
    expect(contactHref("first.last+pr@mail.acme.example")).toBe(
      "mailto:first.last+pr@mail.acme.example",
    );
    expect(contactHref("https://acme.example/contact")).toBe("https://acme.example/contact");
  });

  it.each([
    null,
    undefined,
    "",
    "not an address",
    "privacy@acme",
    "mailto:privacy@acme.example",
    "privacy@acme.example?subject=x&body=y",
    "privacy@acme.example\nbcc:x@evil.example",
    'privacy@acme.example"onclick="x',
    "<privacy@acme.example>",
    "javascript:alert(1)",
    "http://acme.example/contact",
  ])("makes no contact link from %j", (value) => {
    expect(contactHref(value)).toBeUndefined();
  });
});

describe("the privacy page, for a visitor who is not signed in", () => {
  it("can be read without signing in, and leads back to the first page", async () => {
    const { requests } = signedOut();

    renderApp("/privacy");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Privacy and data" }),
    ).toBeDefined();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to the first page" }).getAttribute("href")).toBe(
      "/",
    );
    expect(requests).toEqual(["GET /api/me", "GET /auth/service"]);
  });

  it("says it is a description and not a contract", async () => {
    signedOut();

    renderApp("/privacy");

    expect(await screen.findByText(/It is a description, not a contract\./)).toBeDefined();
  });

  it("names the operator, how to reach them, and their own texts", async () => {
    signedOut();

    renderApp("/privacy");

    const operator = await region("Who runs this service");
    expect(await operator.findByText("Acme Reviews Ltd")).toBeDefined();
    expect(operator.getByRole("link", { name: "privacy@acme.example" }).getAttribute("href")).toBe(
      "mailto:privacy@acme.example",
    );
    const policy = operator.getByRole("link", { name: /The operator's privacy policy/ });
    expect(policy.getAttribute("href")).toBe("https://acme.example/privacy");
    expect(policy.getAttribute("rel")).toContain("noopener");
    expect(operator.getByRole("link", { name: /The operator's terms/ }).getAttribute("href")).toBe(
      "https://acme.example/terms",
    );
  });

  it("says plainly when the operator has not published who they are", async () => {
    signedOut(service({ operator: UNNAMED }));

    renderApp("/privacy");

    const operator = await region("Who runs this service");
    expect(
      await operator.findByText(
        "The operator of this service has not published who they are or how to reach them.",
      ),
    ).toBeDefined();
    expect(
      operator.getByText("The operator has not published a privacy policy or terms of their own."),
    ).toBeDefined();
    expect(operator.queryByRole("link")).toBeNull();
  });

  it("shows a name without a contact, and a contact without a name", async () => {
    signedOut(service({ operator: { ...UNNAMED, name: "Acme Reviews Ltd" } }));
    renderApp("/privacy");
    const named = await region("Who runs this service");
    expect(await named.findByText("Acme Reviews Ltd")).toBeDefined();
    expect(named.queryByText("Contact")).toBeNull();
    cleanup();

    signedOut(service({ operator: { ...UNNAMED, contact: "https://acme.example/contact" } }));
    renderApp("/privacy");
    const reachable = await region("Who runs this service");
    expect(
      (await reachable.findByRole("link", { name: "https://acme.example/contact" })).getAttribute(
        "href",
      ),
    ).toBe("https://acme.example/contact");
    expect(reachable.queryByText("Run by")).toBeNull();
  });

  it("shows what an operator configured as text, and makes no link it has not checked", async () => {
    signedOut(
      service({
        operator: {
          name: "<img src=x onerror=alert(1)>",
          contact: "javascript:alert(1)",
          privacyUrl: "javascript:alert(2)",
          termsUrl: "http://acme.example/terms",
        },
      }),
    );

    renderApp("/privacy");

    const operator = await region("Who runs this service");
    expect(await operator.findByText("<img src=x onerror=alert(1)>")).toBeDefined();
    expect(operator.getByText("javascript:alert(1)")).toBeDefined();
    expect(operator.queryByRole("link")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(
      operator.getByText("The operator has not published a privacy policy or terms of their own."),
    ).toBeDefined();
  });

  it.each<[number | null, RegExp]>([
    [365, /deleted 365 days after they were made\./],
    [1, /deleted 1 day after they were made\./],
    [0, /kept until the app is uninstalled or the repository is removed from it\./],
    [null, /This service did not say how long it keeps reviews\./],
  ])("says how long reviews are kept when the limit is %j", async (retentionDays, sentence) => {
    signedOut(service({ retentionDays }));

    renderApp("/privacy");

    const kept = await region("How long it is kept");
    expect(await kept.findByText(sentence)).toBeDefined();
    expect(kept.getByText(/Uninstalling the app from an account deletes/)).toBeDefined();
    expect(kept.getByText(/A session ends after eight hours/)).toBeDefined();
  });

  it("says what the software stores, where code goes, and what the browser keeps", async () => {
    signedOut();

    renderApp("/privacy");

    expect(
      (await region("What is stored")).getByText(/^Never stored: pull request titles/),
    ).toBeDefined();
    const code = await region("Where your code goes");
    expect(
      code.getByText(/sent to an AI provider only for a repository that opted in/),
    ).toBeDefined();
    expect(
      code.getByText(/Nothing from a repository is run, installed or checked out\./),
    ).toBeDefined();
    const browser = await region("In your browser");
    expect(browser.getByText(/There is no analytics, no advertising/)).toBeDefined();
    expect(
      (await region("Who else is involved")).getByText(/PR Buddy keeps no GitHub token/),
    ).toBeDefined();
    expect(
      (await region("What you can do")).getByText(/Uninstall the app on GitHub/),
    ).toBeDefined();
  });

  it.each<[string, Answer]>([
    ["does not answer", 500],
    ["answers something else", { hello: "world" }],
  ])("still shows what the software does when the service %s", async (_name, answer) => {
    signedOut(answer);

    renderApp("/privacy");

    const operator = await region("Who runs this service");
    expect(
      await operator.findByText(
        "The service did not answer who runs it. Reload the page to ask again.",
      ),
    ).toBeDefined();
    expect((await region("What is stored")).getByText(/^Stored: repository names/)).toBeDefined();
    expect(
      (await region("How long it is kept")).getByText(
        /This service did not say how long it keeps reviews\./,
      ),
    ).toBeDefined();
  });

  it("says that it is asking while the answer is on its way", async () => {
    let release: (response: Response) => void = () => undefined;
    fakeApi({
      "/api/me": 401,
      "/auth/service": () => Response.json(service()),
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      typeof input === "string" && input.includes("/auth/service")
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : realFetch(input, init),
    );

    renderApp("/privacy");

    const operator = await region("Who runs this service");
    expect(operator.getByText("Asking the service who runs it…")).toBeDefined();
    release(Response.json(service()));
    // The section is drawn anew once the answer is there, so the whole page is searched.
    expect(await screen.findByText("Acme Reviews Ltd")).toBeDefined();
    expect(screen.queryByText("Asking the service who runs it…")).toBeNull();
  });

  it("is linked from the first page", async () => {
    signedOut();

    renderApp();

    const link = await screen.findByRole("link", { name: /^Privacy and data/ });
    expect(link.getAttribute("href")).toBe("/privacy");
  });
});

describe("the privacy page, for someone who is signed in", () => {
  function signedIn(): ReturnType<typeof fakeApi> {
    return fakeApi({ "/api/me": ME, "/auth/service": service(), "/api/installations": 404 });
  }

  it("is a page of the dashboard, with the same content", async () => {
    signedIn();

    renderApp("/privacy");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Privacy and data" }),
    ).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeDefined();
    expect(
      await (await region("Who runs this service")).findByText("Acme Reviews Ltd"),
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: "Back to the first page" })).toBeNull();
  });

  it("is linked from the settings", async () => {
    signedIn();

    renderApp("/settings");

    const data = await region("Data handling");
    await waitFor(() => {
      expect(data.getByRole("link", { name: /^Privacy and data/ }).getAttribute("href")).toBe(
        "/privacy",
      );
    });
  });
});
