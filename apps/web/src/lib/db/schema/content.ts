/**
 * Content 限界上下文的 Drizzle 表定义。
 *
 * 导出：
 * - contentSources、contentDocuments、contentChunks：受控资料、文档和 1024 维向量分块。
 * - cardContents、cardContentReferences：版本化学习卡片及可追溯引用。
 */

import { sql } from "drizzle-orm";
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

import {
  createdAtColumn,
  nullableTimestampColumn,
  tsvector,
  updatedAtColumn,
} from "./_common";
import { planNodes } from "./planning";
import { users } from "./identity";

export const contentSources = pgTable("content_sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  visibility: varchar("visibility", { length: 20 }).notNull().default("catalog"),
  sourceType: varchar("source_type", { length: 20 }).notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  providerName: varchar("provider_name", { length: 120 }),
  language: varchar("language", { length: 20 }).notNull().default("zh-CN"),
  technologyTags: text("technology_tags").array().notNull().default(sql`'{}'::text[]`),
  licenseNote: text("license_note"),
  verificationStatus: varchar("verification_status", { length: 20 })
    .notNull()
    .default("pending"),
  verifiedAt: nullableTimestampColumn("verified_at"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  check("ck_content_sources_visibility", sql`${table.visibility} = 'catalog'`),
  check("ck_content_sources_type", sql`${table.sourceType} in ('document', 'video', 'web')`),
  check(
    "ck_content_sources_verification_status",
    sql`${table.verificationStatus} in ('pending', 'verified', 'invalid', 'blocked')`,
  ),
  uniqueIndex("uq_content_sources_catalog_url").on(table.canonicalUrl),
]);

export const contentDocuments = pgTable("content_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => contentSources.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  sourceUri: text("source_uri").notNull(),
  objectUri: text("object_uri"),
  contentSha256: char("content_sha256", { length: 64 }),
  mimeType: varchar("mime_type", { length: 120 }),
  parserName: varchar("parser_name", { length: 100 }),
  parserVersion: varchar("parser_version", { length: 100 }),
  pageCount: integer("page_count"),
  parsedAt: nullableTimestampColumn("parsed_at"),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_content_documents_source_hash").on(table.sourceId, table.contentSha256),
  check(
    "ck_content_documents_status",
    sql`${table.status} in ('pending', 'parsed', 'indexed', 'failed', 'archived')`,
  ),
  check(
    "ck_content_documents_page_count",
    sql`${table.pageCount} is null or ${table.pageCount} >= 0`,
  ),
  index("idx_content_documents_source_status").on(table.sourceId, table.status),
]);

export const contentChunks = pgTable("content_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => contentDocuments.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  searchTsv: tsvector("search_tsv").generatedAlwaysAs(
    sql`to_tsvector('simple', content)`,
  ),
  embedding: vector("embedding", { dimensions: 1024 }),
  embeddingModel: varchar("embedding_model", { length: 150 }),
  embeddingVersion: varchar("embedding_version", { length: 100 }),
  chunkerVersion: varchar("chunker_version", { length: 100 }).notNull(),
  tokenCount: integer("token_count"),
  sourceLocator: jsonb("source_locator").notNull().default({}),
  metadataJson: jsonb("metadata_json").notNull().default({}),
  embeddedAt: nullableTimestampColumn("embedded_at"),
  createdAt: createdAtColumn(),
}, (table) => [
  unique("uq_content_chunks_document_ordinal").on(table.documentId, table.ordinal),
  check("ck_content_chunks_ordinal", sql`${table.ordinal} >= 0`),
  check(
    "ck_content_chunks_token_count",
    sql`${table.tokenCount} is null or ${table.tokenCount} >= 0`,
  ),
  check(
    "ck_content_chunks_embedding_metadata",
    sql`(
      ${table.embedding} is null
      and ${table.embeddingModel} is null
      and ${table.embeddingVersion} is null
    ) or (
      ${table.embedding} is not null
      and ${table.embeddingModel} is not null
      and ${table.embeddingVersion} is not null
    )`,
  ),
  index("idx_content_chunks_document_ordinal").on(table.documentId, table.ordinal),
  index("idx_content_chunks_search_tsv").using("gin", table.searchTsv),
]);

export const cardContents = pgTable("card_contents", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  planNodeId: uuid("plan_node_id")
    .notNull()
    .references(() => planNodes.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  status: varchar("status", { length: 20 }).notNull().default("generating"),
  schemaVersion: varchar("schema_version", { length: 50 }).notNull(),
  publicContentJson: jsonb("public_content_json").notNull().default({}),
  runnerSpecJson: jsonb("runner_spec_json").notNull().default({}),
  generationMetadata: jsonb("generation_metadata").notNull().default({}),
  contentHash: char("content_hash", { length: 64 }),
  generatedAt: nullableTimestampColumn("generated_at"),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
}, (table) => [
  unique("uq_card_contents_node_version").on(table.planNodeId, table.version),
  check("ck_card_contents_version", sql`${table.version} >= 1`),
  check(
    "ck_card_contents_status",
    sql`${table.status} in ('generating', 'ready', 'failed', 'archived')`,
  ),
  index("idx_card_contents_node_status").on(
    table.planNodeId,
    table.status,
    table.version.desc(),
  ),
]);

export const cardContentReferences = pgTable("card_content_references", {
  id: uuid("id").defaultRandom().primaryKey(),
  cardContentId: uuid("card_content_id")
    .notNull()
    .references(() => cardContents.id, { onDelete: "cascade" }),
  contentSourceId: uuid("content_source_id")
    .notNull()
    .references(() => contentSources.id, { onDelete: "restrict" }),
  contentDocumentId: uuid("content_document_id").references(() => contentDocuments.id, {
    onDelete: "set null",
  }),
  contentChunkId: uuid("content_chunk_id").references(() => contentChunks.id, {
    onDelete: "set null",
  }),
  ordinal: integer("ordinal").notNull(),
  citationLabel: varchar("citation_label", { length: 300 }).notNull(),
  locatorJson: jsonb("locator_json").notNull().default({}),
  validationStatus: varchar("validation_status", { length: 20 })
    .notNull()
    .default("verified"),
  createdAt: createdAtColumn(),
}, (table) => [
  unique("uq_card_content_references_ordinal").on(table.cardContentId, table.ordinal),
  check("ck_card_content_references_ordinal", sql`${table.ordinal} >= 1`),
  check(
    "ck_card_content_references_status",
    sql`${table.validationStatus} in ('verified', 'stale', 'invalid')`,
  ),
]);
