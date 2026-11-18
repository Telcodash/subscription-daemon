import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { CatalogueError, type TariffCatalogue } from "./catalogue";
import type { LineBook } from "./lines";
import { idPattern } from "./util";

const accountId = z.string().regex(idPattern("acc"));
const tariffId = z.string().regex(idPattern("trf"));

/** Allowances: a non-negative whole number, or null for unlimited. */
const allowance = (max: number) => z.number().int().min(0).max(max).nullable();

const TariffFields = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(200).nullable().default(null),
    monthly_price_pence: z.number().int().min(0).max(100_000),
    minutes: allowance(100_000),
    texts: allowance(100_000),
    data_mb: allowance(10_000_000),
    eu_roaming: z.boolean(),
    international_roaming: z.boolean(),
    five_g_plus: z.boolean(),
    available: z.boolean().default(true),
  })
  .strict();

const CreateSchema = TariffFields;
const UpdateSchema = z.object({ id: tariffId, changes: TariffFields.partial().strict() }).strict();
const ListSchema = z.object({ available_only: z.boolean().default(false) }).strict();
const ForAccountsSchema = z.object({ account_ids: z.array(accountId).max(100) }).strict();

/** Invalid input will never succeed on retry, so fail it permanently. */
function parse<T>(schema: z.ZodType<T, unknown>, payload: unknown): T {
  const result = schema.safeParse(payload);

  if (!result.success) {
    throw new UnrecoverableError(`Invalid payload: ${z.prettifyError(result.error).replace(/\n/g, "; ")}`);
  }

  return result.data;
}

/** Business-rule violations are permanent too, and their message is meant for the admin. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CatalogueError) throw new UnrecoverableError(error.message);
    throw error;
  }
}

export type TaskHandler = (payload: unknown) => unknown;

/**
 * Tasks on the `subscriptions` queue (all allow-listed in ../queue/src/catalog.ts):
 *
 * - tariffs.list       { available_only? }  → Tariff[] with active line counts
 * - tariffs.create     TariffFields         → Tariff
 * - tariffs.update     { id, changes }      → Tariff (price/allowances frozen while it has active lines)
 * - lines.for_accounts { account_ids }      → { [account_id]: LineView[] } active lines with tariff and allowances
 * - lines.count        {}                   → { active } (internal: billing waits for every line before backfilling)
 */
export function createTasks(catalogue: TariffCatalogue, book: LineBook): Record<string, TaskHandler> {
  return {
    "tariffs.list": (payload) => catalogue.list({ availableOnly: parse(ListSchema, payload).available_only }),
    "tariffs.create": (payload) => rule(() => catalogue.create(parse(CreateSchema, payload))),
    "tariffs.update": (payload) => {
      const { id, changes } = parse(UpdateSchema, payload);
      return rule(() => catalogue.update(id, changes));
    },
    "lines.for_accounts": (payload) => book.forAccounts(parse(ForAccountsSchema, payload).account_ids),
    "lines.count": (payload) => {
      parse(z.object({}).strict(), payload);
      return { active: book.activeCount() };
    },
  };
}
