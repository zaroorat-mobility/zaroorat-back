# Codebase Architecture

## Overview

`backend_zaroorat` is a Fastify-based backend service built with TypeScript, Prisma ORM (PostgreSQL), Redis (ioredis / Socket.IO / BullMQ), and Awilix for dependency injection.

## Application Layers & Components

- **Server Entry Point**: `src/server.ts` & `src/worker.ts`
- **Application Setup**: `src/app/` (Fastify instance configuration, plugin loading, routes)
- **Dependency Injection**: Awilix container (`@fastify/awilix`)
- **Database & ORM**: PostgreSQL via `@prisma/client` and `@prisma/adapter-pg`
- **Real-Time Communications**: `socket.io` with `@socket.io/redis-adapter` for driver location tracking and chat
- **Background Jobs**: `bullmq` with `ioredis`
- **Spatial Indexing**: `h3-js` for hexagonal geospatial grid indexing

## Core Modules

- **Admin**: Geographic management, platform configurations, user & driver administration
- **Auth**: Authentication, authorization, session tokens
- **Drivers & Users**: Profile, verification, state tracking
- **Rides**: Ride requests, dispatching, matching, status lifecycle
- **Location & Realtime**: Driver live location streaming, H3 spatial indexing, Socket.IO channels
- **Payments & Subscriptions**: Transaction processing, wallet/gateway integration
- **Matching & Pricing**: Ride-driver matching algorithms, dynamic pricing calculation
- **Notifications & Support**: Push notifications, ticketing, chat, SOS alerting
