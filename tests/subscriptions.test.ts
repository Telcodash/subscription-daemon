import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { UnrecoverableError } from "bullmq";
import { CatalogueError, STARTER_TARIFFS, TariffCatalogue, type Tariff } from "../src/catalogue";
import { MIGRATIONS, openDatabase } from "../src/db";
import { LineBook, LineError, type LineView } from "../src/lines";
import { seedCatalogue, seedLines, type AssignmentRef } from "../src/seed";
import { createTasks } from "../src/tasks";
import { newId, seededRandom } from "../src/util";

const acc = (i: number) => newId("lin", Date.parse("2019-01-01") + i * 864e5, seededRandom(`a${i}`)).replace("lin_", "acc_");

const assignments: AssignmentRef[] = Array.from({ length: 1_500 }, (_, i) => ({
  msisdn: `4477009${String(10_000 + i).padStart(5, "0")}`,
  target_type: "account",
  target_id: acc(Math.floor(i / 2)),
  assigned_at: new Date(Date.parse("2018-06-01") + i * 2 * 864e5).toISOString(),
}));

function setup() {
  const db = openDatabase(":memory:");
  const catalogue = new TariffCatalogue(db);
  const book = new LineBook(db, catalogue);
  seedCatalogue(catalogue, "2018-01-01T00:00:00.000Z");
  return { db, catalogue, book, tasks: createTasks(catalogue, book) };
}

let db: Database;
let catalogue: TariffCatalogue;
let book: LineBook;
let tasks: ReturnType<typeof createTasks>;

beforeAll(() => {
  ({ db, catalogue, book, tasks } = setup());
  seedLines(db, catalogue, book, assignments, 5);
});

const byName = (name: string) => catalogue.list().find((t) => t.name === name)!;

describe("catalogue", () => {
  test("starts with the starter tariffs, one of them retired", () => {
    const tariffs = catalogue.list();

    expect(tariffs).toHaveLength(STARTER_TARIFFS.length);
    expect(tariffs.filter((t) => !t.available).map((t) => t.name)).toEqual(["Classic 1GB"]);
    expect(catalogue.list({ availableOnly: true })).toHaveLength(STARTER_TARIFFS.length - 1);
    expect(byName("Unlimited Max")).toMatchObject({ minutes: null, data_mb: null, international_roaming: true, five_g_plus: true });
  });

  test("a subscribed tariff's price and allowances are frozen, but it can be renamed or retired", () => {
    const essentials = byName("Essentials 10GB");
    expect(essentials.active_lines).toBeGreaterThan(0);

    expect(() => catalogue.update(essentials.id, { monthly_price_pence: 999 })).toThrow(CatalogueError);
    expect(() => catalogue.update(essentials.id, { data_mb: 20_480 })).toThrow(/Create a new tariff/);
    // Re-sending the same values is not a change.
    expect(catalogue.update(essentials.id, { monthly_price_pence: essentials.monthly_price_pence }).monthly_price_pence).toBe(1_200);

    const renamed = catalogue.update(essentials.id, { name: "Essentials 10GB (2018)", available: false });
    expect(renamed).toMatchObject({ name: "Essentials 10GB (2018)", available: false, monthly_price_pence: 1_200 });
    catalogue.update(essentials.id, { name: "Essentials 10GB", available: true });
  });

  test("an unsubscribed tariff is fully editable; names are unique", () => {
    const { catalogue: c } = setup();
    const fresh = c.create({
      name: "Student 50GB", description: null, monthly_price_pence: 1_400, minutes: null, texts: null, data_mb: 51_200,
      eu_roaming: true, international_roaming: false, five_g_plus: false, available: true,
    });

    expect(c.update(fresh.id, { monthly_price_pence: 1_300, five_g_plus: true })).toMatchObject({ monthly_price_pence: 1_300, five_g_plus: true });
    expect(() => c.create({ ...fresh, name: "student 50gb" })).toThrow(/already exists/);
  });
});

describe("seeded lines", () => {
  const all = () => db.query<{ msisdn: string; tariff_id: string; monthly_price_pence: number; started_on: string }, []>("SELECT * FROM lines").all();

  test("one line per number, at the tariff's price, started when the number was assigned", () => {
    const lines = all();
    const tariffs = new Map(catalogue.list().map((t) => [t.id, t]));

    expect(lines).toHaveLength(assignments.length);
    for (const line of lines) {
      const a = assignments.find((x) => x.msisdn === line.msisdn)!;
      expect(line.started_on).toBe(a.assigned_at.slice(0, 10));
      expect(line.monthly_price_pence).toBe(tariffs.get(line.tariff_id)!.monthly_price_pence);
    }
  });

  test("only lines from before 2022 are on the retired legacy plan, and the popular plans dominate", () => {
    const legacy = byName("Classic 1GB").id;
    const lines = all();

    expect(lines.filter((l) => l.tariff_id === legacy).every((l) => l.started_on < "2022-01-01")).toBe(true);
    expect(lines.some((l) => l.tariff_id === legacy)).toBe(true);
    const counts = Map.groupBy(lines, (l) => l.tariff_id);
    expect(counts.get(byName("Everyday 30GB").id)!.length).toBeGreaterThan(counts.get(byName("Unlimited Max").id)!.length);
  });

  test("every line emitted a line.started event carrying its billable state", () => {
    const events = db.query<{ data: string }, []>("SELECT data FROM outbox WHERE type = 'line.started'").all().map((e) => JSON.parse(e.data));

    expect(events).toHaveLength(assignments.length);
    expect(events[0]).toEqual({
      line_id: expect.stringMatching(/^lin_/),
      account_id: expect.stringMatching(/^acc_/),
      msisdn: expect.any(String),
      tariff_id: expect.stringMatching(/^trf_/),
      tariff_name: expect.any(String),
      monthly_price_pence: expect.any(Number),
      started_on: expect.any(String),
      allowances: expect.any(Object),
    });

    // The allowances are the tariff's.
    for (const event of events.slice(0, 50)) {
      const { minutes, texts, data_mb, eu_roaming, international_roaming, five_g_plus } = catalogue.get(event.tariff_id)!;
      expect(event.allowances).toEqual({ minutes, texts, data_mb, eu_roaming, international_roaming, five_g_plus });
    }
  });

  test("upgrading the schema restates every existing line, with its allowances", () => {
    const d = new Database(":memory:", { strict: true });
    d.run(MIGRATIONS[0]!);
    d.run("PRAGMA user_version = 1");
    const c = new TariffCatalogue(d);
    seedCatalogue(c, "2018-01-01T00:00:00.000Z");
    const b = new LineBook(d, c);
    const unlimited = c.list().find((t) => t.name === "Unlimited")!;
    const line = b.start({ msisdn: "447700910001", accountId: acc(1), tariffId: unlimited.id, startedOn: "2025-01-01" });
    b.cease(b.start({ msisdn: "447700910002", accountId: acc(1), tariffId: unlimited.id, startedOn: "2025-01-01" }).id, "2025-06-01");

    d.run(MIGRATIONS[1]!);
    const restated = d.query<{ data: string }, []>("SELECT data FROM outbox WHERE type = 'line.restated' ORDER BY id").all().map((e) => JSON.parse(e.data));

    expect(restated).toHaveLength(2);
    expect(restated.find((r) => r.line_id === line.id)).toEqual({
      line_id: line.id,
      account_id: acc(1),
      msisdn: "447700910001",
      tariff_id: unlimited.id,
      tariff_name: "Unlimited",
      monthly_price_pence: 3_000,
      started_on: "2025-01-01",
      ceased_on: null,
      allowances: { minutes: null, texts: null, data_mb: null, eu_roaming: true, international_roaming: false, five_g_plus: true },
    });
    expect(restated.find((r) => r.line_id !== line.id).ceased_on).toBe("2025-06-01");
  });

  test("is deterministic", () => {
    const other = setup();
    seedLines(other.db, other.catalogue, other.book, assignments, 5);
    const snapshot = (d: Database) => d.query("SELECT l.id, l.msisdn, t.name FROM lines l JOIN tariffs t ON t.id = l.tariff_id ORDER BY l.id").all();

    expect(snapshot(other.db)).toEqual(snapshot(db));
  });
});

describe("lines", () => {
  test("retired tariffs can't be sold; a number has one live line; ceasing is idempotent and emits once", () => {
    const { db: d, catalogue: c, book: b } = setup();
    const classic = c.list().find((t) => t.name === "Classic 1GB")!;
    const unlimited = c.list().find((t) => t.name === "Unlimited")!;
    const start = { msisdn: "447700910001", accountId: acc(1), startedOn: "2026-01-01" };

    expect(() => b.start({ ...start, tariffId: classic.id })).toThrow(LineError);
    const line = b.start({ ...start, tariffId: unlimited.id });
    expect(() => b.start({ ...start, tariffId: unlimited.id })).toThrow(/already has an active line/);

    expect(b.cease(line.id, "2026-03-01")).toBe(true);
    expect(b.cease(line.id, "2026-03-02")).toBe(false);
    b.start({ ...start, tariffId: unlimited.id, startedOn: "2026-04-01" }); // the number can start a new line

    const types = d.query<{ type: string }, []>("SELECT type FROM outbox ORDER BY id").all().map((e) => e.type);
    expect(types).toEqual(["line.started", "line.ceased", "line.started"]);
  });

  test("a line keeps its locked price when the catalogue moves on", () => {
    const { catalogue: c, book: b } = setup();
    const plan = c.create({
      name: "Promo 20GB", description: null, monthly_price_pence: 900, minutes: null, texts: null, data_mb: 20_480,
      eu_roaming: true, international_roaming: false, five_g_plus: false, available: true,
    });
    const line = b.start({ msisdn: "447700910002", accountId: acc(2), tariffId: plan.id, startedOn: "2026-01-01" });

    c.update(plan.id, { name: "Promo 20GB (ended)", available: false });
    expect(b.get(line.id)).toMatchObject({ monthly_price_pence: 900, tariff_name: "Promo 20GB (ended)", status: "active" });
  });
});

describe("tasks", () => {
  test("lines.for_accounts returns active lines with tariff and allowances", () => {
    const account = assignments[0]!.target_id;
    const result = tasks["lines.for_accounts"]!({ account_ids: [account, acc(99_999)] }) as Record<string, LineView[]>;

    expect(result[account]!.length).toBe(2);
    expect(result[account]![0]).toMatchObject({ tariff_name: expect.any(String), eu_roaming: expect.any(Boolean), five_g_plus: expect.any(Boolean) });
    expect(result[acc(99_999)]).toEqual([]);
  });

  test("tariffs.create/update validate input and surface rule violations as permanent failures", () => {
    const { tasks: t, catalogue: c, book: b } = setup();
    const valid = {
      name: "Family 40GB", monthly_price_pence: 1_900, minutes: null, texts: null, data_mb: 40_960,
      eu_roaming: true, international_roaming: false, five_g_plus: true,
    };

    const created = t["tariffs.create"]!(valid) as Tariff;
    expect(created).toMatchObject({ ...valid, available: true, description: null, active_lines: 0 });

    expect(() => t["tariffs.create"]!({ ...valid, name: "x" })).toThrow(UnrecoverableError);
    expect(() => t["tariffs.create"]!({ ...valid, monthly_price_pence: -1 })).toThrow(UnrecoverableError);
    expect(() => t["tariffs.create"]!({ ...valid, data_mb: 1.5 })).toThrow(UnrecoverableError);
    expect(() => t["tariffs.create"]!(valid)).toThrow(/already exists/);

    const subscribed = c.list().find((x) => x.name === "Unlimited")!;
    b.start({ msisdn: "447700910003", accountId: acc(3), tariffId: subscribed.id, startedOn: "2026-01-01" });
    expect(() => t["tariffs.update"]!({ id: subscribed.id, changes: { monthly_price_pence: 2_500 } })).toThrow(UnrecoverableError);
    expect((t["tariffs.update"]!({ id: subscribed.id, changes: { description: "Our best seller" } }) as Tariff).description).toBe("Our best seller");
  });

  test("lines.count reports active lines (internal)", () => {
    expect(tasks["lines.count"]!({})).toEqual({ active: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lines WHERE status = 'active'").get()!.n });
    expect(() => tasks["lines.count"]!({ extra: 1 })).toThrow(UnrecoverableError);
  });
});
