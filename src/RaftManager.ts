import { Client } from "discord.js";
import Candidate from "node-raft-redis";
import fs from "fs";

type ShardingState = {
  [key: string]: number[];
};

export default class RaftManager {
  discordClient: Client | null;
  raftCandidate: Candidate;
  shardingLoopInterval: NodeJS.Timeout | null;
  currentDistribution: ShardingState;
  lastShardCount: number;
  selfShards: number[];

  constructor() {
    this.discordClient = null;

    this.raftCandidate = new Candidate({
      redis: {
        host: "localhost",
        port: 6379,
      },
      kind: "my-service",
    });

    this.shardingLoopInterval = null;
    this.currentDistribution = {};
    this.selfShards = [];
    this.lastShardCount = 0;
  }

  init() {
    this.raftCandidate.on("elected", () => {
      console.log("Became leader. Destroying discord client.");
      this.discordClient?.destroy();
      this.selfShards = [];

      console.log("Starting sharding loop.");
      this.shardingLoopInterval = setInterval(async () => {
        console.log("Sharding loop");
        const instances = (await this.raftCandidate.getInstances()).filter(
          (i) => i.state == "follower"
        );
        const workers = instances.map((instance) => instance.id);
        const shards = await this.divideShards(workers);
        console.log(shards);
        this.raftCandidate.messageAll(JSON.stringify(shards));
      }, 1000);
    });

    this.raftCandidate.on("statechange", (state) => {
      console.log(`statechange: ${this.raftCandidate.state}`);
    });

    this.raftCandidate.on("defeated", (leader) => {
      console.log(`DEFEATED by ${leader}. Stopping sharding loop`);
      if (this.shardingLoopInterval) clearInterval(this.shardingLoopInterval);
    });

    const areSetsEqual = (a: Set<number>, b: Set<number>) =>
      a.size === b.size && [...a].every((value) => b.has(value));

    this.raftCandidate.on("message", async ({ message, from }) => {
      const parsedMessage: ShardingState = JSON.parse(message);

      let shouldReset = false;

      if (Object.values(parsedMessage).flat().length !== this.lastShardCount) {
        console.log("Cluster shard count changed. Restarting client.");
        shouldReset = true;
      }

      if (
        !areSetsEqual(
          new Set(parsedMessage[this.raftCandidate.id]),
          new Set(this.selfShards)
        )
      ) {
        console.log("Self shards changed. Restarting client.");
        shouldReset = true;
      }

      this.currentDistribution = parsedMessage;
      this.lastShardCount = Object.values(parsedMessage).flat().length;
      this.selfShards = parsedMessage[this.raftCandidate.id];

      if (shouldReset) {
        if (this.discordClient?.readyAt) {
          this.discordClient.destroy();
        }

        if (this.selfShards.length > 0) {
          this.discordClient = new Client({
            shards: this.selfShards,
            shardCount: Object.values(parsedMessage).flat().length,
            intents: ["Guilds"],
          });

          this.discordClient.on("debug", console.log);

          this.discordClient.login(process.env.DISCORD_TOKEN);
        } else {
          console.log("No shards to start client with.");
        }
      }
    });

    console.log("Starting candidate");
    this.raftCandidate.start();
  }

  getCurrentShardCount() {
    return Object.values(this.currentDistribution).flat().length;
  }

  async divideShards(workers: string[]) {
    const recommendedShards = parseInt(
      fs.readFileSync("recommendedShards.txt", "utf8")
    );

    const shardList = Array.from({ length: recommendedShards }, (_, i) => i);
    const shardsPerWorker = Math.floor(shardList.length / workers.length);

    const newWorkers = workers.filter(
      (worker) => !(worker in this.currentDistribution)
    );

    const missingWorkers = Object.keys(this.currentDistribution).filter(
      (worker) => !workers.includes(worker)
    );

    const newShards = shardList.filter(
      (s) => !Object.values(this.currentDistribution).flat().includes(s)
    );

    const missingShards = Object.values(this.currentDistribution)
      .flat()
      .filter((s) => !shardList.includes(s as number));

    for (const shard of missingShards) {
      // find worker that owned this shard
      const worker = Object.keys(this.currentDistribution).find((worker) =>
        this.currentDistribution[worker].includes(shard)
      );

      if (!worker) {
        throw new Error("Missing worker");
      }

      // remove shard from worker
      this.currentDistribution[worker] = this.currentDistribution[
        worker
      ].filter((s) => s !== shard);
    }

    for (const worker of missingWorkers) {
      const deadWorkerShards = this.currentDistribution[worker];
      delete this.currentDistribution[worker];

      for (const shard of deadWorkerShards) {
        newShards.push(shard);
      }
    }

    for (const worker of newWorkers) {
      this.currentDistribution[worker] = [];
    }

    for (const shard of newShards) {
      try {
        const worker = Object.keys(this.currentDistribution).reduce((a, b) =>
          this.currentDistribution[a].length <
          this.currentDistribution[b].length
            ? a
            : b
        );

        this.currentDistribution[worker].push(shard);
      } catch (e) {
        // console.log(`Could not add shard ${shard}`);
      }
    }

    while (true) {
      const workersAboveThreshold = Object.keys(
        this.currentDistribution
      ).filter(
        (worker) => this.currentDistribution[worker].length > shardsPerWorker
      );

      const workersBelowThreshold = Object.keys(
        this.currentDistribution
      ).filter(
        (worker) => this.currentDistribution[worker].length < shardsPerWorker
      );

      if (
        workersAboveThreshold.length > 0 &&
        workersBelowThreshold.length > 0
      ) {
        const workerAbove = workersAboveThreshold[0];
        const workerBelow = workersBelowThreshold[0];

        const shardToMove = this.currentDistribution[workerAbove].pop();

        if (!shardToMove) {
          throw new Error("No shard to move");
        }

        this.currentDistribution[workerBelow].push(shardToMove);
        console.log(
          `Moved shard ${shardToMove} from ${workerAbove} to ${workerBelow}`
        );
      } else {
        break;
      }
    }

    return this.currentDistribution;
  }
}
