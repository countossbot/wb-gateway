#!/usr/bin/env python3
"""对比外部库 schema 与项目 schema.prisma 的字段差异（找出外部库缺失的列）。"""
import re
import sys

LOCAL = "/home/z/my-project/prisma/schema.prisma"
REMOTE = "/tmp/remote-schema.prisma"

FIELD_RE = re.compile(r'^\s{2}(\w+)\s')

def parse_models(path: str) -> dict:
    """返回 {model: {field: field_line}}"""
    models = {}
    cur = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r'^model\s+(\w+)\s*\{', line)
            if m:
                cur = m.group(1)
                models[cur] = {}
                continue
            if cur and line.strip() == '}':
                cur = None
                continue
            if cur:
                fm = FIELD_RE.match(line)
                # 排除属性行（@@index / @@unique / @@map）
                if fm and not line.strip().startswith('@@'):
                    models[cur][fm.group(1)] = line.rstrip()
    return models

local = parse_models(LOCAL)
remote = parse_models(REMOTE)

print(f"本地模型数: {len(local)} | 外部库模型数: {len(remote)}")
missing_models = set(local) - set(remote)
extra_models = set(remote) - set(local)
if missing_models:
    print(f"❌ 外部库缺失的表: {sorted(missing_models)}")
if extra_models:
    print(f"ℹ️  外部库多出的表: {sorted(extra_models)}")

total_missing = 0
for model in local:
    if model not in remote:
        continue
    lf, rf = local[model], remote[model]
    missing = [f for f in lf if f not in rf]
    extra = [f for f in rf if f not in lf]
    if missing or extra:
        print(f"\n[model {model}]")
        for f in missing:
            print(f"  ❌ 外部库缺列: {lf[f].strip()}")
            total_missing += 1
        for f in extra:
            print(f"  ⚠️  外部库多列: {rf[f].strip()}")

print(f"\n=== 汇总: 外部库共缺失 {total_missing} 列 ===")
# 同时对比字段类型差异（同名字段但类型/默认值不同）
print("\n=== 类型/默认值差异检查 ===")
type_diffs = 0
for model in local:
    if model not in remote:
        continue
    lf, rf = local[model], remote[model]
    for f in lf:
        if f in rf:
            norm = lambda s: re.sub(r'\s+', ' ', s.split('//')[0].strip())
            if norm(lf[f]) != norm(rf[f]):
                print(f"[{model}.{f}]")
                print(f"  本地: {norm(lf[f])}")
                print(f"  外部: {norm(rf[f])}")
                type_diffs += 1
print(f"=== 类型差异共 {type_diffs} 处 ===")
