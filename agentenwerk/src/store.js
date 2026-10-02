// A small JSON-file store: one file per collection under DATA_DIR.
// Writes are serialized per collection and land via rename, so a crash
// mid-write never leaves a half-written file.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const newId = () => crypto.randomBytes(9).toString("base64url");

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.queues = new Map();
  }

  async #load(col) {
    if (this.cache.has(col)) return this.cache.get(col);
    let rows = [];
    try {
      rows = JSON.parse(await fs.readFile(path.join(this.dir, `${col}.json`), "utf8"));
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    this.cache.set(col, rows);
    return rows;
  }

  #persist(col) {
    const prev = this.queues.get(col) || Promise.resolve();
    const next = prev.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, `${col}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.cache.get(col)), "utf8");
      await fs.rename(tmp, file);
    });
    this.queues.set(col, next.catch(() => {}));
    return next;
  }

  async list(col, filter = () => true) {
    return (await this.#load(col)).filter(filter);
  }

  async get(col, id) {
    return (await this.#load(col)).find((r) => r.id === id) || null;
  }

  async put(col, row) {
    const rows = await this.#load(col);
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0) rows[i] = row; else rows.push(row);
    await this.#persist(col);
    return row;
  }

  async remove(col, filter) {
    const rows = await this.#load(col);
    const keep = rows.filter((r) => !filter(r));
    const removed = rows.length - keep.length;
    this.cache.set(col, keep);
    if (removed) await this.#persist(col);
    return removed;
  }
}
