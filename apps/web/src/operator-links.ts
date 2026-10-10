/**
 * Links built from what an operator configured. The service checks these values when it starts;
 * they are checked again here, because a link is only ever made from a value this code has
 * looked at. Anything else is shown as plain text or not at all.
 */

const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MAX_LINK_LENGTH = 500;

/** The address itself if it is a plain `https://` address without credentials, else nothing. */
export function httpsUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.length > MAX_LINK_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" && url.username === "" && url.password === ""
    ? url.href
    : undefined;
}

/** A link for the operator's contact: `mailto:` for an email address, or an `https://` address. */
export function contactHref(contact: string | null | undefined): string | undefined {
  if (typeof contact !== "string") {
    return undefined;
  }
  return EMAIL_ADDRESS.test(contact) ? `mailto:${contact}` : httpsUrl(contact);
}
