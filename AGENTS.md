# Agent Directives & Project Standards

## Project Overview
Modern, highly secure analytics dashboard built with Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui, PostgreSQL (Docker), and Drizzle/Prisma.

## Core Commands
- **Dev Server:** `pnpm dev`
- **Database:** `docker compose up -d`
- **DB Migrations:** `pnpm db:generate` && `pnpm db:migrate`
- **Typecheck & Lint:** `pnpm tsc --noEmit` && `pnpm lint`
- **Test Suite:** `pnpm test`

## Architecture & Code Quality Rules
1. **Strict TypeScript:** No `any` allowed. Always define explicit interfaces or infer them from Zod/ORM schemas.
2. **Data Validation:** Validate every server input and external payload with Zod before processing.
3. **Database Operations:** Never execute raw concatenated SQL strings. Use the ORM's query builder or parameterized queries to prevent SQL injection.
4. **UI Consistency:** Use only Tailwind utility classes and shadcn/ui primitives. Avoid inline CSS and arbitrary magic values. Keep layout modular using a unified Sidebar and clean Card layouts.
5. **Component Structure:**
   - Server Components by default for data fetching.
   - Client Components (`"use client"`) only when local state, effects, or browser interactivity are strictly required.

## Security & Reliability Guardrails
- **Secrets:** Never hardcode credentials, database passwords, or JWT secrets. Read strictly from `process.env` validated with a schema (e.g., `@t3-oss/env-nextjs`).
- **Error Handling:** Do not expose raw internal database stack traces to the client. Return structured JSON error objects with clear user-facing messages.
- **Workflow Protocol:** Before marking any task as complete, verify that the application compiles without TypeScript errors (`pnpm tsc --noEmit`) and passes the linter.
