// 初始化引导 Wizard —— 首次部署（尚无管理员）时：
// 第 1 步 设置管理员账号；第 2 步 可选配置首个上游提供商；第 3 步 一次性展示系统密钥。
"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  KeyRound,
  Loader2,
  Network,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { errMessage, apiPost } from "@/lib/console/api";
import { PROVIDER_TYPE_META, passwordStrength } from "@/lib/console/format";
import type { ProviderType, SetupResult, ProviderTestResult } from "@/lib/console/types";
import { CopyButton } from "@/components/console/ui";

type WizardStep = 1 | 2 | 3;

interface ProviderDraft {
  type: ProviderType;
  name: string;
  baseUrl: string;
  region: "cn" | "intl";
  userId: string;
  accessToken: string;
  refreshToken: string;
  apiKey: string;
  token: string;
  cookie: string;
}

const EMPTY_DRAFT: ProviderDraft = {
  type: "openai",
  name: "",
  baseUrl: "",
  region: "cn",
  userId: "",
  accessToken: "",
  refreshToken: "",
  apiKey: "",
  token: "",
  cookie: "",
};

function draftHasCredential(d: ProviderDraft): boolean {
  return !!(d.apiKey || d.accessToken || d.token || d.cookie);
}

function buildSetupProvider(d: ProviderDraft): Record<string, string> {
  const p: Record<string, string> = {
    type: d.type,
    name: d.name.trim() || d.type,
    baseUrl: d.baseUrl.trim(),
  };
  if (d.type === "workbuddy") {
    p.region = d.region;
    p.userId = d.userId.trim();
    p.accessToken = d.accessToken.trim();
    p.refreshToken = d.refreshToken.trim();
  } else if (d.type === "qwenweb") {
    p.token = d.token.trim();
    p.cookie = d.cookie.trim();
  } else if (d.type === "openai" || d.type === "anthropic") {
    p.apiKey = d.apiKey.trim();
  }
  return p;
}

export function SetupWizard({ onCompleted }: { onCompleted: () => void }) {
  const [step, setStep] = React.useState<WizardStep>(1);
  const [username, setUsername] = React.useState("admin");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [draft, setDraft] = React.useState<ProviderDraft>(EMPTY_DRAFT);
  const [error, setError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<SetupResult | null>(null);

  // 测试连接（初始化阶段无会话，401 时给出说明）
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<ProviderTestResult | null>(null);
  const [testError, setTestError] = React.useState("");

  const strength = passwordStrength(password);
  const strengthPercent = (strength.score / 5) * 100;
  const strengthColor = ["bg-red-500", "bg-red-500", "bg-amber-500", "bg-amber-500", "bg-emerald-500", "bg-emerald-500"][strength.score];

  const step1Valid = password.length >= 8 && password === confirm;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const payload: Record<string, unknown> = { type: draft.type };
      if (draft.type === "workbuddy") {
        payload.config = { region: draft.region };
        payload.credentials = { userId: draft.userId, accessToken: draft.accessToken };
      } else if (draft.type === "qwenweb") {
        payload.config = { baseUrl: draft.baseUrl };
        payload.credentials = { token: draft.token, cookie: draft.cookie };
      } else {
        payload.config = { baseUrl: draft.baseUrl };
        payload.credentials = { apiKey: draft.apiKey };
      }
      const r = await apiPost<ProviderTestResult>("/api/console/providers/test", payload, { quiet: true });
      setTestResult(r);
    } catch (e) {
      setTestError(errMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const submitSetup = async (withProvider: boolean) => {
    setSubmitting(true);
    setError("");
    try {
      const body: Record<string, unknown> = { username: username.trim() || "admin", password };
      if (withProvider && draftHasCredential(draft)) {
        body.provider = buildSetupProvider(draft);
      }
      const r = await apiPost<SetupResult>("/api/console/auth/setup", body, { quiet: true });
      setResult(r);
      setStep(3);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const setD = (patch: Partial<ProviderDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="flex min-h-screen flex-col bg-stone-50">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg">
          {/* 品牌区 */}
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-stone-900 text-white shadow-lg">
              <Network className="size-6" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-stone-900">Universal AI Gateway</h1>
            <p className="mt-1 text-sm text-muted-foreground">首次部署初始化向导</p>
          </div>

          {/* 步骤指示器 */}
          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>步骤 {step} / 3</span>
              <span>{step === 1 ? "管理员账号" : step === 2 ? "首个上游提供商" : "完成"}</span>
            </div>
            <Progress value={(step / 3) * 100} className="h-1.5 bg-stone-200 [&>div]:bg-emerald-500" />
          </div>

          <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
            <AnimatePresence mode="wait">
              {/* ---------- 第 1 步：管理员 ---------- */}
              {step === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.18 }}
                  className="space-y-4"
                >
                  <div className="space-y-2">
                    <Label htmlFor="su-username">管理员用户名</Label>
                    <Input
                      id="su-username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="默认 admin"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="su-password">管理员密码</Label>
                    <Input
                      id="su-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="至少 8 位"
                      aria-invalid={password.length > 0 && password.length < 8}
                    />
                    {password.length > 0 && (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100">
                          <div className={`h-full transition-all ${strengthColor}`} style={{ width: `${strengthPercent}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground">强度：{strength.label}</span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">至少 8 位；建议混合大小写字母、数字与符号</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="su-confirm">确认密码</Label>
                    <Input
                      id="su-confirm"
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      aria-invalid={confirm.length > 0 && confirm !== password}
                    />
                    {confirm.length > 0 && confirm !== password && (
                      <p className="text-xs text-red-600">两次输入的密码不一致</p>
                    )}
                  </div>
                  {error && <p className="text-sm text-red-600">{error}</p>}
                  <div className="flex justify-end pt-2">
                    <Button
                      className="bg-stone-900 hover:bg-stone-800"
                      disabled={!step1Valid || submitting}
                      onClick={() => {
                        setError("");
                        setStep(2);
                      }}
                    >
                      下一步 <ChevronRight />
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* ---------- 第 2 步：首个提供商 ---------- */}
              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.18 }}
                  className="space-y-4"
                >
                  <Alert className="border-emerald-200 bg-emerald-50/60 text-emerald-800 [&>svg]:text-emerald-600">
                    <Rocket />
                    <AlertTitle>可跳过</AlertTitle>
                    <AlertDescription>
                      此步骤为可选；也可以完成初始化后在控制台的「API 中转管理」中随时添加。
                    </AlertDescription>
                  </Alert>

                  <div className="space-y-2">
                    <Label>提供商类型</Label>
                    <Select value={draft.type} onValueChange={(v) => setD({ type: v as ProviderType })}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(PROVIDER_TYPE_META).map(([t, meta]) => (
                          <SelectItem key={t} value={t}>
                            <span className="font-medium">{meta.label}</span>
                            <span className="ml-2 text-xs text-muted-foreground">{meta.desc.slice(0, 18)}…</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{PROVIDER_TYPE_META[draft.type]?.desc}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="su-p-name">显示名称（可选）</Label>
                    <Input id="su-p-name" value={draft.name} onChange={(e) => setD({ name: e.target.value })} placeholder={`默认 ${draft.type}`} />
                  </div>

                  {/* 按类型渲染字段 */}
                  {draft.type === "workbuddy" && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label>站点区域</Label>
                        <RadioGroup
                          value={draft.region}
                          onValueChange={(v) => setD({ region: v as "cn" | "intl" })}
                          className="flex gap-6"
                        >
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="cn" id="su-region-cn" />
                            <Label htmlFor="su-region-cn" className="font-normal">国内站（cn）</Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="intl" id="su-region-intl" />
                            <Label htmlFor="su-region-intl" className="font-normal">国际站（intl）</Label>
                          </div>
                        </RadioGroup>
                      </div>
                      <FieldInput label="User ID" value={draft.userId} onChange={(v) => setD({ userId: v })} placeholder="WorkBuddy 用户 ID" />
                      <FieldInput label="Access Token" value={draft.accessToken} onChange={(v) => setD({ accessToken: v })} placeholder="访问令牌（较长字符串）" mono />
                      <FieldInput label="Refresh Token" value={draft.refreshToken} onChange={(v) => setD({ refreshToken: v })} placeholder="刷新令牌（可选）" mono />
                    </div>
                  )}

                  {(draft.type === "openai" || draft.type === "anthropic") && (
                    <div className="space-y-3">
                      <FieldInput
                        label="Base URL"
                        value={draft.baseUrl}
                        onChange={(v) => setD({ baseUrl: v })}
                        placeholder={PROVIDER_TYPE_META[draft.type]?.defaultBaseUrl}
                        mono
                      />
                      <FieldInput label="API Key" value={draft.apiKey} onChange={(v) => setD({ apiKey: v })} placeholder="sk-…" mono />
                    </div>
                  )}

                  {draft.type === "opencode" && (
                    <div className="space-y-3">
                      <FieldInput
                        label="Base URL"
                        value={draft.baseUrl}
                        onChange={(v) => setD({ baseUrl: v })}
                        placeholder="https://opencode.ai/zen/v1"
                        mono
                      />
                      <p className="text-xs text-muted-foreground">
                        OpenCode Zen 免费模型池无需凭据。注意：由于无凭据字段，初始化向导不会创建该提供商，请初始化完成后在控制台「API 中转管理」中添加。
                      </p>
                    </div>
                  )}

                  {draft.type === "qwenweb" && (
                    <div className="space-y-3">
                      <FieldInput label="Base URL" value={draft.baseUrl} onChange={(v) => setD({ baseUrl: v })} placeholder="https://chat.qwen.ai" mono />
                      <FieldInput label="Token" value={draft.token} onChange={(v) => setD({ token: v })} placeholder="Web 端 Token" mono />
                      <div className="space-y-1.5">
                        <Label htmlFor="su-p-cookie">Cookie</Label>
                        <Textarea id="su-p-cookie" value={draft.cookie} onChange={(e) => setD({ cookie: e.target.value })} placeholder="浏览器 Cookie 字符串（可选）" className="font-mono text-xs" rows={3} />
                      </div>
                    </div>
                  )}

                  {/* 测试连接 */}
                  <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-stone-700">连接测试</span>
                      <Button type="button" variant="outline" size="sm" onClick={runTest} disabled={testing}>
                        {testing ? <Loader2 className="animate-spin" /> : <Zap />}
                        测试连接
                      </Button>
                    </div>
                    {testError && (
                      <p className="text-xs text-amber-700">
                        {testError}
                        {testError.includes("未登录") || testError.includes("401") ? "（初始化阶段暂无会话；可完成初始化后在控制台中测试）" : ""}
                      </p>
                    )}
                    {testResult && (
                      <p className={`text-xs ${testResult.success ? "text-emerald-700" : "text-red-600"}`}>
                        {testResult.success ? "✓ " : "✗ "}
                        {testResult.message}
                        {typeof testResult.elapsedMs === "number" ? `（${testResult.elapsedMs}ms）` : ""}
                      </p>
                    )}
                  </div>

                  {error && <p className="text-sm text-red-600">{error}</p>}

                  <div className="flex items-center justify-between pt-2">
                    <Button variant="outline" onClick={() => setStep(1)} disabled={submitting}>
                      <ChevronLeft /> 上一步
                    </Button>
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={() => submitSetup(false)} disabled={submitting}>
                        <SkipForward /> 跳过此步
                      </Button>
                      <Button className="bg-stone-900 hover:bg-stone-800" onClick={() => submitSetup(true)} disabled={submitting}>
                        {submitting ? <Loader2 className="animate-spin" /> : <Check />}
                        完成初始化
                      </Button>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* ---------- 第 3 步：密钥展示 ---------- */}
              {step === 3 && result && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-5"
                >
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                      <Check className="size-5" />
                    </span>
                    <div>
                      <h2 className="text-lg font-semibold text-stone-900">初始化完成</h2>
                      <p className="text-sm text-muted-foreground">
                        {result.createdProvider ? `已创建首个提供商「${result.createdProvider}」` : "尚未配置上游提供商（可在控制台中添加）"}
                      </p>
                    </div>
                  </div>

                  <Alert variant="destructive">
                    <ShieldAlert />
                    <AlertTitle>以下密钥仅此一次展示</AlertTitle>
                    <AlertDescription>
                      关闭本页后将无法再次查看，请立即复制并妥善保存。丢失后只能通过「设置」中再生成（旧密钥立即失效）。
                    </AlertDescription>
                  </Alert>

                  <div className="space-y-3">
                    <SecretShowcase label="Master Key（管理鉴权）" hint="用于 /admin/api/* 的 Bearer 令牌" value={result.master_key} />
                    <SecretShowcase label="Cron Secret（定时任务触发）" hint="用于 /checkin 等定时触发鉴权（降权）" value={result.cron_secret} />
                    <SecretShowcase label="Client Key（客户端接入）" hint="Claude Code / CC-Switch 的虚拟密钥（模型白名单 *）" value={result.client_key} />
                  </div>

                  <Button className="w-full bg-stone-900 hover:bg-stone-800" onClick={onCompleted}>
                    <KeyRound /> 前往登录
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            <ShieldCheck className="mr-1 inline size-3 align-[-1px] text-emerald-600" />
            初始化仅允许来自本机（127.0.0.1）的请求，防止远程抢占
          </p>
        </div>
      </main>

      <footer className="mt-auto py-6 text-center text-xs text-muted-foreground">
        Universal AI Gateway · 初始化向导
      </footer>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? "font-mono text-xs" : undefined}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

function SecretShowcase({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50/60 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-800">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{hint}</p>
        </div>
        <CopyButton text={value} size="sm" variant="secondary" />
      </div>
      <code className="block w-full break-all rounded border border-stone-200 bg-white px-3 py-2 font-mono text-sm text-stone-900">
        <Copy className="mr-1.5 inline size-3 text-stone-400" />
        {value}
      </code>
    </div>
  );
}
