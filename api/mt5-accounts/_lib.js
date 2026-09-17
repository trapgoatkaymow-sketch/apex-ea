import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applyCorsHeaders } from "../_cors.js";
import { durableRead, durableWrite } from "../_durableJson.js";

const FILE_PATH = process.env.MT5_ACCOUNTS_FILE_PATH || "data/mt5-accounts.json";
const BLOB_PATH =
  process.env.MT5_ACCOUNTS_BLOB_PATH || "apexea/mt5-accounts.json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.resolve(__dirname, "../../data/mt5-accounts.json");
const TMP_FILE = path.join("/tmp", "apexea-mt5-accounts.json");

let memoryAccounts = null;
let lastRemoteSha = null;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function normalizeMt5Account(row = {}) {
  const email = normalizeEmail(row.email);
  const accountId = String(row.accountId || "").trim();
  if (!email || !email.includes("@") || !accountId) return null;
  return {
    email,
    accountId,
    login: String(row.login || "").trim(),
    server: String(row.server || "").trim(),
    company: String(row.company || "").trim(),
    platform: String(row.platform || "MT5").trim().toUpperCase() || "MT5",
    region: String(row.region || "").trim(),
    connectedAt: Number(row.connectedAt) || Date.now(),
    updatedAt: Number(row.updatedAt) || Date.now(),
  };
}

function decodeAccountsJson(raw, sha = null) {
  try {
    const parsed = JSON.parse(raw || "{}");
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
    return {
      sha,
      accounts: accounts.map(normalizeMt5Account).filter(Boolean),
    };
  } catch {
    return { sha, accounts: [] };
  }
}

function mergeAccountLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const item = normalizeMt5Account(row);
      if (!item) continue;
      const prev = map.get(item.email);
      if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
        map.set(item.email, item);
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
}

function readLocalStore() {
  if (Array.isArray(memoryAccounts)) {
    return { sha: "local", accounts: memoryAccounts.map((a) => ({ ...a })) };
  }
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const decoded = decodeAccountsJson(fs.readFileSync(file, "utf8"), "local");
      memoryAccounts = decoded.accounts;
      return { sha: "local", accounts: decoded.accounts.map((a) => ({ ...a })) };
    } catch {
      // try next
    }
  }
  memoryAccounts = [];
  return { sha: "local", accounts: [] };
}

function writeLocalStore(accounts) {
  const next = accounts.map((a) => ({ ...a }));
  memoryAccounts = next;
  const payload = `${JSON.stringify({ accounts: next }, null, 2)}\n`;
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, payload, "utf8");
      break;
    } catch {
      // /tmp usually works when the repo tree is read-only
    }
  }
  return next;
}

async function readStore() {
  const remote = await durableRead({
    blobPath: BLOB_PATH,
    githubPath: FILE_PATH,
    snapshotEnv: "MT5_ACCOUNTS_SNAPSHOT_B64",
    localPaths: [TMP_FILE, LOCAL_FILE],
  });
  const decoded = decodeAccountsJson(remote.raw, remote.sha);
  lastRemoteSha = remote.source === "github" ? remote.sha : lastRemoteSha;
  const local = readLocalStore().accounts;
  const merged = mergeAccountLists(decoded.accounts, local);
  memoryAccounts = merged.map((a) => ({ ...a }));
  return {
    sha: remote.source === "github" ? remote.sha : null,
    accounts: memoryAccounts.map((a) => ({ ...a })),
    source: remote.source,
  };
}

async function writeStore(accounts, sha, message) {
  const normalized = accounts.map(normalizeMt5Account).filter(Boolean);
  writeLocalStore(normalized);
  const payload = `${JSON.stringify({ accounts: normalized }, null, 2)}\n`;
  const result = await durableWrite({
    raw: payload,
    blobPath: BLOB_PATH,
    githubPath: FILE_PATH,
    githubSha: sha && sha !== "local" ? sha : lastRemoteSha,
    message,
    localPaths: [TMP_FILE, LOCAL_FILE],
  });
  if (result.sha) lastRemoteSha = result.sha;
  return result;
}

async function mutateStore(mutator, message) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const store = await readStore();
      const next = mutator(store.accounts.map((a) => ({ ...a })));
      const write = await writeStore(next, store.sha, message);
      if (write.conflict) continue;
      return next.map(normalizeMt5Account).filter(Boolean);
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      try {
        const local = readLocalStore();
        const next = mutator(local.accounts.map((a) => ({ ...a })));
        return writeLocalStore(next);
      } catch {
        throw error;
      }
    }
  }
  throw lastError || new Error("Could not update MT5 accounts");
}

export async function listMt5Accounts() {
  const store = await readStore();
  return store.accounts;
}

export async function upsertMt5Account(payload = {}) {
  const account = normalizeMt5Account({
    ...payload,
    updatedAt: Date.now(),
    connectedAt: payload.connectedAt || Date.now(),
  });
  if (!account) {
    const err = new Error("email and accountId are required");
    err.status = 400;
    throw err;
  }

  let saved = null;
  await mutateStore((accounts) => {
    const idx = accounts.findIndex((a) => normalizeEmail(a.email) === account.email);
    if (idx >= 0) {
      saved = { ...accounts[idx], ...account };
      accounts[idx] = saved;
    } else {
      saved = account;
      accounts.unshift(account);
    }
    return accounts;
  }, `chore: upsert MT5 account ${account.email}`);

  return saved;
}

export async function removeMt5Account(email) {
  const key = normalizeEmail(email);
  if (!key) {
    const err = new Error("email is required");
    err.status = 400;
    throw err;
  }
  await mutateStore(
    (accounts) => accounts.filter((a) => normalizeEmail(a.email) !== key),
    `chore: remove MT5 account ${key}`
  );
  return { ok: true, email: key };
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}
