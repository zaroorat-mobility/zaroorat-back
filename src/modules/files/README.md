# FILES Module

The **FILES Module** (`src/modules/files/`) provides presigned direct S3 upload pairs, image inspection, EXIF location scrubbing, download authorization policies, file reference safety checks, and automated retention/sweeper background jobs.

---

## 1. Responsibilities

- **2-Step Presigned Uploads**: Generates secure pre-signed PUT URLs directly to S3 (`POST /api/v1/files/upload-pair`), followed by explicit upload completion (`POST /api/v1/files/complete`) to transition files from `PENDING` to `COMMITTED`.
- **Content Inspection & Privacy**: Magic-byte MIME type validation and EXIF metadata stripping (removal of GPS coordinates) for user privacy.
- **Reference Guard & Soft Deletion**: Entity reference checking (`file-references.ts`) ensuring files attached to live database records (e.g., User Profile avatars) cannot be prematurely deleted.
- **Automated Lifecycle Sweepers**: Single-runner background jobs to garbage-collect uncommitted `PENDING` uploads older than 24 hours (`sweeper.job.ts`) and purge `DELETED` files past their retention window (`retention.job.ts`).

---

## 2. Directory Structure

```
src/modules/files/
│
├── services/             # Core FileService (presigning, completion, lifecycle)
│   ├── file.service.ts
│   └── index.ts
│
├── policies/             # Upload policies & read access authorization
│   ├── file.policy.ts    # Category & purpose byte limits, MIME whitelists
│   ├── read-policy.ts    # Public vs. private download authorization
│   └── index.ts
│
├── references/           # Entity reference registry
│   ├── file-references.ts# Prevents deletion of referenced entity files
│   └── index.ts
│
├── utils/                # Storage keys & magic-byte content inspector
│   ├── content-inspector.ts # Magic bytes & EXIF location remover
│   ├── storage-key.ts    # S3 key formatter
│   └── index.ts
│
├── config/               # Storage provider instantiation factory
│   ├── storage.config.ts
│   └── index.ts
│
├── metrics/              # Observability metrics emitter
│   ├── file.metrics.ts
│   └── index.ts
│
├── errors/               # Custom file domain errors
│   ├── file.errors.ts
│   └── index.ts
│
├── http/                 # Transport adapter (controllers, routes, schemas, error-response)
│   ├── file.controller.ts
│   ├── file.routes.ts
│   ├── file.schemas.ts
│   ├── error-response.ts
│   └── index.ts
│
├── providers/            # Storage provider abstraction
│   ├── storage.provider.ts # Contract interface
│   ├── s3.provider.ts    # AWS S3 SDK v3 implementation
│   ├── mock.provider.ts  # In-memory test provider
│   └── index.ts
│
├── repositories/         # Database persistence for `files` table
│   ├── file.repository.ts
│   └── index.ts
│
├── jobs/                 # Background lifecycle jobs
│   ├── sweeper.job.ts   # Garbage collects uncommitted uploads (>24h)
│   ├── retention.job.ts # Purges soft-deleted objects
│   └── index.ts
│
├── events/               # Event catalog definitions
│   ├── catalog.ts
│   └── index.ts
│
├── index.ts              # Entry point & DI container registration
└── README.md             # Production module documentation
```

---

## 3. Public APIs

### HTTP API Endpoints (`/api/v1/files`)

| Method   | Endpoint            | Description                                                | Security / Headers        |
| -------- | ------------------- | ---------------------------------------------------------- | ------------------------- |
| `POST`   | `/upload-pair`      | Request pre-signed upload URL & create `PENDING` DB record | Bearer Auth, Rate-Limited |
| `POST`   | `/complete`         | Verify upload completion & transition to `COMMITTED`       | Bearer Auth               |
| `GET`    | `/:fileId/read-url` | Generate pre-signed GET download URL                       | Bearer Auth / Public      |
| `DELETE` | `/:fileId`          | Soft delete file record (subject to reference check)       | Bearer Auth               |

---

## 4. Dependencies & Policies

- **Global Configuration** (`src/config/file/file.config.ts`): File size limits per category, allowed MIME types, retention policy windows.
- **STORAGE Provider** (`providers/`): Abstracts AWS S3 vs In-Memory Mock storage.
- **REDIS Service**: Distributed locking for sweeper and retention jobs (`file:sweeper`, `file:retention`).

---

## 5. Domain & Audit Event Catalogue

Published via `EventPublisher` under producer `files`:

| Event Name              | Classification  | Description                                 |
| ----------------------- | --------------- | ------------------------------------------- |
| `file.upload.initiated` | `observability` | Presigned upload URL generated for client   |
| `file.uploaded`         | `domain`        | Upload completed and verified               |
| `file.deleted`          | `audit`         | File marked as `DELETED`                    |
| `file.purged`           | `audit`         | File permanently purged from object storage |
