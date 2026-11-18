import type { Database } from "bun:sqlite";
import { newId } from "./util";

export interface Allowances {
  /** null = unlimited */
  minutes: number | null;
  texts: number | null;
  data_mb: number | null;
  eu_roaming: boolean;
  international_roaming: boolean;
  five_g_plus: boolean;
}

export interface Tariff extends Allowances {
  id: string;
  name: string;
  description: string | null;
  monthly_price_pence: number;
  available: boolean;
  /** Active lines on this tariff. */
  active_lines: number;
  created_at: string;
  updated_at: string;
}

export type TariffInput = Omit<Tariff, "id" | "active_lines" | "created_at" | "updated_at">;

/** Fields that can't change once a tariff has subscribers (it would reprice/alter their plan). */
export const LOCKED_WHEN_SUBSCRIBED = ["monthly_price_pence", "minutes", "texts", "data_mb", "eu_roaming", "international_roaming", "five_g_plus"] as const;

export class CatalogueError extends Error {}

interface TariffRow extends Omit<Tariff, "eu_roaming" | "international_roaming" | "five_g_plus" | "available"> {
  eu_roaming: number;
  international_roaming: number;
  five_g_plus: number;
  available: number;
}

const toTariff = (row: TariffRow): Tariff => ({
  ...row,
  eu_roaming: row.eu_roaming === 1,
  international_roaming: row.international_roaming === 1,
  five_g_plus: row.five_g_plus === 1,
  available: row.available === 1,
});

const SELECT = `SELECT t.*, (SELECT COUNT(*) FROM lines l WHERE l.tariff_id = t.id AND l.status = 'active') AS active_lines FROM tariffs t`;

/**
 * The tariff catalogue, managed by administrators in Core.
 *
 * Rule: once a tariff has active lines, its price and allowances are frozen. To change a plan,
 * launch a new tariff and retire the old one; existing customers keep what they signed up for.
 */
export class TariffCatalogue {
  constructor(private readonly db: Database) {}

  list(opts: { availableOnly?: boolean } = {}): Tariff[] {
    return this.db
      .query<TariffRow, []>(`${SELECT} ${opts.availableOnly ? "WHERE t.available = 1" : ""} ORDER BY t.available DESC, t.monthly_price_pence, t.name`)
      .all()
      .map(toTariff);
  }

  get(id: string): Tariff | null {
    const row = this.db.query<TariffRow, [string]>(`${SELECT} WHERE t.id = ?`).get(id);
    return row ? toTariff(row) : null;
  }

  create(input: TariffInput, now = new Date().toISOString()): Tariff {
    this.assertUniqueName(input.name);
    const id = newId("trf", Date.parse(now));

    this.db
      .query(
        `INSERT INTO tariffs (id, name, description, monthly_price_pence, minutes, texts, data_mb, eu_roaming,
           international_roaming, five_g_plus, available, created_at, updated_at)
         VALUES ($id, $name, $description, $monthly_price_pence, $minutes, $texts, $data_mb, $eu_roaming,
           $international_roaming, $five_g_plus, $available, $now, $now)`,
      )
      .run({ ...this.toRow(input), id, now });

    return this.get(id)!;
  }

  /** Partial update. Throws CatalogueError if it would change a frozen field of a subscribed tariff. */
  update(id: string, changes: Partial<TariffInput>, now = new Date().toISOString()): Tariff {
    const current = this.get(id);
    if (!current) throw new CatalogueError(`Unknown tariff ${id}`);

    if (current.active_lines > 0) {
      const frozen = LOCKED_WHEN_SUBSCRIBED.filter((field) => field in changes && changes[field] !== current[field]);
      if (frozen.length > 0) {
        throw new CatalogueError(
          `${current.name} has ${current.active_lines} active line(s), so ${frozen.join(", ")} can't change. Create a new tariff and retire this one instead.`,
        );
      }
    }

    if (changes.name !== undefined && changes.name.toLowerCase() !== current.name.toLowerCase()) this.assertUniqueName(changes.name);

    const next = { ...current, ...changes };
    this.db
      .query(
        `UPDATE tariffs SET name = $name, description = $description, monthly_price_pence = $monthly_price_pence,
           minutes = $minutes, texts = $texts, data_mb = $data_mb, eu_roaming = $eu_roaming,
           international_roaming = $international_roaming, five_g_plus = $five_g_plus, available = $available, updated_at = $now
         WHERE id = $id`,
      )
      .run({ ...this.toRow(next), id, now });

    return this.get(id)!;
  }

  private assertUniqueName(name: string): void {
    if (this.db.query("SELECT 1 FROM tariffs WHERE name = ? COLLATE NOCASE").get(name)) {
      throw new CatalogueError(`A tariff called "${name}" already exists`);
    }
  }

  private toRow(t: TariffInput) {
    return {
      name: t.name.trim(),
      description: t.description,
      monthly_price_pence: t.monthly_price_pence,
      minutes: t.minutes,
      texts: t.texts,
      data_mb: t.data_mb,
      eu_roaming: t.eu_roaming ? 1 : 0,
      international_roaming: t.international_roaming ? 1 : 0,
      five_g_plus: t.five_g_plus ? 1 : 0,
      available: t.available ? 1 : 0,
    };
  }
}

/** The launch catalogue: a spread of realistic UK SIM-only plans, plus one retired legacy plan. */
export const STARTER_TARIFFS: (TariffInput & { weight: number })[] = [
  { name: "Classic 1GB", description: "Legacy plan, no longer sold.", monthly_price_pence: 600, minutes: 100, texts: 100, data_mb: 1_024, eu_roaming: false, international_roaming: false, five_g_plus: false, available: false, weight: 4 },
  { name: "Essentials 2GB", description: "Light use: calls, texts and a little data.", monthly_price_pence: 800, minutes: 250, texts: 250, data_mb: 2_048, eu_roaming: false, international_roaming: false, five_g_plus: false, available: true, weight: 10 },
  { name: "Essentials 10GB", description: null, monthly_price_pence: 1_200, minutes: null, texts: null, data_mb: 10_240, eu_roaming: true, international_roaming: false, five_g_plus: false, available: true, weight: 20 },
  { name: "Everyday 30GB", description: null, monthly_price_pence: 1_600, minutes: null, texts: null, data_mb: 30_720, eu_roaming: true, international_roaming: false, five_g_plus: true, available: true, weight: 24 },
  { name: "Plus 100GB", description: null, monthly_price_pence: 2_200, minutes: null, texts: null, data_mb: 102_400, eu_roaming: true, international_roaming: false, five_g_plus: true, available: true, weight: 18 },
  { name: "Unlimited", description: "Unlimited everything in the UK and EU.", monthly_price_pence: 3_000, minutes: null, texts: null, data_mb: null, eu_roaming: true, international_roaming: false, five_g_plus: true, available: true, weight: 16 },
  { name: "Unlimited Max", description: "Unlimited, with roaming in 70+ destinations worldwide.", monthly_price_pence: 4_200, minutes: null, texts: null, data_mb: null, eu_roaming: true, international_roaming: true, five_g_plus: true, available: true, weight: 8 },
];
