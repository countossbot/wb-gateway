// DB 配置快照 / 恢复工具（Task 56 灾备，bun .zscripts/db-snapshot.ts [export|import] [file]）
// 背景：2026-09-21 19:24 环境清理机制删除 db/custom.db（.gitignore 忽略目录为清理目标），
// provider/账户凭证/路由/密钥全部丢失且不可恢复。本工具把全部配置（含凭证）导出为 JSON
// 快照，双写项目内 backups/ 与项目外 ~/.uag-backups/（后者预期不受项目目录级清理影响）。
// 用法：
//   bun .zscripts/db-snapshot.ts export              # 导出 → backups/config-snapshot-<ts>.json（双写）
//   bun .zscripts/db-snapshot.ts import <file.json>  # 从快照恢复（幂等：upsert，不清运行历史表）
import { db } from "@/lib/db";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Snapshot = {
  exportedAt: string;
  version: 1;
  providers: unknown[];
  accounts: unknown[];
  routes: unknown[];
  candidates: unknown[];
  virtualKeys: unknown[];
  systemSettings: unknown[];
};

async function exportSnapshot() {
  const snap: Snapshot = {
    exportedAt: new Date().toISOString(),
    version: 1,
    providers: await db.provider.findMany(),
    accounts: await db.account.findMany(),
    routes: await db.modelRoute.findMany(),
    candidates: await db.routeCandidate.findMany(),
    virtualKeys: await db.virtualKey.findMany(),
    systemSettings: await db.systemSetting.findMany(),
  };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `config-snapshot-${ts}.json`;
  const json = JSON.stringify(snap, null, 2);
  const targets = [join(process.cwd(), "backups", name), join(homedir(), ".uag-backups", name)];
  for (const t of targets) {
    mkdirSync(join(t, ".."), { recursive: true });
    writeFileSync(t, json);
    console.log(`[snapshot] written: ${t} (${json.length} bytes)`);
  }
  console.log(
    `[snapshot] providers=${snap.providers.length} accounts=${snap.accounts.length} routes=${snap.routes.length} candidates=${snap.candidates.length} keys=${snap.virtualKeys.length} settings=${snap.systemSettings.length}`
  );
}

async function importSnapshot(file: string) {
  if (!existsSync(file)) throw new Error(`snapshot not found: ${file}`);
  const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  console.log(`[restore] ${file} exportedAt=${snap.exportedAt}`);
  // 幂等 upsert：按唯一键（id / keyValue / model）恢复，冲突即更新；运行历史表不动。
  for (const p of snap.providers) await db.provider.upsert({ where: { id: p.id }, create: p, update: p });
  for (const a of snap.accounts) await db.account.upsert({ where: { id: a.id }, create: a, update: a });
  for (const r of snap.routes) await db.modelRoute.upsert({ where: { id: r.id }, create: r, update: r });
  for (const c of snap.candidates) await db.routeCandidate.upsert({ where: { id: c.id }, create: c, update: c });
  for (const k of snap.virtualKeys) await db.virtualKey.upsert({ where: { keyValue: k.keyValue }, create: k, update: k });
  for (const s of snap.systemSettings) await db.systemSetting.upsert({ where: { key: s.key }, create: s, update: s });
  console.log(
    `[restore] done: providers=${snap.providers.length} accounts=${snap.accounts.length} routes=${snap.routes.length} keys=${snap.virtualKeys.length}`
  );
}

const [cmd, file] = process.argv.slice(2);
if (cmd === "export") await exportSnapshot();
else if (cmd === "import") await importSnapshot(file || "");
else {
  console.error("usage: bun .zscripts/db-snapshot.ts [export|import <file>]");
  process.exit(1);
}
