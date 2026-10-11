import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReadRecord, type ReadRecord } from "../../src/tools/read-record.js";
import {
  createOutputBudget,
  type OutputBudget,
  type ToolContext,
} from "../../src/tools/tool-context.js";

export const CHECKOUT_HEAD_SHA = "b".repeat(40);

export interface TempCheckout {
  /** The folder, with links resolved, as `openCheckout` reports it. */
  readonly root: string;
  readonly record: ReadRecord;
  readonly budget: OutputBudget;
  readonly context: ToolContext;
  /** Writes a file, creating its folders. */
  readonly write: (path: string, content: string | Uint8Array) => Promise<void>;
}

const created: string[] = [];

/**
 * A real folder that looks like a checkout at `CHECKOUT_HEAD_SHA`. The tools are tested
 * against a real file system because their job is to refuse what a real one allows.
 */
export async function createTempCheckout(
  files: Readonly<Record<string, string | Uint8Array>> = {},
  budgetLimit?: number,
): Promise<TempCheckout> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pr-buddy-checkout-")));
  created.push(root);
  const write = async (path: string, content: string | Uint8Array): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write(".git/HEAD", `${CHECKOUT_HEAD_SHA}\n`);
  await write(".git/config", "GIT-CONFIG-CANARY\n");
  for (const [path, content] of Object.entries(files)) {
    await write(path, content);
  }
  const record = createReadRecord();
  const budget = createOutputBudget(budgetLimit);
  return { root, record, budget, context: { checkout: { root }, record, budget }, write };
}

/** Removes every folder made by `createTempCheckout`. Call it in `afterEach`. */
export async function removeTempCheckouts(): Promise<void> {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}
