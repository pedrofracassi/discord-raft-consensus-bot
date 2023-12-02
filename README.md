# discord-raft-consensus-bot

This is a Proof of Concept of using the Raft Consensus Algorithm to create a highly available Discord bot
that has its shards distributed across multiple servers, without a central manager server telling which node
to run which shards.

In this PoC, one of the nodes is elected as the leader and, instead of running the regular bot, it becomes
the manager for the shard cluster. The leader is responsible for telling each node which shards to run. If the
leader suddenly becomes unavailable, another node will be elected as the new leader and will take over the
manager role.

The amount of shards to run is stored in `recommendedShards.txt`, as a mock of Discord's [recommended shards
endpoint](https://discord.com/developers/docs/topics/gateway#get-gateway-bot), for ease of editing. The leader
will read this file and distribute the shards across the nodes.

Shards are semi-pinned to nodes, meaning that a shard will only be moved to another node if the node it is
currently running on becomes unavailable, or if that node is over the shard limit. This is to avoid unnecessary
shard migrations and downtime.

## Known caveats

- If the total amount of shards changes, all nodes will need to be restarted for the new shard distribution to
  take effect. This is due to the way that Discord's gateway works.

- When a worker's shards change, all of the worker's shards will be disconnected and reconnected. This is also due
  the way that Discord's gateway works.

## How to run

This PoC requires Bun and Redis to run. Once redis is running, use bun to start as many nodes as you want.

```bash
bun src/index.ts
```

The token for the bot is read from the `DISCORD_TOKEN` environment variable.