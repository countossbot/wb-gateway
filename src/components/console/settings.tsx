// 设置 —— 全局代理（热生效 + 测试出口）/ 管理员密码 / 系统参数 / 密钥再生成 / 数据备份与导入恢复与 KV 迁移。
// v4.1.0：备份导入恢复 —— 选择/粘贴 uag-backup-v1 整包，增量合并（merge，幂等补缺）或覆盖恢复（overwrite，
//         清空配置与日志后按备份重建）；客户端先解析预览分区条数，覆盖模式需二次确认。
"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Database,
  Download,
  FileJson,
  FileUp,
  Globe,
  History,
  KeyRound,
  Loader2,
  Network,
  RefreshCcw,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  Upload,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CopyButton,
  ErrorAlert,
  LoadingBlock,
  PageHeader,
  TagInput,
} from "@/components/console/ui";
import { Section } from "@/components/console/settings-sections";
import { PricingSection } from "@/components/console/pricing-section";
import { MembersSection } from "@/components/console/members-section";
import { apiDelete, apiGet, apiPost, apiPut, errMessage } from "@/lib/console/api";
import { relativeTime } from "@/lib/console/format";
import type {
  BackupPreview,
  ImportReport,
  MigrateReport,
  ProvidersData,
  ProxyTestRecord,
  ProxyTestResult,
  SettingsData,
  SettingsSaveResult,
} from "@/lib/console/types";

// v3.6.0：测试模式徽标文案（draft=按草稿实测 / direct=直连出口 / global=生效配置）
const PROXY_TEST_MODE_LABEL: Record<ProxyTestRecord["mode"], string> = {
  draft: "草稿实测",
  direct: "直连出口",
  global: "生效配置",
};


// v3.2.0：操作审计类型
interface AuditEntry {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  entityName: string;
  detail: unknown;
  ip: string;
  actor: string;
  createdAt: string;
}
interface AuditData {
  entries: AuditEntry[];
  stats: { total24h: number; deletes24h: number; total7d: number; total?: number; retentionDays?: number };
}

export function SettingsModule({ onPasswordChanged }: { onPasswordChanged: () => void }) {
  const [data, setData] = React.useState<SettingsData | null>(null);
  const [providers, setProviders] = React.useState<ProvidersData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  // 全局代理
  const [proxyEnabled, setProxyEnabled] = React.useState(false);
  const [proxyList, setProxyList] = React.useState("");
  const [proxyBypass, setProxyBypass] = React.useState<string[]>([]);
  const [proxySaving, setProxySaving] = React.useState(false);
  const [proxyError, setProxyError] = React.useState("");

  // 代理测试（实测当前草稿代理；后端 /api/console/proxy/test 支持草稿注入不落库）
  const [proxyTesting, setProxyTesting] = React.useState(false);
  const [proxyTestResult, setProxyTestResult] = React.useState<ProxyTestResult | null>(null);
  const [proxyTestError, setProxyTestError] = React.useState("");
  // v3.6.0：测试历史面板（SystemSetting proxyTestHistory 键，cap 20；页面加载恢复 + 每次实测后刷新）
  const [proxyHistory, setProxyHistory] = React.useState<ProxyTestRecord[]>([]);
  const [proxyHistoryOpen, setProxyHistoryOpen] = React.useState(false);
  const [proxyHistoryClearing, setProxyHistoryClearing] = React.useState(false);

  // 密码修改
  const [oldPw, setOldPw] = React.useState("");
  const [newPw, setNewPw] = React.useState("");
  const [confirmPw, setConfirmPw] = React.useState("");
  const [pwSaving, setPwSaving] = React.useState(false);
  const [pwError, setPwError] = React.useState("");
  const [pwOk, setPwOk] = React.useState(false);

  // 系统设置
  const [corsOrigins, setCorsOrigins] = React.useState<string[]>([]);
  const [listenLan, setListenLan] = React.useState(false);
  const [maxTurns, setMaxTurns] = React.useState("0");
  const [logLevel, setLogLevel] = React.useState("info");
  const [usageProvider, setUsageProvider] = React.useState("");
  const [auditRetention, setAuditRetention] = React.useState("90");
  // v3.7.0：余额快照保留期（字符串态供 Select；保存时归一为整数）
  const [balanceRetention, setBalanceRetention] = React.useState("365");
  // v4.2.0：SSE 流式保活与上游超时（秒态展示/编辑，保存时转 ms；与后端 clampInt 范围一致）
  const [stallSec, setStallSec] = React.useState("180"); // 0 = 默认 180s
  const [headersTimeoutSec, setHeadersTimeoutSec] = React.useState("300");
  const [bodyTimeoutSec, setBodyTimeoutSec] = React.useState("600");
  const [sysSaving, setSysSaving] = React.useState(false);
  const [sysError, setSysError] = React.useState("");

  // 密钥再生成
  const [regenTarget, setRegenTarget] = React.useState<"master" | "cron" | null>(null);
  const [regenSaving, setRegenSaving] = React.useState(false);
  const [regenValue, setRegenValue] = React.useState<string | null>(null);

  // KV 迁移
  const [kvText, setKvText] = React.useState("");
  const [kvRunning, setKvRunning] = React.useState(false);
  const [kvError, setKvError] = React.useState("");
  const [kvReport, setKvReport] = React.useState<MigrateReport | null>(null);

  // v4.1.0：备份导入（增量合并 / 覆盖恢复）
  const [importOpen, setImportOpen] = React.useState(false);
  const [importText, setImportText] = React.useState("");
  const [importFileName, setImportFileName] = React.useState("");
  const [importMode, setImportMode] = React.useState<"merge" | "overwrite">("merge");
  const [importRunning, setImportRunning] = React.useState(false);
  const [importError, setImportError] = React.useState("");
  const [importReport, setImportReport] = React.useState<ImportReport | null>(null);
  const [importArmed, setImportArmed] = React.useState(false); // 覆盖模式两击确认

  // v3.2.0：操作审计（删除/创建/更新/启停全埋点；删除含前快照可追溯）
  const [auditData, setAuditData] = React.useState<AuditData | null>(null);
  const [auditLoading, setAuditLoading] = React.useState(true);
  const [auditError, setAuditError] = React.useState("");
  const [auditEntity, setAuditEntity] = React.useState<string>("all");
  const [auditExpanded, setAuditExpanded] = React.useState<number | null>(null);
  // v3.2.2：审计保留期手动清理
  const [auditPurging, setAuditPurging] = React.useState(false);
  const [auditPurgeMsg, setAuditPurgeMsg] = React.useState("");
  // v3.2.3：从删除快照一键重建路由（两击确认防误触：先武装再执行）
  const [restoreArmed, setRestoreArmed] = React.useState<number | null>(null);
  const [restoring, setRestoring] = React.useState<number | null>(null);
  const [restoreMsg, setRestoreMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [s, p] = await Promise.all([
        apiGet<SettingsData>("/api/console/settings"),
        apiGet<ProvidersData>("/api/console/providers").catch(() => null),
      ]);
      setData(s);
      setProviders(p);
      const proxyListRaw = s.proxy?.list;
      const listStr = Array.isArray(proxyListRaw) ? proxyListRaw.join("\n") : String(proxyListRaw ?? "");
      setProxyEnabled(!!s.proxy?.enabled);
      setProxyList(listStr);
      setProxyBypass(Array.isArray(s.proxy?.bypass) ? s.proxy.bypass : []);
      setCorsOrigins(Array.isArray(s.corsAllowedOrigins) ? s.corsAllowedOrigins : []);
      setListenLan(!!s.listenLan);
      setMaxTurns(String(s.maxContextTurns ?? 0));
      setLogLevel(s.logLevel || "info");
      // v4.2.0：ms → 秒展示（0 = 默认语义保留展示为 0）
      setStallSec(String(Math.round((s.streamStallMs ?? 180_000) / 1000)));
      setHeadersTimeoutSec(String(Math.round((s.upstreamHeadersTimeoutMs ?? 300_000) / 1000)));
      setBodyTimeoutSec(String(Math.round((s.upstreamBodyTimeoutMs ?? 600_000) / 1000)));
      setUsageProvider(s.usageProviderId || "");
      setAuditRetention(String(s.auditRetentionDays ?? 90));
      setBalanceRetention(String(s.balanceRetentionDays ?? 365));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // v3.6.0：代理测试历史独立加载（失败静默降级，不阻塞设置页主数据）
  const loadProxyHistory = React.useCallback(async () => {
    try {
      const d = await apiGet<{ lastTest: ProxyTestRecord | null; history: ProxyTestRecord[] }>(
        "/api/console/proxy/test",
        { quiet: true }
      );
      setProxyHistory(Array.isArray(d.history) ? d.history : []);
    } catch {
      /* 静默：历史面板非关键数据 */
    }
  }, []);

  React.useEffect(() => {
    void load();
    void loadProxyHistory();
  }, [load, loadProxyHistory]);

  // v3.2.0：审计日志独立加载（切实体筛选重新拉取）
  const loadAudit = React.useCallback(async (entity: string) => {
    setAuditLoading(true);
    setAuditError("");
    try {
      const qs = entity && entity !== "all" ? `?entity=${encodeURIComponent(entity)}&limit=50` : "?limit=50";
      const d = await apiGet<AuditData>(`/api/console/audit${qs}`);
      setAuditData(d);
    } catch (e) {
      setAuditError(errMessage(e));
    } finally {
      setAuditLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadAudit(auditEntity);
  }, [loadAudit, auditEntity]);

  React.useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- 全局代理 ----
  const saveProxy = async () => {
    setProxySaving(true);
    setProxyError("");
    try {
      await apiPut("/api/console/settings", {
        proxy: { enabled: proxyEnabled, list: proxyList, bypass: proxyBypass },
      });
      setNotice("全局代理已保存并热生效（无需重启）");
      await load();
    } catch (e) {
      setProxyError(errMessage(e));
    } finally {
      setProxySaving(false);
    }
  };

  const testProxy = async () => {
    setProxyTesting(true);
    setProxyTestResult(null);
    setProxyTestError("");
    try {
      // 用当前表单草稿实测（保存前可测）；列表为空时等同测试直连出口
      const r = await apiPost<ProxyTestResult>("/api/console/proxy/test", {
        proxyList: proxyList,
        bypass: proxyBypass,
      });
      setProxyTestResult(r);
      if (Array.isArray(r.history)) setProxyHistory(r.history);
    } catch (e) {
      setProxyTestError(errMessage(e));
    } finally {
      setProxyTesting(false);
    }
  };

  // v3.6.0：清空测试历史（仅测试留痕，非业务数据）
  const clearProxyHistory = async () => {
    setProxyHistoryClearing(true);
    try {
      await apiDelete("/api/console/proxy/test", { quiet: true });
      setProxyHistory([]);
      setNotice("代理测试历史已清空");
    } catch (e) {
      setProxyError(errMessage(e));
    } finally {
      setProxyHistoryClearing(false);
    }
  };

  // ---- 密码 ----
  const changePassword = async () => {
    setPwError("");
    setPwOk(false);
    if (newPw.length < 8) {
      setPwError("新密码至少 8 位");
      return;
    }
    if (newPw !== confirmPw) {
      setPwError("两次输入的新密码不一致");
      return;
    }
    setPwSaving(true);
    try {
      await apiPost("/api/console/auth/password", { oldPassword: oldPw, newPassword: newPw });
      setPwOk(true);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      setTimeout(() => onPasswordChanged(), 1800);
    } catch (e) {
      setPwError(errMessage(e));
    } finally {
      setPwSaving(false);
    }
  };

  // ---- 系统设置 ----
  const saveSystem = async () => {
    setSysError("");
    const turns = Number(maxTurns);
    if (!Number.isFinite(turns) || turns < 0) {
      setSysError("maxContextTurns 必须为 >= 0 的整数（0 = 不限）");
      return;
    }
    const retention = Number(auditRetention);
    if (!Number.isFinite(retention) || retention < 0 || retention > 3650) {
      setSysError("审计保留期必须为 0~3650 的整数（0 = 永久保留）");
      return;
    }
    const balRetention = Number(balanceRetention);
    if (!Number.isFinite(balRetention) || balRetention < 0 || balRetention > 3650) {
      setSysError("余额快照保留期必须为 0~3650 的整数（0 = 永久保留）");
      return;
    }
    // v4.2.0：SSE/超时校验（秒态；范围与后端 ms 校验一致）
    const stall = Number(stallSec);
    if (!Number.isInteger(stall) || (stall !== 0 && (stall < 10 || stall > 900))) {
      setSysError("停滞熔断阈值必须为 0（默认 180s）或 10~900 的整数秒");
      return;
    }
    const headersT = Number(headersTimeoutSec);
    if (!Number.isInteger(headersT) || headersT < 5 || headersT > 3600) {
      setSysError("响应头超时必须为 5~3600 的整数秒");
      return;
    }
    const bodyT = Number(bodyTimeoutSec);
    if (!Number.isInteger(bodyT) || bodyT < 10 || bodyT > 3600) {
      setSysError("body 字节间隔超时必须为 10~3600 的整数秒");
      return;
    }
    setSysSaving(true);
    try {
      await apiPut("/api/console/settings", {
        corsAllowedOrigins: corsOrigins,
        listenLan,
        maxContextTurns: Math.floor(turns),
        logLevel,
        auditRetentionDays: Math.floor(retention),
        balanceRetentionDays: Math.floor(balRetention),
        streamStallMs: stall * 1000,
        upstreamHeadersTimeoutMs: headersT * 1000,
        upstreamBodyTimeoutMs: bodyT * 1000,
        ...(usageProvider ? { usageProviderId: usageProvider } : {}),
      });
      setNotice("系统设置已保存（热生效）");
      await load();
      void loadAudit(auditEntity); // 保留期变化后刷新审计统计
    } catch (e) {
      setSysError(errMessage(e));
    } finally {
      setSysSaving(false);
    }
  };

  // v3.2.2：手动清理过期审计（按保留期；仅删超过保留期的记录，保留期内不动）
  const purgeAudit = async () => {
    setAuditPurging(true);
    setAuditPurgeMsg("");
    try {
      const r = await apiPost<{ purged: number; message: string }>("/api/console/audit", {});
      setAuditPurgeMsg(r.message || `已清理 ${r.purged} 条`);
      await loadAudit(auditEntity);
    } catch (e) {
      setAuditPurgeMsg(`清理失败：${errMessage(e)}`);
    } finally {
      setAuditPurging(false);
    }
  };

  // v3.2.3：从删除审计快照一键重建路由（后端只增不删；同名存在时 409 拒绝）
  const restoreRouteFromSnapshot = async (entry: AuditEntry) => {
    setRestoring(entry.id);
    setRestoreMsg(null);
    try {
      const r = await apiPost<{ id: number; model: string; candidates: number }>("/api/console/audit/restore", {
        auditId: entry.id,
      });
      setRestoreMsg({ ok: true, text: `已从审计 #${entry.id} 快照重建路由「${r.model}」（${r.candidates} 条候选，已即时生效）` });
      setRestoreArmed(null);
      await loadAudit(auditEntity); // 刷新审计列表（新增 restore 记录）
    } catch (e) {
      setRestoreMsg({ ok: false, text: `恢复失败：${errMessage(e)}` });
    } finally {
      setRestoring(null);
    }
  };

  // 武装态 4 秒未确认自动解除（防误触 + 防遗留武装按钮）
  React.useEffect(() => {
    if (restoreArmed == null) return;
    const t = setTimeout(() => setRestoreArmed(null), 4000);
    return () => clearTimeout(t);
  }, [restoreArmed]);

  // ---- 密钥再生成 ----
  const confirmRegen = async () => {
    if (!regenTarget) return;
    setRegenSaving(true);
    try {
      const r = await apiPut<SettingsSaveResult>("/api/console/settings", {
        ...(regenTarget === "master" ? { regenerateMasterKey: true } : { regenerateCronSecret: true }),
      });
      const value = r.regenerated?.[0]?.split(": ").slice(1).join(": ") || "";
      setRegenValue(value);
      setRegenTarget(null);
      await load();
    } catch (e) {
      setError(errMessage(e));
      setRegenTarget(null);
    } finally {
      setRegenSaving(false);
    }
  };

  // ---- v4.1.0 备份导入 ----
  // 客户端解析备份文本 → 预览分区条数（不做任何写入）；解析失败返回 null 并提示
  const backupPreview = React.useMemo((): BackupPreview | null => {
    const t = importText.trim();
    if (!t) return null;
    try {
      const d = JSON.parse(t) as Record<string, unknown>;
      if (d.format !== "uag-backup-v1") return null;
      const n = (k: string): number => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0);
      return {
        format: String(d.format),
        version: String(d.version ?? "—"),
        exportedAt: String(d.exportedAt ?? ""),
        containsSecrets: d.containsSecrets !== false,
        sections: {
          providers: n("providers"),
          accounts: n("accounts"),
          routes: n("routes"),
          candidates: n("candidates"),
          virtualKeys: n("virtualKeys"),
          settings: n("settings"),
          checkinLogs: n("checkinLogs"),
          requestLogs: n("requestLogs"),
        },
      };
    } catch {
      return null;
    }
  }, [importText]);

  const previewBroken = importText.trim() !== "" && backupPreview === null;

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      setImportError("文件超过 8MB 上限：备份文件异常，请重新导出");
      return;
    }
    setImportError("");
    setImportReport(null);
    const text = await file.text();
    setImportText(text);
    setImportFileName(file.name);
  };

  const runImport = async () => {
    if (!importText.trim()) return;
    if (importMode === "overwrite" && !importArmed) {
      setImportArmed(true);
      return;
    }
    setImportRunning(true);
    setImportError("");
    try {
      const r = await apiPost<ImportReport>("/api/console/backup", { text: importText, mode: importMode });
      setImportReport(r);
      setImportArmed(false);
      setNotice(r.message);
      await load();
    } catch (e) {
      setImportError(errMessage(e));
      setImportArmed(false);
    } finally {
      setImportRunning(false);
    }
  };

  const closeImport = () => {
    setImportOpen(false);
    setImportText("");
    setImportFileName("");
    setImportMode("merge");
    setImportError("");
    setImportReport(null);
    setImportArmed(false);
  };

  // 覆盖确认武装态 6 秒未确认自动解除（防遗留武装按钮）
  React.useEffect(() => {
    if (!importArmed) return;
    const t = setTimeout(() => setImportArmed(false), 6000);
    return () => clearTimeout(t);
  }, [importArmed]);

  // ---- KV 迁移 ----
  const runMigrate = async () => {
    setKvRunning(true);
    setKvError("");
    setKvReport(null);
    try {
      const r = await apiPost<MigrateReport>("/api/console/migrate-kv", { text: kvText });
      setKvReport(r);
      setNotice(r.message);
      await load();
    } catch (e) {
      setKvError(errMessage(e));
    } finally {
      setKvRunning(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="设置" description="代理 / 安全 / 系统参数 / 数据工具" />
        <LoadingBlock rows={5} />
      </div>
    );
  }

  const lastTest = data?.proxy?.lastTest;

  return (
    <div className="space-y-6">
      <PageHeader
        title="设置"
        description={`全局代理 / 管理员密码 / 系统参数 / 数据工具 · 配置版本 v${data?.configVersion ?? "—"}`}
      />

      {notice && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <Check className="size-4" />
          {notice}
        </div>
      )}
      <ErrorAlert message={error} onRetry={load} />

      {/* ---------- 全局代理 ---------- */}
      <Section
        icon={<Globe className="size-4.5" />}
        title="全局代理"
        description="全部出站请求统一出口：http/https/socks5/socks5h，支持代理池轮换与绕过列表；保存后热生效"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={testProxy} disabled={proxyTesting}>
              {proxyTesting ? <Loader2 className="animate-spin" /> : <Network />}
              测试代理（按当前草稿）
            </Button>
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={saveProxy} disabled={proxySaving}>
              {proxySaving ? <Loader2 className="animate-spin" /> : <Save />}
              保存代理
            </Button>
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <Switch id="proxy-enabled" checked={proxyEnabled} onCheckedChange={setProxyEnabled} />
          <Label htmlFor="proxy-enabled" className="font-normal text-muted-foreground">
            启用全局代理（优先级：提供商覆盖 &gt; 此处全局设置 &gt; 环境变量 &gt; 直连）
          </Label>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="proxy-list">代理池（每行一个，或逗号分隔）</Label>
          <Textarea
            id="proxy-list"
            value={proxyList}
            onChange={(e) => setProxyList(e.target.value)}
            placeholder={"http://user:pass@proxy.example.com:8080\nsocks5h://127.0.0.1:1080\nhttps://proxy2.example.com:443"}
            className="min-h-24 font-mono text-xs"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            支持 http / https / socks5 / socks5h（远程 DNS）与 user:pass@host:port；多条地址在上游限流（429）时自动轮换
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>绕过列表（命中的主机直连）</Label>
          <TagInput tags={proxyBypass} onChange={setProxyBypass} placeholder="如 api.openai.com、.example.com、*" />
        </div>

        {proxyError && <ErrorAlert message={proxyError} />}

        {/* 测试结果 */}
        {(proxyTesting || proxyTestResult || proxyTestError || lastTest) && (
          <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3 text-sm">
            {proxyTesting && (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> 正在实测出口…
              </p>
            )}
            {proxyTestError && <p className="break-all text-red-600">{proxyTestError}</p>}
            {proxyTestResult && (
              <div className={proxyTestResult.ok ? "text-emerald-700" : "text-red-600"}>
                <p className="font-medium">
                  {proxyTestResult.ok ? "✓ 出口连通" : "✗ 代理不可用"}
                  {typeof proxyTestResult.elapsedMs === "number" ? ` · ${proxyTestResult.elapsedMs}ms` : ""}
                  {proxyTestResult.mode && (
                    <Badge
                      variant="outline"
                      className={`ml-2 px-1.5 text-[10px] font-medium ${
                        proxyTestResult.mode === "draft"
                          ? "border-teal-200 bg-teal-50 text-teal-700"
                          : proxyTestResult.mode === "direct"
                            ? "border-stone-200 bg-stone-100 text-stone-600"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {PROXY_TEST_MODE_LABEL[proxyTestResult.mode]}
                    </Badge>
                  )}
                  {proxyTestResult.scope === "global" ? " · 全局作用域" : ""}
                </p>
                {proxyTestResult.exitIp && <p>出口 IP：{proxyTestResult.exitIp}</p>}
                {proxyTestResult.error && <p className="break-all">{proxyTestResult.error}</p>}
                {Array.isArray(proxyTestResult.poolPreview) && proxyTestResult.poolPreview.length > 0 && (
                  <p className="break-all text-xs text-muted-foreground">生效代理池：{proxyTestResult.poolPreview.join(" → ")}</p>
                )}
                {proxyTestResult.diagnostics && (
                  <p className="text-xs text-muted-foreground">
                    代理池 {proxyTestResult.diagnostics.poolSize} 个 · 当前轮换索引 {proxyTestResult.diagnostics.currentIndex}
                    {proxyTestResult.diagnostics.cachedDispatchers?.length > 0
                      ? ` · 已复用连接池 ${proxyTestResult.diagnostics.cachedDispatchers.length} 个`
                      : ""}
                  </p>
                )}
                {/* v3.6.0：草稿模式逐地址实测明细（地址掩码回显） */}
                {Array.isArray(proxyTestResult.pool) && proxyTestResult.pool.length > 0 && (
                  <div className="mt-1 space-y-1 rounded-md border border-stone-200 bg-white p-2">
                    {proxyTestResult.pool.map((p, i) => (
                      <p key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px]">
                        {p.ok ? (
                          <Check className="size-3 shrink-0 text-emerald-600" aria-label="通过" />
                        ) : (
                          <AlertTriangle className="size-3 shrink-0 text-red-500" aria-label="失败" />
                        )}
                        <span className={p.ok ? "text-stone-700" : "text-stone-500 line-through decoration-red-300"}>{p.masked}</span>
                        <span className="tabular-nums text-stone-400">{p.elapsedMs}ms</span>
                        {p.exitIp && <span className="text-stone-400">· {p.exitIp}</span>}
                        {p.error && <span className="break-all font-sans text-red-500">{p.error}</span>}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!proxyTestResult && !proxyTestError && lastTest && (
              <p className="text-xs text-muted-foreground">
                最近一次测试：{lastTest.ok ? `通过（出口 ${lastTest.exitIp || "?"}，${lastTest.elapsedMs ?? "?"}ms）` : `失败（${lastTest.error || "未知错误"}）`} ·{" "}
                {relativeTime(lastTest.at)}
              </p>
            )}
          </div>
        )}

        {/* v3.6.0：测试历史面板（持久化 cap 20；跨会话可回看排障） */}
        {proxyHistory.length > 0 && (
          <div className="rounded-lg border border-stone-200 bg-white">
            <button
              type="button"
              onClick={() => setProxyHistoryOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 rounded-t-lg px-3 py-2 text-left text-sm text-stone-700 transition-colors hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-400"
              aria-expanded={proxyHistoryOpen}
            >
              <span className="flex items-center gap-2">
                <History className="size-3.5 text-stone-400" aria-hidden />
                <span className="font-medium">测试历史</span>
                <Badge variant="outline" className="px-1.5 text-[10px] text-stone-500">
                  {proxyHistory.length} 条
                </Badge>
                <span className="hidden text-[10px] text-stone-400 sm:inline">最近 {proxyHistory.filter((h) => h.ok).length} 次通过</span>
              </span>
              <span className="flex items-center gap-1">
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="清空代理测试历史"
                  onClick={(e) => {
                    e.stopPropagation();
                    void clearProxyHistory();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation();
                      void clearProxyHistory();
                    }
                  }}
                  className="rounded p-1 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500"
                >
                  {proxyHistoryClearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                </span>
                <ChevronDown className={`size-4 text-stone-400 transition-transform ${proxyHistoryOpen ? "rotate-180" : ""}`} aria-hidden />
              </span>
            </button>
            {proxyHistoryOpen && (
              <div className="max-h-64 space-y-1 overflow-y-auto border-t border-stone-100 px-3 py-2">
                {proxyHistory.map((h, i) => (
                  <div
                    key={`${h.at}-${i}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-1 text-xs transition-colors hover:bg-stone-50"
                    title={h.error || (h.ok ? `出口 ${h.exitIp || "?"}` : "失败")}
                  >
                    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
                      h.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
                    }`}>
                      {h.ok ? "通过" : "失败"}
                    </span>
                    <span className="w-14 shrink-0 text-[10px] text-stone-400">{PROXY_TEST_MODE_LABEL[h.mode]}</span>
                    <span className="text-stone-500">{relativeTime(h.at)}</span>
                    <span className="tabular-nums text-stone-400">{h.elapsedMs}ms</span>
                    {h.exitIp && <span className="font-mono text-[10px] text-stone-400">{h.exitIp}</span>}
                    {h.error && <span className="w-full truncate text-[10px] text-red-400">{h.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ---------- 管理员密码 ---------- */}
      <Section icon={<KeyRound className="size-4.5" />} title="管理员密码" description="修改后全部会话立即失效，需重新登录">
        {pwOk ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            <Check className="size-4" />
            密码已修改，正在跳回登录页…
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pw-old">当前密码</Label>
              <Input id="pw-old" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-new">新密码</Label>
              <Input id="pw-new" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="至少 8 位" autoComplete="new-password" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-confirm">确认新密码</Label>
              <Input id="pw-confirm" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
        )}
        {pwError && <p className="text-sm text-red-600">{pwError}</p>}
        <div className="flex justify-end">
          <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={changePassword} disabled={pwSaving || pwOk}>
            {pwSaving && <Loader2 className="animate-spin" />}
            修改密码
          </Button>
        </div>
      </Section>

      {/* ---------- 系统设置 ---------- */}
      <Section
        icon={<Wifi className="size-4.5" />}
        title="系统参数"
        description="CORS / 监听范围 / 上下文控制 / 日志级别 / 用量统计来源 / SSE 流式与超时"
        actions={
          <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={saveSystem} disabled={sysSaving}>
            {sysSaving ? <Loader2 className="animate-spin" /> : <Save />}
            保存系统设置
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>CORS 白名单</Label>
            <TagInput tags={corsOrigins} onChange={setCorsOrigins} placeholder="如 https://example.com（http(s)://origin 或 *）" />
            <p className="text-xs text-muted-foreground">
              默认仅同源；添加 <code className="rounded bg-stone-100 px-1">*</code> 将放开全部来源（有风险，仅在可信内网使用）
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <Switch id="listen-lan" checked={listenLan} onCheckedChange={setListenLan} />
              <Label htmlFor="listen-lan" className="font-normal text-muted-foreground">允许局域网访问控制台</Label>
            </div>
            {listenLan && (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                局域网内任何设备都可访问登录页（初始化防抢占仍限本机）。请确保密码足够强，仅在可信网络开启。
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="sys-turns">上下文最大轮数</Label>
              <Input id="sys-turns" type="number" min={0} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
              <p className="text-xs text-muted-foreground">0 = 不剪枝；超限轮次将被剪枝以控制上下文长度</p>
            </div>
            <div className="space-y-1.5">
              <Label>日志级别</Label>
              <Select value={logLevel} onValueChange={setLogLevel}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["debug", "info", "warn", "error"].map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>用量统计提供商</Label>
              <Select value={usageProvider} onValueChange={setUsageProvider}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="默认 workbuddy" />
                </SelectTrigger>
                <SelectContent>
                  {(providers?.providers ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}（{p.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">/v1/usage 的余额来源</p>
            </div>
            <div className="space-y-1.5">
              <Label>审计保留期</Label>
              <Select value={auditRetention} onValueChange={setAuditRetention}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">永久保留</SelectItem>
                  {["30", "60", "90", "180", "365"].map((d) => (
                    <SelectItem key={d} value={d}>
                      {d} 天
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">操作审计自动清理阈值（0 = 永久）</p>
            </div>
            <div className="space-y-1.5">
              <Label>余额快照保留期</Label>
              <Select value={balanceRetention} onValueChange={setBalanceRetention}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">永久保留</SelectItem>
                  {["30", "90", "180", "365", "730"].map((d) => (
                    <SelectItem key={d} value={d}>
                      {d} 天
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">余额历史快照清理阈值（0 = 永久；趋势图窗口最长 14 天，默认 365 天足够）</p>
            </div>
          </div>

          {/* v4.2.0：SSE 流式保活与上游超时（三条流式路径统一：转译 / 透传 / SSE→JSON 聚合） */}
          <div className="space-y-3 rounded-lg border border-stone-200 bg-stone-50/60 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-700">SSE 流式保活与上游超时</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  透传流每 4s 注入协议适配保活帧（Anthropic ping 事件 / OpenAI 注释行）防中间层空闲断连；上游零字节超阈值时补协议终帧后干净收尾
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="sys-stall">停滞熔断阈值（秒）</Label>
                <Input
                  id="sys-stall"
                  type="number"
                  min={0}
                  max={900}
                  value={stallSec}
                  onChange={(e) => setStallSec(e.target.value)}
                  aria-describedby="sys-stall-hint"
                />
                <p id="sys-stall-hint" className="text-xs text-muted-foreground">
                  0 = 默认 180s；长思考模型可调大（有效 10~900）
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sys-headers-timeout">响应头超时（秒）</Label>
                <Input
                  id="sys-headers-timeout"
                  type="number"
                  min={5}
                  max={3600}
                  value={headersTimeoutSec}
                  onChange={(e) => setHeadersTimeoutSec(e.target.value)}
                  aria-describedby="sys-headers-timeout-hint"
                />
                <p id="sys-headers-timeout-hint" className="text-xs text-muted-foreground">
                  等待上游响应头的上限（非流式慢模型勿调低；有效 5~3600）
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sys-body-timeout">Body 字节间隔超时（秒）</Label>
                <Input
                  id="sys-body-timeout"
                  type="number"
                  min={10}
                  max={3600}
                  value={bodyTimeoutSec}
                  onChange={(e) => setBodyTimeoutSec(e.target.value)}
                  aria-describedby="sys-body-timeout-hint"
                />
                <p id="sys-body-timeout-hint" className="text-xs text-muted-foreground">
                  上游流式字节最大间隔安全网（默认 600s；有效 10~3600）
                </p>
              </div>
            </div>
          </div>

          {sysError && <ErrorAlert message={sysError} />}
        </div>
      </Section>

      {/* ---------- 系统密钥 ---------- */}
      <Section
        icon={<ShieldAlert className="size-4.5" />}
        title="系统密钥"
        description={`master_key ${data?.hasMasterKey ? "已配置" : "缺失"} · cron_secret ${data?.hasCronSecret ? "已配置" : "缺失"} —— 再生成后旧密钥立即失效`}
      >
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" size="sm" className="border-amber-300 text-amber-700 hover:bg-amber-50" onClick={() => setRegenTarget("master")}>
            <RefreshCcw />
            再生成 Master Key
          </Button>
          <Button variant="outline" size="sm" className="border-amber-300 text-amber-700 hover:bg-amber-50" onClick={() => setRegenTarget("cron")}>
            <RefreshCcw />
            再生成 Cron Secret
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          用于 /admin/api/*（Master Key）与 /checkin 定时触发（Cron Secret，降权）。再生成后使用旧密钥的脚本将全部失效。
        </p>
      </Section>

      {/* ---------- 模型单价 · 成本估算（v4.4.0）---------- */}
      <PricingSection />

      {/* ---------- v4.9.0：成员管理（轻量 RBAC） ---------- */}
      <MembersSection />

      {/* ---------- 操作审计（v3.2.0，v3.2.2 增保留期清理）---------- */}
      <Section
        icon={<History className="size-4.5" />}
        title="操作审计"
        description="所有破坏性/关键操作全留痕 —— 删除操作含删除前完整快照（凭据脱敏），可追溯可重建"
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 border-stone-200 text-xs text-stone-600 hover:bg-stone-50"
              onClick={() => void purgeAudit()}
              disabled={auditPurging || (auditData?.stats.retentionDays ?? 90) <= 0}
              title={(auditData?.stats.retentionDays ?? 90) <= 0 ? "当前为永久保留，无过期记录可清理" : `删除超过 ${auditData?.stats.retentionDays ?? 90} 天的审计记录`}
            >
              {auditPurging ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              立即清理过期
            </Button>
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={() => void loadAudit(auditEntity)} disabled={auditLoading}>
              <RefreshCcw className={auditLoading ? "animate-spin" : ""} />
              刷新
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Select value={auditEntity} onValueChange={setAuditEntity}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue placeholder="全部实体" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部实体</SelectItem>
              <SelectItem value="provider">提供商</SelectItem>
              <SelectItem value="account">账号</SelectItem>
              <SelectItem value="route">模型路由</SelectItem>
              <SelectItem value="key">虚拟密钥</SelectItem>
              <SelectItem value="setting">系统设置</SelectItem>
            </SelectContent>
          </Select>
          {auditData && (
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[10px] text-stone-600">
                24h 操作 {auditData.stats.total24h}
              </Badge>
              <Badge
                variant="outline"
                className={`${auditData.stats.deletes24h > 0 ? "border-red-200 bg-red-50 text-red-700" : "border-stone-200 bg-stone-50 text-stone-600"} text-[10px]`}
              >
                24h 删除 {auditData.stats.deletes24h}
              </Badge>
              <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[10px] text-stone-600">
                7 天 {auditData.stats.total7d}
              </Badge>
              {typeof auditData.stats.total === "number" && (
                <Badge variant="outline" className="border-stone-200 bg-stone-50 text-[10px] text-stone-600">
                  累计 {auditData.stats.total}
                </Badge>
              )}
              {typeof auditData.stats.retentionDays === "number" && (
                <Badge
                  variant="outline"
                  className={`${auditData.stats.retentionDays > 0 ? "border-teal-200 bg-teal-50 text-teal-700" : "border-stone-200 bg-stone-50 text-stone-500"} text-[10px]`}
                >
                  保留 {auditData.stats.retentionDays > 0 ? `${auditData.stats.retentionDays} 天` : "永久"}
                </Badge>
              )}
            </div>
          )}
        </div>

        {auditPurgeMsg && (
          <p
            className={`rounded-lg border px-3 py-2 text-xs ${
              auditPurgeMsg.startsWith("清理失败")
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
            role="status"
          >
            {auditPurgeMsg}
          </p>
        )}

        {/* v3.2.3：快照重建结果反馈 */}
        {restoreMsg && (
          <p
            className={`rounded-lg border px-3 py-2 text-xs ${
              restoreMsg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"
            }`}
            role="status"
          >
            {restoreMsg.text}
          </p>
        )}

        {auditLoading && !auditData ? (
          <LoadingBlock rows={3} />
        ) : auditError ? (
          <ErrorAlert message={`审计日志加载失败：${auditError}`} />
        ) : !auditData || auditData.entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无审计记录。控制台的创建/更新/启停/删除操作（含 API 直调）都会在此留痕；删除操作保存删除前完整快照。
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border border-stone-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-stone-50/60 hover:bg-transparent">
                  <TableHead className="h-8 w-28 text-xs">时间</TableHead>
                  <TableHead className="h-8 w-20 text-xs">操作</TableHead>
                  <TableHead className="h-8 w-24 text-xs">实体</TableHead>
                  <TableHead className="h-8 text-xs">名称 / ID</TableHead>
                  <TableHead className="h-8 w-28 text-xs">IP</TableHead>
                  <TableHead className="h-8 w-16 text-xs">快照</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditData.entries.map((e) => {
                  const actionCls =
                    e.action === "delete"
                      ? "border-red-200 bg-red-50 text-red-700"
                      : e.action === "create"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : e.action === "toggle"
                          ? "border-sky-200 bg-sky-50 text-sky-700"
                          : e.action === "restore"
                            ? "border-violet-200 bg-violet-50 text-violet-700"
                            : "border-amber-200 bg-amber-50 text-amber-700";
                  const entityLabel =
                    e.entity === "provider" ? "提供商" : e.entity === "account" ? "账号" : e.entity === "route" ? "模型路由" : e.entity === "key" ? "虚拟密钥" : e.entity === "setting" ? "系统设置" : e.entity;
                  const hasDetail = e.detail != null;
                  const expanded = auditExpanded === e.id;
                  return (
                    <TableRow key={e.id} className={expanded ? "bg-stone-50/60" : undefined}>
                      <TableCell className="py-2 text-xs tabular-nums text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>
                        {relativeTime(e.createdAt)}
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge variant="outline" className={`${actionCls} px-1.5 text-[10px] font-medium`}>
                          {e.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2 text-xs text-stone-700">{entityLabel}</TableCell>
                      <TableCell className="max-w-56 py-2 text-xs font-medium text-stone-800">
                        <span className="block truncate" title={e.entityName || e.entityId}>
                          {e.entityName || e.entityId || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="py-2 text-xs tabular-nums text-muted-foreground">{e.ip || "—"}</TableCell>
                      <TableCell className="py-2">
                        {hasDetail ? (
                          <button
                            type="button"
                            className="flex items-center gap-0.5 text-xs text-teal-700 hover:text-teal-900"
                            onClick={() => setAuditExpanded(expanded ? null : e.id)}
                            aria-expanded={expanded}
                          >
                            {expanded ? "收起" : "查看"}
                            <ChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {auditData && auditExpanded != null && (() => {
          const e = auditData.entries.find((x) => x.id === auditExpanded);
          if (!e || e.detail == null) return null;
          // v3.2.3：路由删除快照可一键重建（后端只增不删，同名存在时 409 拒绝）
          const snapshot = (e.detail as { snapshot?: { model?: string } } | null)?.snapshot;
          const canRestore = e.action === "delete" && e.entity === "route" && !!snapshot?.model;
          return (
            <div className="rounded-lg border border-teal-200 bg-teal-50/40 p-3">
              <p className="text-xs font-medium text-teal-900">
                {e.action} {e.entityName || e.entityId} · detail 快照（凭据字段已脱敏）
              </p>
              <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-stone-700">
                {JSON.stringify(e.detail, null, 2)}
              </pre>
              {canRestore && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className={`h-7 gap-1 px-2.5 text-xs ${
                      restoreArmed === e.id
                        ? "bg-amber-600 text-white hover:bg-amber-700"
                        : "bg-teal-700 text-white hover:bg-teal-800"
                    }`}
                    disabled={restoring === e.id}
                    onClick={() => (restoreArmed === e.id ? void restoreRouteFromSnapshot(e) : setRestoreArmed(e.id))}
                  >
                    {restoring === e.id ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                    {restoreArmed === e.id ? "再次点击确认重建" : "一键重建该路由"}
                  </Button>
                  <span className="text-[11px] text-teal-800">
                    凭快照原样回填路由与候选顺序（同名路由已存在时会拒绝，绝不覆盖）
                  </span>
                </div>
              )}
              {e.action === "delete" && !canRestore && (
                <p className="mt-1.5 text-[11px] text-teal-800">
                  恢复提示：模型路由删除快照可一键重建；提供商/账号需人工录入凭据后重建。
                </p>
              )}
            </div>
          );
        })()}
        <p className="text-xs text-muted-foreground">
          审计记录由网关自动写入，与登录审计（LoginAudit）、请求日志（RequestLog）相互独立；查询接口 GET /api/console/audit?limit=100&entity=route
        </p>
      </Section>

      {/* ---------- 数据与迁移 ---------- */}
      <Section
        icon={<Database className="size-4.5" />}
        title="数据与迁移"
        description="一键备份全库（含凭据，仅属主本地保存）· 备份导入恢复（增量 / 覆盖）· 原 Cloudflare KV 配置一次性迁移"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => window.open("/api/console/backup", "_blank")}>
            <Download />
            一键备份导出
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload />
            导入恢复
          </Button>
          <span className="text-xs text-muted-foreground">
            备份含全部凭据与密钥明文（providers / accounts / routes / keys / settings / 日志）；导入支持增量合并与覆盖恢复两种模式
          </span>
        </div>

        <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/50 p-3">
          <p className="text-sm font-medium text-stone-700">KV 迁移工具（GATEWAY_CONFIG → SQLite）</p>
          <Textarea
            value={kvText}
            onChange={(e) => setKvText(e.target.value)}
            placeholder='粘贴原 Cloudflare Workers KV 中 GATEWAY_CONFIG 键的 JSON 全文（wrangler kv key get GATEWAY_CONFIG 或控制台导出）'
            className="min-h-32 font-mono text-xs"
            spellCheck={false}
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              仅迁移不删除既有数据；重复执行按「已存在 → 跳过」幂等处理
            </p>
            <Button size="sm" className="bg-stone-900 hover:bg-stone-800" onClick={runMigrate} disabled={kvRunning || !kvText.trim()}>
              {kvRunning ? <Loader2 className="animate-spin" /> : <Database />}
              执行迁移
            </Button>
          </div>
          {kvError && <p className="text-sm text-red-600">{kvError}</p>}

          {kvReport && (
            <div className="space-y-3 rounded-lg border border-stone-200 bg-white p-3">
              <p className="text-sm font-medium text-stone-700">{kvReport.message}</p>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-emerald-100 text-emerald-700">新建提供商 {kvReport.summary.createdProviders}</Badge>
                <Badge className="bg-teal-100 text-teal-700">新建账号 {kvReport.summary.createdAccounts}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700">新建路由 {kvReport.summary.createdRoutes}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700">新建密钥 {kvReport.summary.createdKeys}</Badge>
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">跳过提供商 {kvReport.summary.skippedProviders}</Badge>
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">跳过密钥 {kvReport.summary.skippedKeys}</Badge>
              </div>
              {kvReport.summary.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                  <p className="text-xs font-medium text-amber-800">警告（{kvReport.summary.warnings.length}）</p>
                  <ul className="mt-1 list-disc pl-4 text-xs text-amber-700">
                    {kvReport.summary.warnings.map((w, i) => (
                      <li key={i} className="break-all">{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {kvReport.report.length > 0 && (
                <div className="max-h-64 overflow-y-auto rounded border border-stone-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">分区</TableHead>
                        <TableHead className="w-20">动作</TableHead>
                        <TableHead>明细</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kvReport.report.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{r.section}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                r.action === "create"
                                  ? "border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700"
                                  : "border-amber-200 bg-amber-50 text-[10px] text-amber-700"
                              }
                            >
                              {r.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.detail}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* ---------- v4.1.0 备份导入恢复 ---------- */}
      {/* v4.1.1：max-h-[85dvh] + flex 列布局 —— 大备份粘贴/导入时对话框绝不超出视口，底部按钮常驻可点；
          内容区独立滚动（min-h-0 是 flex 子项可收缩的必要条件），替代原 grid 无界增高 */}
      <Dialog open={importOpen} onOpenChange={(o) => (!o ? closeImport() : setImportOpen(true))}>
        <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileUp className="size-5 text-stone-700" />
              备份导入恢复
            </DialogTitle>
            <DialogDescription>
              支持「一键备份导出」生成的 uag-backup 整包文件；导入前先在本地解析预览，确认无误后再写入。
            </DialogDescription>
          </DialogHeader>

          {importReport ? (
            /* ---- 成功报告 ---- */
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <Check className="size-4" />
                {importReport.message}
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-emerald-100 text-emerald-700">提供商 {importReport.counts.providers}</Badge>
                <Badge className="bg-teal-100 text-teal-700">账号 {importReport.counts.accounts}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700">路由 {importReport.counts.routes}</Badge>
                <Badge className="bg-teal-100 text-teal-700">候选 {importReport.counts.candidates}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700">密钥 {importReport.counts.keys}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700">设置 {importReport.counts.settings}</Badge>
                {importReport.mode === "overwrite" && (
                  <>
                    <Badge className="bg-stone-100 text-stone-600">签到日志 {importReport.counts.checkinLogs}</Badge>
                    <Badge className="bg-stone-100 text-stone-600">请求日志 {importReport.counts.requestLogs}</Badge>
                  </>
                )}
              </div>
              {importReport.warnings.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 p-2.5">
                  <p className="text-xs font-medium text-amber-800">警告（{importReport.warnings.length}）</p>
                  <ul className="mt-1 list-disc pl-4 text-xs text-amber-700">
                    {importReport.warnings.map((w, i) => (
                      <li key={i} className="break-all">{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {importReport.report.length > 0 && (
                <div className="max-h-56 overflow-y-auto rounded border border-stone-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">分区</TableHead>
                        <TableHead className="w-20">动作</TableHead>
                        <TableHead>明细</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importReport.report.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{r.section}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                r.action === "create"
                                  ? "border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700"
                                  : r.action === "clear"
                                    ? "border-red-200 bg-red-50 text-[10px] text-red-600"
                                    : "border-amber-200 bg-amber-50 text-[10px] text-amber-700"
                              }
                            >
                              {r.action}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.detail}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : (
            /* ---- 输入与确认 ---- */
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              {/* 文件选择 */}
              <label
                className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 px-4 py-5 text-center transition-colors hover:border-emerald-400 hover:bg-emerald-50/40"
                title="选择 uag-backup 备份 JSON 文件"
              >
                <FileJson className="size-6 text-stone-400" aria-hidden />
                <span className="text-sm font-medium text-stone-700">
                  {importFileName || "点击选择备份 JSON 文件"}
                </span>
                <span className="text-xs text-muted-foreground">文件仅在本地解析预览，不会自动写入（≤8MB）</span>
                <input
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  onChange={(e) => {
                    void onImportFile(e.target.files?.[0]);
                    e.currentTarget.value = ""; // 允许重复选择同一文件
                  }}
                />
              </label>

              {/* 粘贴备选 */}
              <div className="space-y-1.5">
                <Label htmlFor="import-text">或粘贴备份 JSON 全文</Label>
                {/* v4.1.1：field-sizing-content 会让 textarea 随内容无限增高（数 MB 备份直接冲出屏幕）——
                    max-h-48 封顶后内部滚动，文件/粘贴导入同样受控 */}
                <Textarea
                  id="import-text"
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    if (!e.target.value) setImportFileName("");
                  }}
                  placeholder='{"format":"uag-backup-v1", ...}'
                  className="max-h-48 min-h-20 font-mono text-xs"
                  spellCheck={false}
                />
              </div>

              {/* 预览 */}
              {previewBroken && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                  无法识别：不是合法的 uag-backup-v1 备份 JSON（format 字段缺失或不匹配）
                </p>
              )}
              {backupPreview && (
                <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-600">
                    <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
                      {backupPreview.format}
                    </Badge>
                    <span>导出版本 v{backupPreview.version}</span>
                    {backupPreview.exportedAt && <span>导出于 {relativeTime(backupPreview.exportedAt)}</span>}
                    {backupPreview.containsSecrets ? (
                      <span className="text-amber-600">含凭据明文 · 可恢复</span>
                    ) : (
                      <span className="text-red-600">脱敏导出 · 不可作为恢复源</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-600">提供商 {backupPreview.sections.providers}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-600">账号 {backupPreview.sections.accounts}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-600">路由 {backupPreview.sections.routes}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-600">候选 {backupPreview.sections.candidates}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-600">密钥 {backupPreview.sections.virtualKeys}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-600">设置 {backupPreview.sections.settings}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-400">签到日志 {backupPreview.sections.checkinLogs}</Badge>
                    <Badge variant="outline" className="border-stone-200 bg-white text-[10px] text-stone-400">请求日志 {backupPreview.sections.requestLogs}</Badge>
                  </div>
                </div>
              )}

              {/* 模式选择 */}
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  { value: "merge", title: "增量合并", desc: "已存在的一律跳过（保留现值），仅补缺失条目；日志分区不导入" },
                  { value: "overwrite", title: "覆盖恢复", desc: "清空现有配置与日志后按备份原样重建（保留原 ID 与时间戳）" },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setImportMode(opt.value);
                      setImportArmed(false);
                    }}
                    aria-pressed={importMode === opt.value}
                    className={`space-y-1 rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-400 ${
                      importMode === opt.value
                        ? opt.value === "overwrite"
                          ? "border-red-400 bg-red-50/60"
                          : "border-emerald-400 bg-emerald-50/60"
                        : "border-stone-200 bg-white hover:border-stone-300"
                    }`}
                  >
                    <span className={`flex items-center gap-1.5 text-sm font-semibold ${importMode === opt.value ? (opt.value === "overwrite" ? "text-red-700" : "text-emerald-700") : "text-stone-700"}`}>
                      {importMode === opt.value && <Check className="size-3.5" aria-hidden />}
                      {opt.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">{opt.desc}</span>
                  </button>
                ))}
              </div>

              {importMode === "overwrite" && (
                <p className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  覆盖恢复将清空现有的全部提供商 / 账号 / 路由 / 密钥 / 系统设置与两类日志，并按备份内容重建（管理员账号与登录会话、操作审计、用量与余额统计聚合不受影响）。此操作不可撤销。
                </p>
              )}

              {importError && <ErrorAlert message={importError} />}
            </div>
          )}

          <DialogFooter className="shrink-0 border-t border-stone-100 pt-3">
            <Button variant="outline" onClick={closeImport} disabled={importRunning}>
              {importReport ? "关闭" : "取消"}
            </Button>
            {!importReport && (
              <Button
                onClick={() => void runImport()}
                disabled={importRunning || !backupPreview}
                className={importArmed ? "bg-red-600 hover:bg-red-700" : "bg-stone-900 hover:bg-stone-800"}
              >
                {importRunning ? <Loader2 className="animate-spin" /> : importArmed ? <AlertTriangle /> : <Upload />}
                {importRunning
                  ? "导入中…"
                  : importArmed
                    ? "再次点击确认覆盖导入"
                    : importMode === "overwrite"
                      ? "覆盖导入"
                      : "开始增量导入"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- 再生成确认 ---------- */}
      <AlertDialog open={!!regenTarget} onOpenChange={(o) => !o && setRegenTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              再生成 {regenTarget === "master" ? "Master Key" : "Cron Secret"}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              旧密钥立即失效，所有使用旧密钥的自动化脚本（/admin/api/* 或 /checkin 触发）将无法鉴权。新密钥仅展示一次。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={regenSaving}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmRegen();
              }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {regenSaving && <Loader2 className="animate-spin" />}
              确认再生成
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---------- 新密钥一次性展示 ---------- */}
      <Dialog open={!!regenValue} onOpenChange={(o) => !o && setRegenValue(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="size-5" />
              新密钥已生成 · 仅此一次展示
            </DialogTitle>
            <DialogDescription>旧密钥已立即失效；请立即复制并更新你的自动化脚本。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <code className="block break-all rounded-lg border border-amber-200 bg-amber-50/60 p-4 font-mono text-sm font-semibold text-stone-900">
              {regenValue}
            </code>
            <div className="flex justify-center">
              <CopyButton text={regenValue || ""} label="复制新密钥" size="default" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegenValue(null)}>
              我已保存，关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
