# blixten85/politiker-webapp Wiki

> This directory is machine-managed by cubic. Edit wiki content through [cubic wiki settings](https://www.cubic.dev/wiki/blixten85/politiker-webapp) and custom instructions.

Wiki version: 1
Source commit: fee08e206f9f0f4d4f4380c056fe40118a051b32
Source branch: main
Generated: 2026-07-20T09:27:34.581Z

## Contents

### Overview

- [Introduction & Project Overview](01-overview/01-intro.md)
- [Getting Started & Setup](01-overview/02-getting-started.md)
- [Non-profit Association Guidelines](01-overview/03-association.md)

### System Architecture

- [System Architecture Overview](02-architecture/01-architecture.md)
- [Cloudflare Workers Ecosystem](02-architecture/02-workers.md)
- [Security & Data Protection](02-architecture/03-security.md)

### Core Features

- [Authentication & OAuth](03-core-features/01-auth.md)
- [Two-Factor Authentication (TOTP)](03-core-features/02-totp.md)
- [Mail Account Linking & MS Graph](03-core-features/03-mail-linking.md)
- [Three-Step Contact Wizard](03-core-features/04-wizard.md)
- [Multilingual Interface (i18n)](03-core-features/05-i18n.md)
- [API Keys & Programmatic Access](03-core-features/06-api-keys.md)

### Frontend Components

- [Frontend Architecture](04-frontend/01-frontend-arch.md)
- [Wizard Web Components](04-frontend/02-ui-components.md)

### Backend Systems

- [App API & Routing](05-backend/01-app-api.md)
- [Sender Worker & Mail Queues](05-backend/02-sender-worker.md)
- [Autonomous Campaign Worker](05-backend/03-campaign-worker.md)
- [Admin Panel & Statistics](05-backend/04-admin-panel.md)
- [Rate Limiting & Durable Objects](05-backend/05-rate-limiting.md)

### Data Management/Flow

- [Database Schema & D1](06-data-management/01-database.md)
- [Session Management with KV](06-data-management/02-kv-storage.md)
- [Document & Attachment Parsing](06-data-management/03-attachment-parsing.md)

### Model Integration

- [AI Letter Drafting with Claude](07-model-integration/01-claude-drafts.md)
- [Autonomous AI News Analysis](07-model-integration/02-campaign-ai.md)

### Deployment/Infrastructure

- [Cloudflare Infrastructure Provisioning](08-deployment/01-cloudflare-infra.md)
- [Monitoring, Healthchecks & Sentry](08-deployment/02-monitoring.md)
- [Gmail Bounce Processing](08-deployment/03-bounce-processing.md)

### Extensibility and Customization

- [Local Development & Wrangler](09-extensibility/01-local-dev.md)
- [Testing Strategy & Plans](09-extensibility/02-testing.md)
