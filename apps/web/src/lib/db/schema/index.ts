/**
 * LearnCraft Web 数据库 Schema 统一出口。
 *
 * 本文件重新导出全部 P0 表、agent schema 与关系定义，供 Drizzle Kit、数据库客户端和
 * 各限界上下文的基础设施 repository 共享同一份类型化数据库契约。
 */

export * from "./agent";
export * from "./assessment";
export * from "./content";
export * from "./identity";
export * from "./learning-assistant";
export * from "./model-connection";
export * from "./platform";
export * from "./planning";
export * from "./practice";
export * from "./profile";
export * from "./relations";
