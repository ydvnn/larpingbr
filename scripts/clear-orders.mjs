import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "larper-academy.db");

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

const before = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;
const result = db.prepare("DELETE FROM orders").run();
const after = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c;

console.log(`orders before: ${before}, deleted: ${result.changes}, after: ${after}`);
db.close();
