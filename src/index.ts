import { UnrecoverableError, Worker } from "bullmq";
import IORedis from "ioredis";
import { TariffCatalogue } from "./catalogue";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { eventStreamKey, OutboxPublisher } from "./events";
import { LineBook } from "./lines";
import { MsisdnDaemonClient } from "./rpc";
import { isEmpty, seedCatalogue, seedLines } from "./seed";
import { createTasks } from "./tasks";

const config = loadConfig();
const log = (message: string) => console.log(`[subscriptions] ${message}`);
const connection = () => new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

const db = openDatabase(config.DATABASE_PATH);
const catalogue = new TariffCatalogue(db);
const book = new LineBook(db, catalogue);

const stream = eventStreamKey(config.QUEUE_PREFIX);
const publisher = new OutboxPublisher(db, connection(), stream);
const publish = () =>
  publisher
    .flush()
    .then((n) => n > 0 && log(`published ${n} event(s) to ${stream}`))
    .catch((error: Error) => console.error(`[subscriptions] event publish failed (will retry): ${error.message}`));

if (config.SEED_ON_EMPTY && isEmpty(db)) {
  seedCatalogue(catalogue, new Date().toISOString());
  log(`created the starter catalogue (${catalogue.list().length} tariffs)`);

  log("fetching live number assignments from the MSISDN daemon to seed lines…");
  const msisdn = new MsisdnDaemonClient(config);
  const assignments = await msisdn.allAssignmentsWhenAvailable(log);
  await msisdn.close();

  const started = performance.now();
  const lines = seedLines(db, catalogue, book, assignments, config.SEED);
  log(`started ${lines} lines in ${Math.round(performance.now() - started)}ms`);
}

await publish();
const publishTimer = setInterval(() => publisher.pending() > 0 && void publish(), 5_000);

const tasks = createTasks(catalogue, book);

const worker = new Worker(
  config.QUEUE_NAME,
  async (job) => {
    const handler = tasks[job.name];
    if (!handler) throw new UnrecoverableError(`Subscription daemon has no task [${job.name}]`);

    return handler(job.data?.payload ?? {});
  },
  { connection: connection(), prefix: config.QUEUE_PREFIX, concurrency: config.CONCURRENCY },
);

worker.on("failed", (job, error) => console.warn(`[subscriptions] ${job?.name} ${job?.id} failed: ${error.message}`));
worker.on("error", (error) => console.error(`[subscriptions] ${error.message}`));
worker.on("ready", () => log(`consuming [${config.QUEUE_NAME}] (concurrency ${config.CONCURRENCY})`));

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down...`);
  clearInterval(publishTimer);
  await worker.close();
  await publish();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
