import type { DatabaseSync } from "node:sqlite";
import type { TenantStore } from "./tenant-store.ts";

export type TaskPriority = "low" | "med" | "high";
export type TenantTask = {
  readonly id: number;
  readonly text: string;
  readonly priority: TaskPriority;
  readonly due: string | null;
  readonly done: boolean;
  readonly createdAt: string;
};

type TaskRow = {
  id: number;
  text: string;
  priority: TaskPriority;
  due: string | null;
  done: number;
  created_at: string;
};

function task(row: TaskRow): TenantTask {
  return Object.freeze({
    id: row.id,
    text: row.text,
    priority: row.priority,
    due: row.due,
    done: row.done === 1,
    createdAt: row.created_at,
  });
}

const SELECT_TASK =
  "SELECT id, text, priority, due, done, created_at FROM tasks";

export class TenantTaskStore {
  readonly #tenant: TenantStore;

  constructor(tenant: TenantStore) {
    this.#tenant = tenant;
  }

  list(includeDone = false): TenantTask[] {
    return this.#tenant.withStateDatabase((db) => {
      const rows = db
        .prepare(
          `${SELECT_TASK}${includeDone ? "" : " WHERE done = 0"} ORDER BY id`,
        )
        .all() as TaskRow[];
      return rows.map(task);
    });
  }

  add(input: {
    readonly text: string;
    readonly priority?: TaskPriority;
    readonly due?: string;
  }): TenantTask {
    const text = input.text.trim();
    if (text.length === 0) throw new Error("Для add нужен text");
    return this.#tenant.withStateDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const createdAt = new Date().toISOString();
        const result = db
          .prepare(
            `INSERT INTO tasks(text, priority, due, done, created_at)
             VALUES (?, ?, ?, 0, ?)`,
          )
          .run(text, input.priority ?? "med", input.due ?? null, createdAt);
        const row = db
          .prepare(`${SELECT_TASK} WHERE id = ?`)
          .get(Number(result.lastInsertRowid)) as TaskRow;
        db.exec("COMMIT");
        return task(row);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  done(id: number): TenantTask | null {
    return this.#mutateExisting(
      id,
      (db) => db.prepare("UPDATE tasks SET done = 1 WHERE id = ?").run(id),
      true,
    );
  }

  remove(id: number): TenantTask | null {
    return this.#mutateExisting(
      id,
      (db) => db.prepare("DELETE FROM tasks WHERE id = ?").run(id),
      false,
    );
  }

  #mutateExisting(
    id: number,
    mutation: (db: DatabaseSync) => unknown,
    returnUpdated: boolean,
  ): TenantTask | null {
    return this.#tenant.withStateDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const before = db.prepare(`${SELECT_TASK} WHERE id = ?`).get(id) as
          TaskRow | undefined;
        if (before === undefined) {
          db.exec("COMMIT");
          return null;
        }
        mutation(db);
        const after = returnUpdated
          ? (db.prepare(`${SELECT_TASK} WHERE id = ?`).get(id) as
              TaskRow | undefined)
          : undefined;
        db.exec("COMMIT");
        return task(after ?? before);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}
