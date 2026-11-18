import type { Database } from "bun:sqlite";
import type { Allowances, TariffCatalogue } from "./catalogue";
import { newId, type IsoDate } from "./util";

export class LineError extends Error {}

/** A line as shown in Core: number, tariff, the locked-in price and the plan's allowances. */
export interface LineView extends Allowances {
  id: string;
  msisdn: string;
  account_id: string;
  tariff_id: string;
  tariff_name: string;
  /** The price this line pays (locked when it started), which may differ from today's catalogue price. */
  monthly_price_pence: number;
  status: "active" | "ceased";
  started_on: IsoDate;
  ceased_on: IsoDate | null;
}

interface LineRow {
  id: string;
  msisdn: string;
  account_id: string;
  tariff_id: string;
  monthly_price_pence: number;
  status: "active" | "ceased";
  started_on: string;
  ceased_on: string | null;
}

const VIEW_SQL = `
  SELECT l.id, l.msisdn, l.account_id, l.tariff_id, t.name AS tariff_name, l.monthly_price_pence, l.status,
         l.started_on, l.ceased_on, t.minutes, t.texts, t.data_mb, t.eu_roaming, t.international_roaming, t.five_g_plus
  FROM lines l JOIN tariffs t ON t.id = l.tariff_id`;

type ViewRow = Omit<LineView, "eu_roaming" | "international_roaming" | "five_g_plus"> & {
  eu_roaming: number;
  international_roaming: number;
  five_g_plus: number;
};

const toView = (r: ViewRow): LineView => ({
  ...r,
  eu_roaming: r.eu_roaming === 1,
  international_roaming: r.international_roaming === 1,
  five_g_plus: r.five_g_plus === 1,
});

/**
 * Lines (subscriptions). Each change records a domain event in the outbox, in the caller's
 * transaction, carrying the line's billable state for the billing daemon:
 *   line.started { line_id, account_id, msisdn, tariff_id, tariff_name, monthly_price_pence, started_on, allowances }
 *   line.ceased  { line_id, account_id, msisdn, ceased_on }
 * A line's allowances can't change while it's active (its tariff is frozen), so they travel with the start.
 */
export class LineBook {
  constructor(
    private readonly db: Database,
    private readonly catalogue: TariffCatalogue,
  ) {}

  start(input: { msisdn: string; accountId: string; tariffId: string; startedOn: IsoDate; allowRetired?: boolean; id?: string }): LineView {
    const tariff = this.catalogue.get(input.tariffId);
    if (!tariff) throw new LineError(`Unknown tariff ${input.tariffId}`);
    if (!tariff.available && !input.allowRetired) throw new LineError(`${tariff.name} is retired and can't be sold`);

    if (this.db.query("SELECT 1 FROM lines WHERE msisdn = ? AND status = 'active'").get(input.msisdn)) {
      throw new LineError(`${input.msisdn} already has an active line`);
    }

    const id = input.id ?? newId("lin", Date.parse(`${input.startedOn}T00:00:00Z`));
    const ts = `${input.startedOn}T00:00:00.000Z`;

    this.db
      .query(
        `INSERT INTO lines (id, msisdn, account_id, tariff_id, monthly_price_pence, status, started_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, input.msisdn, input.accountId, tariff.id, tariff.monthly_price_pence, input.startedOn, ts, ts);

    this.emit("line.started", ts, {
      line_id: id,
      account_id: input.accountId,
      msisdn: input.msisdn,
      tariff_id: tariff.id,
      tariff_name: tariff.name,
      monthly_price_pence: tariff.monthly_price_pence,
      started_on: input.startedOn,
      allowances: {
        minutes: tariff.minutes,
        texts: tariff.texts,
        data_mb: tariff.data_mb,
        eu_roaming: tariff.eu_roaming,
        international_roaming: tariff.international_roaming,
        five_g_plus: tariff.five_g_plus,
      },
    });

    return this.get(id)!;
  }

  /** End a line. Idempotent: ceasing a ceased line changes nothing. */
  cease(id: string, ceasedOn: IsoDate): boolean {
    const line = this.db.query<LineRow, [string]>("SELECT * FROM lines WHERE id = ?").get(id);
    if (!line) throw new LineError(`Unknown line ${id}`);
    if (line.status === "ceased") return false;

    const ts = `${ceasedOn}T00:00:00.000Z`;
    this.db.query("UPDATE lines SET status = 'ceased', ceased_on = ?, updated_at = ? WHERE id = ?").run(ceasedOn, ts, id);
    this.emit("line.ceased", ts, { line_id: id, account_id: line.account_id, msisdn: line.msisdn, ceased_on: ceasedOn });

    return true;
  }

  get(id: string): LineView | null {
    const row = this.db.query<ViewRow, [string]>(`${VIEW_SQL} WHERE l.id = ?`).get(id);
    return row ? toView(row) : null;
  }

  /** How many lines are active. */
  activeCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lines WHERE status = 'active'").get()!.n;
  }

  /** Active lines per account, keyed by account id (accounts with none map to []). */
  forAccounts(accountIds: string[]): Record<string, LineView[]> {
    const result: Record<string, LineView[]> = Object.fromEntries(accountIds.map((id) => [id, []]));
    if (accountIds.length === 0) return result;

    const rows = this.db
      .query<ViewRow, string[]>(
        `${VIEW_SQL} WHERE l.status = 'active' AND l.account_id IN (${accountIds.map(() => "?").join(",")}) ORDER BY l.started_on, l.id`,
      )
      .all(...accountIds);

    for (const row of rows) result[row.account_id]?.push(toView(row));

    return result;
  }

  private emit(type: string, occurredAt: string, data: Record<string, unknown>): void {
    this.db.query("INSERT INTO outbox (type, data, occurred_at) VALUES (?, ?, ?)").run(type, JSON.stringify(data), occurredAt);
  }
}
