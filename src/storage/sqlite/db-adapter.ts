/**
 * Database adapter using better-sqlite3
 * Works in both Bun and Node.js
 */
import BetterSqlite3 from 'better-sqlite3';

export interface DatabaseOptions {
  create?: boolean;
  safeIntegers?: boolean;
  strict?: boolean;
}

/**
 * Database class wrapping better-sqlite3
 */
export class Database {
  private db: BetterSqlite3.Database;

  constructor(path: string, options?: DatabaseOptions) {
    this.db = new BetterSqlite3(path, {
      ...(options?.create !== undefined ? {} : { fileMustExist: false }),
    });

    if (options?.safeIntegers) {
      this.db.defaultSafeIntegers(true);
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): any {
    return this.db.prepare(sql);
  }

  transaction(fn: (...args: any[]) => void): (...args: any[]) => void {
    return this.db.transaction(fn);
  }

  close(): void {
    this.db.close();
  }
}
