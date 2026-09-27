import { z } from "zod";
const id = z
  .string()
  .min(1)
  .refine(
    (v) => v.trim() === v && v.trim().length > 0,
    "Identifier must be nonblank without surrounding whitespace",
  );
const display = z.string().trim().min(1);
const payload = z
  .object({
    title: display,
    company: display,
    location: display,
    experienceMin: z.number().int().min(0).max(50),
    experienceMax: z.number().int().min(0).max(50),
    applyUrl: z
      .string()
      .url()
      .refine((v) => new URL(v).protocol === "https:", "HTTPS required"),
    skills: z
      .array(display)
      .transform((v) => [...new Set(v.map((s) => s.toLowerCase()))]),
  })
  .strict()
  .refine(
    (v) => v.experienceMin <= v.experienceMax,
    "Invalid experience range",
  );
const base = {
  tenantId: id,
  sourceId: id,
  eventId: id,
  externalJobId: id,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const eventSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("upsert"), payload }).strict(),
  z.object({ ...base, operation: z.literal("archive") }).strict(),
]);
export type JobEvent = z.infer<typeof eventSchema>;
export const scopeSchema = z.object({ tenantId: id, sourceId: id.optional() });
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
