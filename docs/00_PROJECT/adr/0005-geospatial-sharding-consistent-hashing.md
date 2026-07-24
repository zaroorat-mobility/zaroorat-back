# ADR-0005: Sharded matching tier via consistent hashing + geospatial sharding (evolution)

- **Status:** Accepted (as the scale-evolution target; not adopted at launch)
- **Date:** 2026-07-06
- **Deciders:** Engineering
- **Related:** [ADR-0003](0003-postgis-for-geo.md) (Redis GEO), [ADR-0004](0004-modular-monolith.md) (modular monolith)

## Context

The geo-matching hot path (write driver locations at high frequency; query "nearby eligible
drivers" in <100ms; run the offer loop) is the part of the system most likely to outgrow a single
data node. At launch (Srinagar/Jammu) a single Redis GEO index + stateless workers (ADR-0003)
handles this comfortably. At large scale — many cities, dense demand, seasonal tourist hotspots
(A6.3) — a single geo index becomes a write/throughput and blast-radius bottleneck.

Uber solved this with **DISCO**: **Ringpop** (SWIM gossip membership + **consistent hashing** +
request forwarding) sharding a **geospatial index** (S2 cells) across a self-organizing cluster
that rebalances when nodes join/leave. We must decide our stance on this pattern.

## Decision

We will **design the matching tier so it can evolve into a sharded, consistent-hashed geospatial
service**, but **not adopt that complexity at launch**. Concretely:

- **Launch:** Redis GEO + stateless matching workers (ADR-0003/0004). Scale via Redis Cluster and
  more workers.
- **Target (triggered by metrics):** extract `rides`-matching into a **sharded matching service**
  where the world is partitioned into **geospatial cells** (S2/geohash), cells are assigned to
  nodes via **consistent hashing with virtual nodes**, membership/failure-detection is
  **gossip-based (SWIM)**, and requests are **forwarded to the node owning the cell**. Shards are
  **replicated** for HA and **rebalance with minimal key movement** on node add/remove.
- The design, mechanisms, and adoption triggers live in
  [04_Architecture/07_advanced-scaling-and-sharding.md](../../04_Architecture/07_advanced-scaling-and-sharding.md).

## Alternatives considered

- **Adopt Ringpop-style sharding now.** Premature: high operational complexity (gossip, rebalancing,
  forwarding) for launch scale. Violates YAGNI; slows delivery.
- **Never shard; scale Redis vertically / Redis Cluster forever.** Works for a long time, but has a
  ceiling and doesn't co-locate matching compute with the shard; we want the door open.
- **Design-for, adopt-on-evidence (chosen).** Keep the modular-monolith seam (ADR-0004) so
  extraction is localized; document the target so it's a planned evolution, not a rewrite.

## Consequences

- ✅ Launch stays simple and fast (Redis GEO), yet the scale path is designed, not improvised.
- ✅ The matching module's enforced boundary (ADR-0004) makes extraction onto the sharded tier a
  localized change — the whole reason we chose a modular monolith.
- ✅ Consistent hashing gives **minimal key movement** on rebalance (only ~K/N keys move when a node
  joins/leaves), so scaling the geo tier doesn't cause a reshuffle storm.
- ⚠️ The sharded tier is genuinely complex (membership, forwarding, rebalancing, hot-cell handling).
  We adopt it **only when trigger metrics fire** (documented), never speculatively.
- ⚠️ We must avoid Uber's documented pains: gossip operational overhead and hot-shard imbalance —
  addressed via virtual nodes, cell-splitting, and preferring managed/simpler mechanisms where they
  suffice.
- ⚠️ Requires the consistent-hashing/shard tests (distribution uniformity, minimal-movement,
  rebalance correctness) before this tier ever serves production traffic (Volume 12).
