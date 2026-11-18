# subscription-daemon

The Subscription Daemon (Bun + TypeScript + `bun:sqlite`). It owns the **tariff catalogue** and **lines**: a line is a number (MSISDN) on a tariff, billed to an account. It consumes the `subscriptions` queue and publishes line events that the billing daemon charges from.

```
Core (admin: Tariffs page; customer page) ──▶ gateway ──▶ queue "subscriptions" ──▶ subscription-daemon ──▶ SQLite
subscription-daemon ──outbox──▶ stream "events:subscriptions" ──▶ billing-daemon (bills one item per line)
subscription-daemon ──numbers.assignments (seeding only)──▶ msisdn-daemon
```

## Running

```bash
cp .env.example .env
bun install
bun run dev    # first boot: starter catalogue, then one line per live number (waits for the MSISDN daemon)
bun test
```

## Tariffs

A tariff has:
- a name and description;
- a monthly price, in pence;
- allowances: **minutes**, **texts** and **data** (in MB). `null` means unlimited.
- included features, each on or off: **EU roaming**, **international roaming** and **5G+**;
- an `available` flag, which is false once the tariff is retired.

Administrators manage the catalogue in Core under **Admin → Tariffs**. The daemon enforces one rule:

> Once a tariff has active lines, its **price and allowances are frozen**. To change a plan, launch a new tariff and retire the old one. A retired tariff can't be sold, but the lines already on it keep it.

**Price lock:** each line also stores the price it started at, so no change to the catalogue can ever reprice an existing customer.

The starter catalogue has 7 tariffs:
- £8 Essentials 2GB
- £12 Essentials 10GB
- £16 Everyday 30GB
- £22 Plus 100GB
- £30 Unlimited
- £42 Unlimited Max
- £6 Classic 1GB: a retired legacy plan that only lines started before 2022 can be on.

**Seeding:** each live number is given a weighted random tariff.

## Lines and events

- **One live line per number:** enforced by a partial unique index. `msisdn` refers to the MSISDN daemon, and `account_id` to a billing account (`acc_…`).
- **Events are written to an outbox** in the same transaction as the change, then published to `<QUEUE_PREFIX>:events:subscriptions`. Each event carries the line's full billable state, so billing never needs to call back:
  - `line.started { line_id, account_id, msisdn, tariff_id, tariff_name, monthly_price_pence, started_on, allowances }`. `allowances` is `{ minutes, texts, data_mb, eu_roaming, international_roaming, five_g_plus }`, with `null` quantities meaning unlimited. A line's allowances can't change while it's active (its tariff is frozen), so billing rates usage against this copy.
  - `line.ceased { line_id, account_id, msisdn, ceased_on }`
  - `line.restated`: the full line (the `line.started` fields plus `ceased_on`). When an event gains fields, a migration re-sends every line this way and consumers upsert. Migration 2 did this when `allowances` was added.

## Tasks (`subscriptions` queue, all in the gateway catalog)

| Task | Payload | Result |
|---|---|---|
| `tariffs.list` | `{ available_only? }` | Tariffs with a count of their active lines |
| `tariffs.create` | Tariff fields | `Tariff` |
| `tariffs.update` | `{ id, changes }` | `Tariff`. A change to a frozen field fails with a message meant for the administrator. |
| `lines.for_accounts` | `{ account_ids }` (≤100) | `{ [account_id]: Line[] }`: active lines, each with its tariff name, locked price and allowances |

The internal task `lines.count {}` returns `{ active }`. Billing uses it on first boot to wait for every line before backfilling its history. It isn't in the gateway catalog.

Only Core decides who can change tariffs: its routes are administrator-only. Any client the gateway accepts can call these tasks.

## Not modelled yet

- **Selling lines:** a line can't be started from Core or ceased yet. Selling a line belongs to a future Orders daemon, which would reserve a number and start a line together.
- **Ceasing on closure or port-out:** lines don't stop automatically when an account closes or a number is ported out.
- **Usage against allowances:** usage isn't metered here. The billing daemon simulates usage per line to charge out-of-bundle extras.
- **Ownership of numbers:** the MSISDN daemon still records the *account* as the number's owner rather than the line.
