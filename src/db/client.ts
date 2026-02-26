import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { config } from '../config.js';

const sqlite = new Database(config.DATABASE_PATH);

// Enable WAL mode and performance pragmas
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');

export const db = drizzle({ client: sqlite, schema });
export { Database };
