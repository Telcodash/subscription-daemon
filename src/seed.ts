import type { Database } from "bun:sqlite";
import { fakerEN_GB as f } from "@faker-js/faker";
import { STARTER_TARIFFS, type TariffCatalogue } from "./catalogue";
import type { LineBook } from "./lines";
import { newId } from "./util";

/** A live number assignment, as the MSISDN daemon describes it to other daemons. */
export interface AssignmentRef {
  msisdn: string;
  target_type: string;
  target_id: string;
  assigned_at: string;
}

/** Lines started before this date may be on the retired legacy plan. */
const LEGACY_CUTOFF = "2022-01-01";

export function seedCatalogue(catalogue: TariffCatalogue, now: string): void {
  for (const { weight: _weight, ...tariff } of STARTER_TARIFFS) catalogue.create(tariff, now);
}

/**
 * One line per live number assignment, on a random tariff weighted towards the popular plans.
 * Older lines may be on the retired legacy plan. Deterministic for a given seed.
 */
export function seedLines(db: Database, catalogue: TariffCatalogue, book: LineBook, assignments: AssignmentRef[], seedValue: number): number {
  f.seed(seedValue);
  const random = () => f.number.float({ min: 0, max: 0.999999 });
  const byName = new Map(catalogue.list().map((t) => [t.name, t]));
  const choices = STARTER_TARIFFS.map((t) => ({ weight: t.weight, value: byName.get(t.name)! }));
  let started = 0;

  db.transaction(() => {
    for (const a of assignments) {
      if (a.target_type !== "account") continue;

      const startedOn = a.assigned_at.slice(0, 10);
      const eligible = choices.filter((c) => c.value.available || startedOn < LEGACY_CUTOFF);
      const tariff = f.helpers.weightedArrayElement(eligible);

      book.start({
        id: newId("lin", Date.parse(a.assigned_at), random),
        msisdn: a.msisdn,
        accountId: a.target_id,
        tariffId: tariff.id,
        startedOn,
        allowRetired: true,
      });
      started++;
    }
  })();

  return started;
}

export function isEmpty(db: Database): boolean {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tariffs").get()!.n === 0;
}
