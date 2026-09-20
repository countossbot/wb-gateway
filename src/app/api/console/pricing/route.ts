// /api/console/pricing —— 模型单价表管理（v4.4.0 成本估算配置面）。
// GET  ：{ rows, unpricedModels }（全部单价行 + 近 30 天未计价模型提示清单）
// PUT  ：整表保存语义（与设置页「保存」按钮一致）：payload.rows 全量 upsert，
//        DB 中不在 payload 里的模型行删除；返回 { rows, saved, deleted }。
// 校验：模型名同路由口径 /^[a-zA-Z0-9._/\[\]-]{1,128}$/；单价为 ≥0 的有限数
// （≤100,000 防溢出容错），6 位小数舍入；载荷 ≤200 行；载荷内模型名不得重复。
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSessionOr401, ok, fail } from "@/lib/gateway/console/consoleHelpers";
import { auditUpdate } from "@/lib/gateway/console/auditService";
import { unpricedModels } from "@/lib/console/pricing";

export const dynamic = "force-dynamic";

const MODEL_RE = /^[a-zA-Z0-9._/\[\]-]{1,128}$/;
const MAX_ROWS = 200;
const MAX_PRICE = 100_000; // $/1M tokens 上限（防溢出/防手滑）

interface IncomingRow {
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
}

function sanitizePrice(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return null;
  return Math.round(n * 1e6) / 1e6;
}

export async function GET(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  const [rows, suggestions] = await Promise.all([db.modelPricing.findMany({ orderBy: { model: "asc" } }), unpricedModels(30)]);
  return ok({
    rows: rows.map((r) => ({
      model: r.model,
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      cachedPerMTok: r.cachedPerMTok,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    })),
    unpricedModels: suggestions,
  });
}

export async function PUT(request: NextRequest) {
  const session = await requireSessionOr401(request);
  if (session instanceof Response) return session;

  let body: { rows?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("请求体不是合法 JSON", 400);
  }
  const rawRows = body.rows;
  if (!Array.isArray(rawRows)) return fail("rows 必须为数组", 400);
  if (rawRows.length > MAX_ROWS) return fail(`单价行数超出上限（最多 ${MAX_ROWS} 行）`, 400);

  const cleaned: IncomingRow[] = [];
  const seen = new Set<string>();
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object") return fail("单价行格式不合法", 400);
    const r = raw as Record<string, unknown>;
    const model = typeof r.model === "string" ? r.model.trim() : "";
    if (!MODEL_RE.test(model)) {
      return fail(`模型名 "${model || "(空)"}" 不合法（1-128 位字母数字与 . _ / [ ] -）`, 400);
    }
    if (seen.has(model)) return fail(`模型名 "${model}" 在载荷中重复`, 400);
    seen.add(model);
    const input = sanitizePrice(r.inputPerMTok);
    const output = sanitizePrice(r.outputPerMTok);
    const cached = sanitizePrice(r.cachedPerMTok);
    if (input === null || output === null || cached === null) {
      return fail(
        `模型 "${model}" 的单价不合法（须为 0 ~ ${MAX_PRICE} 的数字，单位 $/百万 tokens）`,
        400
      );
    }
    cleaned.push({ model, inputPerMTok: input, outputPerMTok: output, cachedPerMTok: cached });
  }

  const existing = await db.modelPricing.findMany({ select: { model: true } });
  const incomingSet = new Set(cleaned.map((r) => r.model));
  const toDelete = existing.filter((e) => !incomingSet.has(e.model));

  // 整表保存：事务内逐行 upsert + 删除缺席行（单价表 ≤ 数百行，事务体量安全）
  await db.$transaction([
    ...cleaned.map((r) =>
      db.modelPricing.upsert({
        where: { model: r.model },
        update: {
          inputPerMTok: r.inputPerMTok,
          outputPerMTok: r.outputPerMTok,
          cachedPerMTok: r.cachedPerMTok,
          updatedBy: session?.name || "admin",
        },
        create: { ...r, updatedBy: session?.name || "admin" },
      })
    ),
    ...(toDelete.length > 0
      ? [db.modelPricing.deleteMany({ where: { model: { in: toDelete.map((d) => d.model) } } })]
      : []),
  ]);

  await auditUpdate(
    "setting",
    "model-pricing",
    "模型单价表",
    {
      saved: cleaned.length,
      deleted: toDelete.length,
      deletedModels: toDelete.map((d) => d.model),
      rows: cleaned,
    },
    request
  );

  const rows = await db.modelPricing.findMany({ orderBy: { model: "asc" } });
  return ok({
    rows: rows.map((r) => ({
      model: r.model,
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      cachedPerMTok: r.cachedPerMTok,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
    })),
    saved: cleaned.length,
    deleted: toDelete.length,
  });
}
