# System Context & Containers (C4)

**Owner:** Architecture · **Last reviewed:** 2026-07-06

We use the [C4 model](https://c4model.com): zoom from **Context** (the system and the world
around it) → **Containers** (the deployable/runnable pieces) → **Components** (inside a container,
covered in [02](02_component-architecture.md)). This keeps diagrams honest about their level of
detail.

---

## Level 1 — System Context

Who and what interacts with Zaroorat Ride, and the external systems it depends on.

```mermaid
flowchart TB
    rider(["🧕 Rider<br/>books & takes trips"])
    driver(["🛺 Driver<br/>accepts & drives trips"])
    ops(["👩‍💼 Ops / Admin<br/>runs the marketplace"])

    system["<b>Zaroorat Ride</b><br/>Ride-hailing platform<br/>(rider app · driver app · admin · backend)"]

    sms["SMS Gateway<br/>OTP + fallback"]
    maps["Maps / Geocoding / Routing"]
    push["Push (FCM / APNs)"]
    pay["Payment / UPI<br/>(phase 2)"]
    emg["Ops / Emergency escalation<br/>(SOS routing)"]

    rider --> system
    driver --> system
    ops --> system
    system --> sms
    system --> maps
    system --> push
    system -.phase 2.-> pay
    system --> emg
```

**Reading it:** three human actor types, one system, five external dependencies. Every external
dependency is a **failure domain** we design around — most critically SMS (OTP fallback, A6.1) and
Maps (fare estimate + routing). If Maps is down we degrade to straight-line estimates; if push is
down we fall back to SMS.

---

## Level 2 — Containers

The runnable/deployable units and how they communicate.

```mermaid
flowchart TB
    subgraph client["Client tier"]
        RA["Rider App<br/><i>Expo / React Native</i>"]
        DA["Driver App<br/><i>Expo / React Native</i>"]
        AD["Admin<br/><i>React + Vite</i>"]
    end

    NG["Nginx<br/><i>reverse proxy · TLS · rate limit</i>"]

    subgraph svc["Application tier (stateless)"]
        API["API Service<br/><i>FastAPI — REST</i>"]
        WS["Realtime Gateway<br/><i>FastAPI — WebSocket</i>"]
        WK["Worker(s)<br/><i>async jobs, timers, event consumers</i>"]
    end

    subgraph data["Data tier (stateful)"]
        PG[("PostgreSQL + PostGIS<br/><i>system of record</i>")]
        RD[("Redis<br/><i>cache · geo · pub/sub · queues</i>")]
        OBJ[("Object storage<br/><i>KYC docs, media</i>")]
    end

    RA -->|HTTPS REST| NG
    DA -->|HTTPS REST| NG
    AD -->|HTTPS REST| NG
    RA <-->|WSS| NG
    DA <-->|WSS| NG
    NG --> API
    NG --> WS

    API --> PG
    API --> RD
    API --> OBJ
    WS --> RD
    WK --> PG
    WK --> RD

    API -->|publish events| RD
    RD -->|consume events| WK
    WS -->|subscribe| RD
```

### Container responsibilities

| Container              | Responsibility                                                            | Scaling                                          |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| **Rider / Driver App** | UX, location capture, offline queueing, realtime trip view                | Client devices                                   |
| **Admin**              | Ops console, dashboards, config                                           | Static SPA                                       |
| **Nginx**              | TLS termination, routing REST vs WSS, edge rate-limiting                  | Fronts the cluster                               |
| **API Service**        | Request/response business operations (REST)                               | Horizontal, stateless                            |
| **Realtime Gateway**   | WebSocket connections; pushes live location & trip events                 | Horizontal; sticky by connection, state in Redis |
| **Worker**             | Matching timers, offer expiry, notifications, settlement, event consumers | Horizontal, by queue                             |
| **PostgreSQL+PostGIS** | Durable state, transactions, geo (zones/polygons)                         | Primary + read replicas                          |
| **Redis**              | Driver geo index, pub/sub, job queues, cache, rate limits                 | Managed/clustered                                |
| **Object storage**     | KYC documents, images                                                     | Managed                                          |

> **Why split API and Realtime?** REST is request/response and scales trivially. WebSockets are
> long-lived, connection-stateful, and have a different scaling and failure profile. Separating
> them means a flood of realtime connections can't starve the transactional API, and each scales
> on its own signal (NFR-SCALE-01).

---

## Deployment view (preview)

At launch these containers run on a small Kubernetes cluster (or equivalent) with the data tier as
managed services. Full topology, environments, and network zones are in
[05_deployment-architecture.md](05_deployment-architecture.md).

## Trust boundaries (preview)

The Nginx edge is the primary trust boundary: everything behind it is the private cluster network;
clients are untrusted. Authorization is enforced at the API/WS layer on every request
(NFR-SEC-04). Full security-zone diagram is in Volume 15.
