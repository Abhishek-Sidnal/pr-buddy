import { useId, useState, type ReactNode } from "react";
import { aiKeys, SIGN_IN_PATH, type SaveAiKeyResult } from "../api/client.js";
import {
  CUSTOMER_PROVIDERS,
  type AiKeySummary,
  type CustomerProvider,
  type Installation,
} from "../api/schemas.js";
import { ErrorState, LoadingState, Notice, Timestamp } from "../components/common.js";
import { useResource } from "../use-resource.js";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  bedrock: "AWS Bedrock",
};

const MODEL_HINTS: Readonly<Record<CustomerProvider, string>> = {
  anthropic: "The model's name as Anthropic lists it.",
  openai: "The model's name as OpenAI lists it.",
  bedrock: "A model ID or inference profile ID that your account may use in the region.",
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  provider: "provider",
  model: "model",
  region: "region",
  apiKey: "key",
};

/** What to tell the person when a key was not saved. Each says what to do next. */
function describeFailure(result: Exclude<SaveAiKeyResult, { ok: true }>): string {
  switch (result.reason) {
    case "refused":
      return result.providerStatus === 404
        ? "The provider does not know this model, or the key may not use it (HTTP 404). Nothing was saved. Check the model name."
        : `The provider refused the key (HTTP ${result.providerStatus}). Nothing was saved. Check the key, and that it may use this model.`;
    case "unreachable":
      return "The provider could not be reached to check the key. Nothing was saved. Try again in a moment.";
    case "invalid": {
      const fields = result.fields.map((field) => FIELD_LABELS[field] ?? "form").join(", ");
      return `Some of what you entered is not valid: ${fields}. Nothing was saved.`;
    }
    case "forbidden":
      return "You are no longer an owner of this installation, so the key was not saved. Sign out and in again to refresh your access.";
    case "unauthenticated":
      return "Your session has ended, so the key was not saved.";
    case "failed":
      return "The key could not be saved. Try again in a moment.";
  }
}

function KeySummary(props: { readonly aiKey: AiKeySummary | null }): ReactNode {
  const { aiKey } = props;
  if (aiKey === null) {
    return (
      <p className="hint">
        No key is set. Reviews use the service&apos;s own AI provider, if it has one.
      </p>
    );
  }
  return (
    <dl className="facts">
      <div>
        <dt>Provider</dt>
        <dd>{PROVIDER_LABELS[aiKey.provider] ?? aiKey.provider}</dd>
      </div>
      <div>
        <dt>Model</dt>
        <dd>
          <code>{aiKey.model}</code>
        </dd>
      </div>
      {aiKey.region === null ? null : (
        <div>
          <dt>Region</dt>
          <dd>
            <code>{aiKey.region}</code>
          </dd>
        </div>
      )}
      <div>
        <dt>Key</dt>
        <dd>
          Ends in <code>{aiKey.keyHint}</code>. Saved <Timestamp iso={aiKey.updatedAt} />
        </dd>
      </div>
    </dl>
  );
}

type Activity = "idle" | "saving" | "removing";

/** The form an owner uses to store, replace or remove one installation's key. */
function KeyForm(props: {
  readonly installation: Installation;
  readonly onChanged: (aiKey: AiKeySummary | null) => void;
}): ReactNode {
  const { installation } = props;
  const fieldId = useId();
  const [provider, setProvider] = useState<CustomerProvider>("anthropic");
  const [model, setModel] = useState("");
  const [region, setRegion] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [activity, setActivity] = useState<Activity>("idle");
  const [failure, setFailure] = useState<Exclude<SaveAiKeyResult, { ok: true }>>();
  const [message, setMessage] = useState<string>();
  const [isConfirmingRemoval, setIsConfirmingRemoval] = useState(false);
  const [hasRemovalFailed, setHasRemovalFailed] = useState(false);
  const isBusy = activity !== "idle";

  async function save(event: { preventDefault: () => void }): Promise<void> {
    event.preventDefault();
    setActivity("saving");
    setFailure(undefined);
    setHasRemovalFailed(false);
    setMessage(undefined);
    const result = await aiKeys.save(installation.id, {
      provider,
      model: model.trim(),
      apiKey: apiKey.trim(),
      ...(provider === "bedrock" ? { region: region.trim() } : {}),
    });
    setActivity("idle");
    if (result.ok) {
      // The key is cleared from the page as soon as the server has it.
      setApiKey("");
      setMessage("Key saved. The provider accepted it.");
      props.onChanged(result.key);
    } else {
      setFailure(result);
    }
  }

  async function remove(): Promise<void> {
    setActivity("removing");
    setFailure(undefined);
    setHasRemovalFailed(false);
    setMessage(undefined);
    const removed = await aiKeys.remove(installation.id);
    setActivity("idle");
    setIsConfirmingRemoval(false);
    if (removed) {
      setMessage("Key removed.");
      props.onChanged(null);
    } else {
      setHasRemovalFailed(true);
    }
  }

  return (
    <form className="key-form" onSubmit={(event) => void save(event)}>
      <div className="form-field">
        <label htmlFor={`${fieldId}-provider`}>Provider</label>
        <select
          id={`${fieldId}-provider`}
          value={provider}
          disabled={isBusy}
          onChange={(event) => {
            setProvider(event.target.value as CustomerProvider);
          }}
        >
          {CUSTOMER_PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {PROVIDER_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label htmlFor={`${fieldId}-model`}>Model</label>
        <input
          id={`${fieldId}-model`}
          type="text"
          required
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          value={model}
          disabled={isBusy}
          aria-describedby={`${fieldId}-model-hint`}
          onChange={(event) => {
            setModel(event.target.value);
          }}
        />
        <p id={`${fieldId}-model-hint`} className="hint">
          {MODEL_HINTS[provider]}
        </p>
      </div>

      {provider === "bedrock" ? (
        <div className="form-field">
          <label htmlFor={`${fieldId}-region`}>Region</label>
          <input
            id={`${fieldId}-region`}
            type="text"
            required
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            placeholder="us-east-1"
            value={region}
            disabled={isBusy}
            onChange={(event) => {
              setRegion(event.target.value);
            }}
          />
        </div>
      ) : null}

      <div className="form-field">
        <label htmlFor={`${fieldId}-key`}>API key</label>
        <input
          id={`${fieldId}-key`}
          type="password"
          required
          minLength={8}
          maxLength={4096}
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          disabled={isBusy}
          aria-describedby={`${fieldId}-key-hint`}
          onChange={(event) => {
            setApiKey(event.target.value);
          }}
        />
        <p id={`${fieldId}-key-hint`} className="hint">
          Use a key made for PR Buddy alone, with a spending limit. It is checked with the provider,
          stored encrypted, and never shown again.
        </p>
      </div>

      {failure === undefined ? null : (
        <Notice tone="danger" title="The key was not saved" isAlert>
          <p>{describeFailure(failure)}</p>
          {failure.reason === "unauthenticated" ? (
            <a className="button button-secondary" href={SIGN_IN_PATH}>
              Sign in again
            </a>
          ) : null}
        </Notice>
      )}
      {hasRemovalFailed ? (
        <Notice tone="danger" title="The key was not removed" isAlert>
          <p>It is still stored and still in use. Try again in a moment.</p>
        </Notice>
      ) : null}
      {message === undefined ? null : (
        <p className="form-message" role="status">
          {message}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={isBusy}>
          {activity === "saving"
            ? "Checking and saving…"
            : installation.aiKey === null
              ? "Save key"
              : "Replace key"}
        </button>
        {installation.aiKey === null ? null : isConfirmingRemoval ? (
          <>
            <span>Remove this key? AI review for this installation will stop using it.</span>
            <button
              type="button"
              className="button button-secondary"
              disabled={isBusy}
              onClick={() => void remove()}
            >
              {activity === "removing" ? "Removing…" : "Yes, remove key"}
            </button>
            <button
              type="button"
              className="button button-quiet"
              disabled={isBusy}
              onClick={() => {
                setIsConfirmingRemoval(false);
              }}
            >
              Keep key
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button button-secondary"
            disabled={isBusy}
            onClick={() => {
              setIsConfirmingRemoval(true);
            }}
          >
            Remove key
          </button>
        )}
      </div>
    </form>
  );
}

function InstallationKey(props: { readonly installation: Installation }): ReactNode {
  // The server's answer after a save or removal replaces what was loaded with the page.
  const [aiKey, setAiKey] = useState(props.installation.aiKey);
  const installation = { ...props.installation, aiKey };
  return (
    <article className="installation-key" aria-label={`AI key of ${installation.account}`}>
      <h3>
        {installation.account === "" ? `Installation ${installation.id}` : installation.account}
      </h3>
      <KeySummary aiKey={aiKey} />
      {installation.canManage ? (
        <KeyForm installation={installation} onChanged={setAiKey} />
      ) : (
        <p className="hint">
          Only an owner of this account can set or change its key. If you are one, sign out and in
          again: your role is read from GitHub when you sign in.
        </p>
      )}
    </article>
  );
}

/**
 * The settings section where an installation's owner supplies their own AI provider and key.
 * It renders nothing when the service does not offer the feature.
 */
export function AiKeySettings(): ReactNode {
  const { resource, reload } = useResource((signal) => aiKeys.list(signal), "installations");

  // The service answers "not found" when it has no master key to encrypt with.
  if (resource.status === "error" && resource.error.kind === "not-found") {
    return null;
  }
  return (
    <section aria-labelledby="ai-keys-heading" className="settings-section">
      <h2 id="ai-keys-heading">AI review key</h2>
      <p>
        An installation can use its own AI provider. Reviews of its repositories then go to that
        provider, on that key, in place of the service&apos;s. A repository must still opt in with{" "}
        <code>
          &quot;ai&quot;: {"{"} &quot;enabled&quot;: true {"}"}
        </code>{" "}
        in its <code>.github/pr-buddy.json</code>.
      </p>
      {resource.status === "loading" ? <LoadingState label="Loading installations…" /> : null}
      {resource.status === "error" ? <ErrorState error={resource.error} onRetry={reload} /> : null}
      {resource.status === "ready" ? (
        resource.data.installations.length === 0 ? (
          <p className="hint">GitHub lists no installation of PR Buddy for you.</p>
        ) : (
          resource.data.installations.map((installation) => (
            <InstallationKey key={installation.id} installation={installation} />
          ))
        )
      ) : null}
    </section>
  );
}
