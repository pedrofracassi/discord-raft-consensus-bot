import { Candidate } from "node-raft-redis";
import fs from "fs";
import { Client } from "discord.js";

let currentDistribution: {
  [key: string]: number[];
} = {};

type ShardingMessage = {
  [key: string]: number[];
};

let discordClient: Client;

const candidate = new Candidate({
  redis: {
    host: "localhost",
    port: 6379,
  },
  kind: "my-service",
});

let leaderInterval: NodeJS.Timeout;

export function divideShards(workers: string[]) {
  const recommendedShards = parseInt(
    fs.readFileSync("recommendedShards.txt", "utf8")
  );
  const shardList = Array.from({ length: recommendedShards }, (_, i) => i);
  const shardsPerWorker = Math.floor(shardList.length / workers.length);

  const newWorkers = workers.filter(
    (worker) => !(worker in currentDistribution)
  );

  const missingWorkers = Object.keys(currentDistribution).filter(
    (worker) => !workers.includes(worker)
  );

  const newShards = shardList.filter(
    (s) => !Object.values(currentDistribution).flat().includes(s)
  );

  const missingShards = Object.values(currentDistribution)
    .flat()
    .filter((s) => !shardList.includes(s as number));

  for (const shard of missingShards) {
    // find worker that owned this shard
    const worker = Object.keys(currentDistribution).find((worker) =>
      currentDistribution[worker].includes(shard)
    );

    if (!worker) {
      throw new Error("Missing worker");
    }

    // remove shard from worker
    currentDistribution[worker] = currentDistribution[worker].filter(
      (s) => s !== shard
    );
  }

  for (const worker of missingWorkers) {
    const deadWorkerShards = currentDistribution[worker];
    delete currentDistribution[worker];

    for (const shard of deadWorkerShards) {
      newShards.push(shard);
    }
  }

  for (const worker of newWorkers) {
    currentDistribution[worker] = [];
  }

  for (const shard of newShards) {
    console.log(currentDistribution);

    try {
      const worker = Object.keys(currentDistribution).reduce((a, b) =>
        currentDistribution[a].length < currentDistribution[b].length ? a : b
      );

      currentDistribution[worker].push(shard);
    } catch (e) {
      // console.log(`Could not add shard ${shard}`);
    }
  }

  while (true) {
    const workersAboveThreshold = Object.keys(currentDistribution).filter(
      (worker) => currentDistribution[worker].length > shardsPerWorker
    );

    const workersBelowThreshold = Object.keys(currentDistribution).filter(
      (worker) => currentDistribution[worker].length < shardsPerWorker
    );

    if (workersAboveThreshold.length > 0 && workersBelowThreshold.length > 0) {
      const workerAbove = workersAboveThreshold[0];
      const workerBelow = workersBelowThreshold[0];

      const shardToMove = currentDistribution[workerAbove].pop();

      if (!shardToMove) {
        throw new Error("No shard to move");
      }

      currentDistribution[workerBelow].push(shardToMove);
    } else {
      break;
    }
  }

  return currentDistribution;
}

candidate.on("elected", () => {
  console.log("ELECTED. Starting sharding loop");

  leaderInterval = setInterval(async () => {
    console.log("Sharding loop");
    const instances = (await candidate.getInstances()).filter(
      (i) => i.state == "follower"
    );
    const workers = instances.map((instance) => instance.id);
    const shards = await divideShards(workers);
    console.log(shards);
    candidate.messageAll(JSON.stringify(shards));
  }, 1000);
});

candidate.on("statechange", (state) => {
  console.log(`statechange: ${candidate.state}`);
});

candidate.on("defeated", (leader) => {
  console.log(`DEFEATED by ${leader}. Stopping sharding loop`);
  clearInterval(leaderInterval);
});

candidate.on("message", ({ message, from }) => {
  const parsedMessage: ShardingMessage = JSON.parse(message);

  for (const worker in parsedMessage) {
    console.log(
      `WORKER ${worker} (${parsedMessage[worker].length}): ${parsedMessage[
        worker
      ].join(", ")}`
    );
  }
  console.log("-----");
});

candidate.on("error", (err) => {
  console.error(err);
});
