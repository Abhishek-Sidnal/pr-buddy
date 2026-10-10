import { z } from "zod";

const positiveIdSchema = z.number().int().positive();

const installationEventSchema = z.object({
  action: z.string().max(100),
  installation: z.object({ id: positiveIdSchema }),
});

const repositoriesEventSchema = installationEventSchema.extend({
  repositories_removed: z.array(z.object({ id: positiveIdSchema })).max(10_000),
});

/** A change to where the app is installed that PR Buddy must act on. */
export type InstallationChange =
  /** The app was uninstalled: nobody can reach that installation's data any more. */
  | { readonly kind: "removed"; readonly installationId: number }
  /** The installation was suspended: access must stop, the data may come back into use. */
  | { readonly kind: "suspended"; readonly installationId: number }
  /** Repositories were taken out of the installation. */
  | {
      readonly kind: "repositories-removed";
      readonly installationId: number;
      readonly repositoryIds: readonly number[];
    }
  | { readonly kind: "ignored" };

/**
 * Interprets the JSON body of an `installation` or `installation_repositories` webhook. Only
 * IDs are read. Never throws; anything unexpected is ignored.
 */
export function parseInstallationEvent(event: string, payload: unknown): InstallationChange {
  if (event === "installation") {
    const parsed = installationEventSchema.safeParse(payload);
    if (!parsed.success) {
      return { kind: "ignored" };
    }
    const installationId = parsed.data.installation.id;
    if (parsed.data.action === "deleted") {
      return { kind: "removed", installationId };
    }
    return parsed.data.action === "suspend"
      ? { kind: "suspended", installationId }
      : { kind: "ignored" };
  }

  if (event === "installation_repositories") {
    const parsed = repositoriesEventSchema.safeParse(payload);
    if (!parsed.success || parsed.data.action !== "removed") {
      return { kind: "ignored" };
    }
    const repositoryIds = parsed.data.repositories_removed.map((repository) => repository.id);
    return repositoryIds.length === 0
      ? { kind: "ignored" }
      : {
          kind: "repositories-removed",
          installationId: parsed.data.installation.id,
          repositoryIds,
        };
  }

  return { kind: "ignored" };
}
