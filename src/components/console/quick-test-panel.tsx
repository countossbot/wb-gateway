// 快速测试面板（v4.9.8 新增）—— 在虚拟密钥页底部提供端到端 API 测试
//
// 用途：让管理员在创建虚拟密钥后，无需离开控制台即可测试 API 调用是否通畅。
// 替代原有的「复制密钥 → 打开终端 → 粘贴 curl 命令 → 检查响应」多步流程，
// 转化为「粘贴密钥 → 选模型 → 输消息 → 点发送 → 看响应」一步流程。
//
// 功能：
//   - 密钥输入框（粘贴虚拟密钥或 Master Key；密码框形态防肩窥）
//   - 模型下拉（从 /v1/models 拉取可用模型列表）
//   - 消息输入（默认「你好」，支持多行）
//   - 流式/非流式切换
//   - 发送按钮 → 直接 fetch /v1/chat/completions（同源无 CORS）
//   - 响应展示区：状态码 + 耗时 + JSON 响应 / 错误信息
//   - 复制 cURL 命令按钮（生成完整 curl 命令供外部使用）
"use client";

import * as React from "react";
import {
  ChevronDown,
  Copy,
  Loader2,
  Play,
  Send,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/console/ui";

interface TestResult {
  status: number;
  durationMs: number;
  body: string;
  error: string;
}

export function QuickTestPanel() {
  const [apiKey, setApiKey] = React.useState("");
  const [models, setModels] = React.useState<string[]>([]);
  const [selectedModel, setSelectedModel] = React.useState("");
  const [message, setMessage] = React.useState("你好");
  const [stream, setStream] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [showCurl, setShowCurl] = React.useState(false);

  // 当用户输入密钥后，用该密钥拉取 /v1/models 获取可用模型列表
  // 这样模型列表与实际测试的密钥权限一致（虚拟密钥可能有模型白名单限制）
  React.useEffect(() => {
    const key = apiKey.trim();
    if (!key) {
      setModels([]);
      setSelectedModel("");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/v1/models", {
          headers: { "Authorization": `Bearer ${key}` },
        });
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled) return;
        const list: string[] = (d.data ?? []).map((m: { id: string }) => m.id);
        setModels(list);
        if (list.length > 0 && !selectedModel) setSelectedModel(list[0]);
      } catch {
        // 静默：密钥无效或网络错误时模型列表为空，用户可手动输入模型名
      }
    }, 500); // 500ms debounce 避免每次按键都发请求
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKey, selectedModel]);

  const sendTest = async () => {
    if (!apiKey.trim()) {
      setResult({ status: 0, durationMs: 0, body: "", error: "请输入 API 密钥" });
      return;
    }
    if (!selectedModel) {
      setResult({ status: 0, durationMs: 0, body: "", error: "请选择模型" });
      return;
    }
    if (!message.trim()) {
      setResult({ status: 0, durationMs: 0, body: "", error: "请输入消息内容" });
      return;
    }

    setLoading(true);
    setResult(null);
    const start = Date.now();
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: [{ role: "user", content: message }],
          stream: false,
        }),
      });
      const durationMs = Date.now() - start;
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // 非 JSON 响应（如错误页面），保持原文
      }
      setResult({
        status: res.status,
        durationMs,
        body,
        error: res.ok ? "" : `HTTP ${res.status}`,
      });
    } catch (e) {
      const durationMs = Date.now() - start;
      setResult({
        status: 0,
        durationMs,
        body: "",
        error: `网络错误：${(e as Error).message}`,
      });
    } finally {
      setLoading(false);
    }
  };

  // 生成 cURL 命令
  const curlCommand = `curl -X POST ${typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey || "sk-uag-xxx"}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${selectedModel || "deepseek-v4.1-flash"}","messages":[{"role":"user","content":"${message || "你好"}"}]}'`;

  return (
    <section className="space-y-4 rounded-xl border border-stone-200 bg-white p-4 lg:p-6">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-stone-100 text-stone-600">
            <Terminal className="size-4.5" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-stone-900">快速测试</h2>
            <p className="text-xs text-muted-foreground">粘贴密钥 → 选模型 → 发送请求 → 查看响应</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-[11px]"
          onClick={() => setShowCurl((v) => !v)}
        >
          <ChevronDown className={`size-3 transition-transform ${showCurl ? "rotate-180" : ""}`} />
          cURL 命令
        </Button>
      </div>

      {/* 输入区 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-stone-600">API 密钥</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-uag-...（虚拟密钥或 Master Key）"
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-stone-600">模型</label>
          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="text-xs">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {models.length === 0 ? (
                <SelectItem value="_loading" disabled>加载中…</SelectItem>
              ) : (
                models.map((m) => (
                  <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-stone-600">消息内容</label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="输入发送给模型的消息"
          className="min-h-[60px] text-sm"
          rows={2}
        />
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          className="bg-stone-900 hover:bg-stone-800"
          onClick={() => void sendTest()}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {loading ? "发送中…" : "发送测试请求"}
        </Button>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch checked={stream} onCheckedChange={setStream} disabled className="scale-75" />
          <span>流式（即将支持）</span>
        </div>
      </div>

      {/* cURL 命令（可折叠） */}
      {showCurl && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-stone-500">cURL 命令（复制到终端使用）</span>
            <CopyButton text={curlCommand} size="sm" variant="ghost" label="复制" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-stone-700 bg-stone-900 p-3 text-[11px] leading-relaxed text-stone-100">
            <code>{curlCommand}</code>
          </pre>
        </div>
      )}

      {/* 响应展示区 */}
      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-stone-500">响应</span>
            {result.status > 0 && (
              <Badge
                variant="outline"
                className={`px-1.5 py-0 text-[10px] tabular-nums ${
                  result.status >= 200 && result.status < 300
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {result.status}
              </Badge>
            )}
            {result.durationMs > 0 && (
              <span className="text-[10px] tabular-nums text-stone-400">
                {result.durationMs}ms
              </span>
            )}
            {result.error && (
              <span className="text-[10px] text-red-600">{result.error}</span>
            )}
          </div>
          {result.body && (
            <pre className="max-h-80 overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-[11px] leading-relaxed text-stone-800">
              <code>{result.body}</code>
            </pre>
          )}
        </div>
      )}

      {/* 提示 */}
      <p className="text-[11px] text-muted-foreground">
        提示：测试请求直接发送到网关的 /v1/chat/completions 端点（同源请求）。响应时间取决于上游提供商。
      </p>
    </section>
  );
}
