import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import type { Config } from "./config";
import type { AssignmentRef } from "./seed";

/** Daemon-to-daemon call to the MSISDN daemon, straight over Redis/BullMQ (internal task, not via the gateway). */
export class MsisdnDaemonClient {
  private readonly queue: Queue;
  private readonly events: QueueEvents;

  constructor(config: Config) {
    const connection = () => new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(config.MSISDN_QUEUE, { connection: connection(), prefix: config.QUEUE_PREFIX });
    this.events = new QueueEvents(config.MSISDN_QUEUE, { connection: connection(), prefix: config.QUEUE_PREFIX });
  }

  private async call<T>(name: string, payload: Record<string, unknown>): Promise<T> {
    await this.events.waitUntilReady();

    if ((await this.queue.getWorkersCount()) === 0) {
      throw new Error(`The MSISDN daemon is not running (no workers on [${this.queue.name}])`);
    }

    const job = await this.queue.add(name, { payload }, { attempts: 1, removeOnComplete: true, removeOnFail: { age: 600 } });

    return (await job.waitUntilFinished(this.events, 10_000)) as T;
  }

  async allAssignments(): Promise<AssignmentRef[]> {
    const refs: AssignmentRef[] = [];
    let after: string | undefined;

    for (;;) {
      const page = await this.call<AssignmentRef[]>("numbers.assignments", { after, limit: 1_000 });
      if (page.length === 0) return refs;
      refs.push(...page);
      after = page.at(-1)!.msisdn;
    }
  }

  /** Wait for the MSISDN daemon to come up, so services can start in any order. */
  async allAssignmentsWhenAvailable(log: (message: string) => void): Promise<AssignmentRef[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.allAssignments();
      } catch (error) {
        if (attempt === 1 || attempt % 6 === 0) log(`${(error as Error).message}; retrying…`);
        await Bun.sleep(Math.min(1_000 * attempt, 10_000));
      }
    }
  }

  async close(): Promise<void> {
    await this.events.close();
    await this.queue.close();
  }
}
