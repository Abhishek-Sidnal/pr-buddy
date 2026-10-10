import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiKeys } from "../src/api/client.js";
import type { InstallationList } from "../src/api/schemas.js";
import { fakeApi, ME, renderApp, type Answer } from "./helpers.js";

const SECRET = "sk-KEY-CANARY-0123456789abcd";
const KEY_PATH = "/api/installations/1001/ai-key";

const SAVED = {
  provider: "anthropic",
  model: "claude-test-1",
  region: null,
  keyHint: "abcd",
  updatedAt: "2026-10-10T10:00:00.000Z",
};

function installations(
  overrides: Partial<InstallationList["installations"][number]> = {},
): InstallationList {
  return {
    installations: [{ id: 1001, account: "acme", canManage: true, aiKey: null, ...overrides }],
  };
}

interface Sent {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
}

/** A settings page with one installation, recording what is sent to its key route. */
function open(
  list: InstallationList | number = installations(),
  keyAnswer: (sent: Sent) => Response = () => Response.json(SAVED),
): { sent: Sent[]; api: ReturnType<typeof fakeApi> } {
  const sent: Sent[] = [];
  const answer: Answer = (_url, init) => {
    const recorded: Sent = {
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      credentials: init?.credentials,
    };
    sent.push(recorded);
    return keyAnswer(recorded);
  };
  const api = fakeApi({ "/api/me": ME, "/api/installations": list, [KEY_PATH]: answer });
  renderApp("/settings");
  return { sent, api };
}

const section = (): Promise<HTMLElement> => screen.findByRole("region", { name: "AI review key" });
const block = (): Promise<HTMLElement> => screen.findByRole("article", { name: "AI key of acme" });

function fill(container: HTMLElement, values: Record<string, string>): void {
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(within(container).getByLabelText(label), { target: { value } });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the AI key section", () => {
  it("is absent when the service does not offer the feature", async () => {
    open(404);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(screen.queryByRole("region", { name: "AI review key" })).toBeNull();
  });

  it("explains itself and that a repository must still opt in", async () => {
    open();

    const region = await section();
    expect(region.textContent).toContain("An installation can use its own AI provider.");
    expect(region.textContent).toContain('"ai": { "enabled": true }');
  });

  it("says when no key is set, and offers the form to an owner", async () => {
    open();

    const article = await block();
    expect(article.textContent).toContain("No key is set.");
    expect(within(article).getByRole("button", { name: "Save key" })).toBeDefined();
    expect(within(article).queryByRole("button", { name: "Remove key" })).toBeNull();
    expect(within(article).getByLabelText<HTMLInputElement>("API key").type).toBe("password");
    expect(within(article).getByLabelText("API key").getAttribute("autocomplete")).toBe("off");
  });

  it("shows a stored key by provider, model and last four characters only", async () => {
    open(
      installations({
        aiKey: {
          ...SAVED,
          provider: "bedrock",
          model: "us.vendor.model-v1:0",
          region: "us-east-1",
        },
      }),
    );

    const facts = [...(await block()).querySelectorAll("dl.facts > div")].map(
      (fact) => fact.textContent,
    );
    expect(facts.slice(0, 3)).toEqual([
      "ProviderAWS Bedrock",
      "Modelus.vendor.model-v1:0",
      "Regionus-east-1",
    ]);
    expect(facts[3]).toMatch(/^KeyEnds in abcd\. Saved .*2026/);
  });

  it("shows a provider it does not know as written", async () => {
    open(installations({ aiKey: { ...SAVED, provider: "<b>new</b>" } }));

    const article = await block();
    expect(article.querySelector("dl.facts dd")?.textContent).toBe("<b>new</b>");
    expect(article.querySelector("b")).toBeNull();
  });

  it("gives someone who is not an owner the summary and no form", async () => {
    open(installations({ canManage: false, aiKey: SAVED }));

    const article = await block();
    expect(article.textContent).toContain("Ends in abcd");
    expect(article.textContent).toContain(
      "Only an owner of this account can set or change its key.",
    );
    expect(within(article).queryByRole("button")).toBeNull();
    expect(within(article).queryByLabelText("API key")).toBeNull();
  });

  it("names an installation whose account is unknown by its number", async () => {
    open(installations({ account: "" }));

    expect(await screen.findByRole("heading", { name: "Installation 1001" })).toBeDefined();
  });

  it("says when there are no installations, and offers a retry when loading fails", async () => {
    const { api } = open(500);
    const region = await section();
    expect((await within(region).findByRole("alert")).textContent).toContain(
      "The data could not be loaded.",
    );

    api.set("/api/installations", { installations: [] });
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));

    expect(await within(region).findByText(/GitHub lists no installation/)).toBeDefined();
  });
});

describe("saving a key", () => {
  it("sends it once, with the headers the API demands, and clears it from the page", async () => {
    const { sent } = open();
    const article = await block();
    fill(article, { Model: "  claude-test-1 ", "API key": ` ${SECRET} ` });

    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));

    expect(await within(article).findByRole("status")).toBeDefined();
    expect(within(article).getByRole("status").textContent).toBe(
      "Key saved. The provider accepted it.",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      body: { provider: "anthropic", model: "claude-test-1", apiKey: SECRET },
    });
    expect(sent[0]?.body).not.toHaveProperty("region");
    expect(sent[0]?.headers).toMatchObject({
      "x-pr-buddy-request": "1",
      "content-type": "application/json",
    });
    // The key is gone from the form and was never written anywhere else on the page.
    expect(within(article).getByLabelText<HTMLInputElement>("API key").value).toBe("");
    expect(document.body.textContent).not.toContain("CANARY");
    expect(article.textContent).toContain("Ends in abcd");
    expect(within(article).getByRole("button", { name: "Replace key" })).toBeDefined();
    expect(within(article).getByRole("button", { name: "Remove key" })).toBeDefined();
  });

  it("asks for a region only for Bedrock, and sends it", async () => {
    const { sent } = open();
    const article = await block();
    expect(within(article).queryByLabelText("Region")).toBeNull();

    fireEvent.change(within(article).getByLabelText("Provider"), { target: { value: "bedrock" } });
    fill(article, { Model: "us.vendor.model-v1:0", Region: "eu-west-1", "API key": SECRET });
    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));

    await within(article).findByRole("status");
    expect(sent[0]?.body).toEqual({
      provider: "bedrock",
      model: "us.vendor.model-v1:0",
      region: "eu-west-1",
      apiKey: SECRET,
    });
  });

  it("offers exactly the three providers, and no field for an address", async () => {
    open();
    const article = await block();

    const options = within(within(article).getByLabelText("Provider")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Anthropic",
      "OpenAI",
      "AWS Bedrock",
    ]);
    expect(within(article).queryByLabelText(/url|address|endpoint/i)).toBeNull();
  });

  it("says that it is checking, and disables the form meanwhile", async () => {
    let release: (response: Response) => void = () => undefined;
    open();
    const article = await block();
    fill(article, { Model: "m", "API key": SECRET });
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));

    const busy = await within(article).findByRole<HTMLButtonElement>("button", {
      name: "Checking and saving…",
    });
    expect(busy.disabled).toBe(true);
    expect(within(article).getByLabelText<HTMLInputElement>("API key").disabled).toBe(true);
    release(Response.json(SAVED));
    expect(await within(article).findByRole("status")).toBeDefined();
  });

  it.each<[string, () => Response, string]>([
    [
      "the provider refuses the key",
      () => Response.json({ error: "key_refused", providerStatus: 401 }, { status: 422 }),
      "The provider refused the key (HTTP 401). Nothing was saved. Check the key, and that it may use this model.",
    ],
    [
      "the provider does not know the model",
      () => Response.json({ error: "key_refused", providerStatus: 404 }, { status: 422 }),
      "The provider does not know this model, or the key may not use it (HTTP 404). Nothing was saved. Check the model name.",
    ],
    [
      "the provider cannot be reached",
      () => Response.json({ error: "provider_unreachable" }, { status: 502 }),
      "The provider could not be reached to check the key. Nothing was saved. Try again in a moment.",
    ],
    [
      "the input is invalid",
      () =>
        Response.json(
          { error: "invalid_input", fields: ["model", "apiKey", "x"] },
          { status: 400 },
        ),
      "Some of what you entered is not valid: model, key, form. Nothing was saved.",
    ],
    [
      "the input is invalid without named fields",
      () => Response.json({ error: "invalid_input" }, { status: 400 }),
      "Some of what you entered is not valid: . Nothing was saved.",
    ],
    [
      "the person is no longer an owner",
      () => Response.json({ error: "not_owner" }, { status: 403 }),
      "You are no longer an owner of this installation, so the key was not saved. Sign out and in again to refresh your access.",
    ],
    [
      "the installation is no longer visible",
      () => Response.json({ error: "not_found" }, { status: 404 }),
      "You are no longer an owner of this installation, so the key was not saved. Sign out and in again to refresh your access.",
    ],
    [
      "the service fails",
      () => Response.json({ error: "internal_error" }, { status: 500 }),
      "The key could not be saved. Try again in a moment.",
    ],
    [
      "the service answers something unreadable",
      () => new Response("<html>", { status: 502 }),
      "The key could not be saved. Try again in a moment.",
    ],
    [
      "a refusal has no status",
      () => Response.json({ error: "key_refused" }, { status: 422 }),
      "The key could not be saved. Try again in a moment.",
    ],
    [
      "a success has the wrong shape",
      () => Response.json({ saved: true }),
      "The key could not be saved. Try again in a moment.",
    ],
  ])("says what happened and what to do when %s", async (_name, answer, message) => {
    open(installations(), answer);
    const article = await block();
    fill(article, { Model: "m", "API key": SECRET });

    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));

    const alert = await within(article).findByRole("alert");
    expect(alert.textContent).toBe(`The key was not saved${message}`);
    // What was typed stays, so the person can correct it; nothing claims to be saved.
    expect(within(article).getByLabelText<HTMLInputElement>("API key").value).toBe(SECRET);
    expect(within(article).queryByRole("status")).toBeNull();
    expect(article.textContent).toContain("No key is set.");
  });

  it("offers to sign in again when the session has ended", async () => {
    open(installations(), () => Response.json({ error: "unauthenticated" }, { status: 401 }));
    const article = await block();
    fill(article, { Model: "m", "API key": SECRET });

    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));

    const alert = await within(article).findByRole("alert");
    expect(alert.textContent).toContain("Your session has ended, so the key was not saved.");
    expect(within(alert).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe(
      "/auth/login",
    );
  });

  it("reports a network failure, and clears the error on the next attempt", async () => {
    let attempts = 0;
    open(installations(), () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError("offline");
      }
      return Response.json(SAVED);
    });
    const article = await block();
    fill(article, { Model: "m", "API key": SECRET });

    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));
    expect((await within(article).findByRole("alert")).textContent).toContain(
      "The key could not be saved.",
    );
    fireEvent.click(within(article).getByRole("button", { name: "Save key" }));

    expect(await within(article).findByRole("status")).toBeDefined();
    expect(within(article).queryByRole("alert")).toBeNull();
  });
});

describe("removing a key", () => {
  const withKey = (answer?: (sent: Sent) => Response): ReturnType<typeof open> =>
    open(installations({ aiKey: SAVED }), answer ?? (() => new Response(null, { status: 204 })));

  it("asks first, and does nothing when the person keeps the key", async () => {
    const { sent } = withKey();
    const article = await block();

    fireEvent.click(within(article).getByRole("button", { name: "Remove key" }));
    expect(article.textContent).toContain("Remove this key?");
    fireEvent.click(within(article).getByRole("button", { name: "Keep key" }));

    expect(sent).toEqual([]);
    expect(article.textContent).not.toContain("Remove this key?");
    expect(article.textContent).toContain("Ends in abcd");
  });

  it("removes it after confirmation, with the header the API demands", async () => {
    const { sent } = withKey();
    const article = await block();

    fireEvent.click(within(article).getByRole("button", { name: "Remove key" }));
    fireEvent.click(within(article).getByRole("button", { name: "Yes, remove key" }));

    expect((await within(article).findByRole("status")).textContent).toBe("Key removed.");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "DELETE", credentials: "same-origin" });
    expect(sent[0]?.headers["x-pr-buddy-request"]).toBe("1");
    expect(article.textContent).toContain("No key is set.");
    expect(within(article).getByRole("button", { name: "Save key" })).toBeDefined();
    expect(within(article).queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it.each<[string, () => Response]>([
    ["the service refuses", () => Response.json({ error: "not_owner" }, { status: 403 })],
    [
      "the network fails",
      () => {
        throw new TypeError("offline");
      },
    ],
  ])("keeps the key and says so when %s", async (_name, answer) => {
    withKey(answer);
    const article = await block();

    fireEvent.click(within(article).getByRole("button", { name: "Remove key" }));
    fireEvent.click(within(article).getByRole("button", { name: "Yes, remove key" }));

    expect((await within(article).findByRole("alert")).textContent).toBe(
      "The key was not removedIt is still stored and still in use. Try again in a moment.",
    );
    expect(article.textContent).toContain("Ends in abcd");
    expect(within(article).getByRole("button", { name: "Remove key" })).toBeDefined();
  });
});

describe("the key client", () => {
  it("encodes the installation into the path", async () => {
    const { requests } = fakeApi({
      "/api/installations/1001/ai-key": () => new Response(null, { status: 204 }),
    });

    await aiKeys.remove(1001);

    expect(requests).toEqual(["DELETE /api/installations/1001/ai-key"]);
  });

  it("lists installations through the checked API", async () => {
    fakeApi({ "/api/installations": installations() });

    expect(await aiKeys.list()).toEqual(installations());
  });
});
