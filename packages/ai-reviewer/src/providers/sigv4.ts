import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for one kind of request: a POST or GET with headers and an optional
 * body. It follows AWS's specification step by step and is checked in tests against the values
 * AWS publishes. See docs/DESIGN-AI.md, section 10.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present with temporary credentials. */
  readonly sessionToken?: string;
}

export interface AwsRequest {
  readonly method: string;
  /** The exact URL that will be requested, with its path already percent-encoded once. */
  readonly url: URL;
  /** Headers to send and sign, apart from the ones this function adds. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  /** The AWS service name used for signing, for example "bedrock". */
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

/** Percent-encodes everything except the characters RFC 3986 leaves unreserved. */
function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20150830T123600Z` for a time: the format AWS signs. */
function toAmzDate(time: Date): string {
  return time.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * The path as AWS canonicalises it for every service except S3: each segment of the path that is
 * sent is encoded once more. A model ID's `:` therefore travels as `%3A` and is signed as
 * `%253A`; signing the single-encoded form is the usual cause of a signature mismatch.
 */
function canonicalPath(pathname: string): string {
  return pathname.split("/").map(encodeRfc3986).join("/");
}

function canonicalQuery(parameters: URLSearchParams): string {
  return [...parameters]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a, aValue], [b, bValue]) => (a === b ? compare(aValue, bValue) : compare(a, b)))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function compare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** The key a signature is made with, derived from the secret for one day, region and service. */
export function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

/**
 * Returns the headers to send with a request so that AWS accepts it: the ones given, plus
 * `host`, `x-amz-date`, the session token if there is one, and `authorization`.
 */
export function signAwsRequest(request: AwsRequest): Record<string, string> {
  const { credentials, region, service, url } = request;
  const amzDate = toAmzDate(request.now);
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
    host: url.host,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken === undefined
      ? {}
      : { "x-amz-security-token": credentials.sessionToken }),
  };
  const signedNames = Object.keys(headers).sort(compare);
  const canonicalHeaders = signedNames
    .map((name) => `${name}:${(headers[name] ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedNames.join(";");

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(request.body),
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac(
    "sha256",
    deriveSigningKey(credentials.secretAccessKey, dateStamp, region, service),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
