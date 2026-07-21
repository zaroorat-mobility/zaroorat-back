# ADR-0002: Fastify as the HTTP framework

- **Status:** Accepted
- **Date:** 2026-07-20
- **Deciders:** Engineering
- **Related:** HLD §4 · Architecture Reference §1

## Context
We need a Node.js HTTP framework for a large, schema-driven API consumed by mobile clients. Requirements: strong request/response validation, high throughput, a clean plugin/encapsulation model for cross-cutting concerns, and generated API docs for the mobile team.

## Decision
We will use **Fastify**, with JSON Schema validation at every route boundary and Swagger/OpenAPI generated from those schemas.

## Consequences
- **Positive:** schema-first validation keeps untrusted data out of services; encapsulated plugins (`jwt`, `prisma`, `redis`, `socket`, `helmet`, `cors`, `rate-limit`, `swagger`); strong performance; OpenAPI is a live contract for clients.
- **Negative / trade-offs:** smaller ecosystem than Express; team must learn Fastify's plugin/encapsulation model.
- **Follow-ups:** every route declares request + response schemas; publish Swagger.

## Alternatives considered
- **Express** — rejected: no first-class schema validation or encapsulation; slower.
- **NestJS** — rejected: heavier abstraction/DI overhead than we want for a focused service.
