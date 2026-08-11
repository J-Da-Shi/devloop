import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema, workerState } from "./schema.js";

export interface DatabaseOptions {
  filePath: string;
  migrationsFolder?: string;
}

export interface DatabaseHandle {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: BetterSqlite3.Database;
  close(): void;
}

export function openDatabase(options: DatabaseOptions): DatabaseHandle {
  mkdirSync(dirname(options.filePath), { recursive: true });
  const sqlite = new BetterSqlite3(options.filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });
  if (options.migrationsFolder && existsSync(options.migrationsFolder)) {
    migrate(db, { migrationsFolder: options.migrationsFolder });
  }

  const now = new Date().toISOString();
  db.insert(workerState)
    .values({
      id: "primary",
      status: "RUNNING",
      heartbeatAt: now,
      activeRunId: null,
      version: 0,
    })
    .onConflictDoNothing()
    .run();

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
