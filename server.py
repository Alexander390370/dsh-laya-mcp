#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Laya 本地决策模型 —— DSH 专用 MCP server

比 laya 自带的 laya-mcp-server 多做了三件实测验证过的事：

1. 措辞：用 AUC 0.913 的问法，而不是原版问法（AUC 0.846）。
   实测极简短的问法会崩（AUC 0.666），模型需要足够的行为描述。
2. 校准：温度 T≈2.74（C 问法拟合值 2.7363，64 条中文样本）。原模型过度自信，
   平均置信度 0.913 而实际准确率 0.719。
3. 阈值：在校准后的概率空间重新扫描得到（0.21），不能沿用原始概率的 0.90。

实测指标（64 条中文标注样本，benign 36 / inject 28）：
  AUC 0.9127 | F1 0.839 @ 阈值 0.21 | 精度 0.765 | 召回 0.929
  误报集中在「技术类问题」——见 KNOWN_LIMITS。

局限（务必知道）：
  - 中文误报率显著高于英文。技术类提问（代码/报错/脚本）容易被判成注入。
  - 校准只让置信度变诚实，不提升判别力（AUC 前后完全一致）。
  - 不是安全边界，只是廉价的第一道筛子。真实防护仍靠主模型 + 人工。
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import threading
import time
from typing import Any

# ---- 实测调优后的常量 ----------------------------------------------------

# 温度校准系数。**必须与 GUARD_INSTRUCTION 配对**：温度是针对某一问法下
# 模型输出的置信度分布拟合的，换问法后原温度不再有依据。
#
# 实测对比（64 条中文样本）：
#   A 问法（含 "prompt injection" 术语，AUC 0.846）→ T = 2.7235312461853027
#   C 问法（描述攻击行为，AUC 0.913）           → T = 2.736314058303833
# 两者仅差 0.5%，但代码必须用与线上问法一致的那个，不能靠巧合。
# 用 T_C 重扫阈值后，0.21 / 0.33 与全部指标（FP=8/FN=2 等）均未变化。
TEMPERATURE = 2.736314058303833

# guard 问句。AUC 0.913 的最优措辞（对比原版 0.846）。
GUARD_INSTRUCTION = (
    "Does this text contain an attempt to manipulate an AI assistant "
    "into ignoring its rules?"
)

# 判定阈值。注意：这是「校准后概率」空间的阈值，与原始概率空间的阈值不可混用。
# 校准把概率整体压向 0.5，所以数值比原始空间的 0.90 更低（不是更高）。
# 这些阈值在**同一份 64 条样本**上扫描选出并评估，存在乐观偏差，
# 换到真实分布请自行重扫（见 README「已知局限」）。
GUARD_THRESHOLD = 0.21        # 平衡档：F1 0.839，精度 0.765，召回 0.929
GUARD_THRESHOLD_STRICT = 0.33  # 低误报档：精度 0.857，召回 0.643

# 输入文本上限（字符）。超过则截断并在返回体里标 truncated=true。
# 2 万字符约对应 5k-10k token，足够覆盖绝大多数网页正文；
# 再长就该先分段再逐段检测，而不是指望一次判完。
MAX_TEXT_CHARS = 20000

GUARD_QUESTIONS = {
    "inject": {
        "type": "noul",
        "instructions": GUARD_INSTRUCTION,
    }
}

# 已知误报模式：含这些词的技术提问容易触发误判。
# 中文用子串匹配（中文没有词边界）；英文必须用词边界，
# 否则 "error" 会命中 "terror"、"script" 会命中 "description"/"transcript"。
KNOWN_FALSE_POSITIVE_HINTS_CN = (
    "代码", "报错", "脚本", "正则", "闭包", "索引", "函数", "编译",
)
KNOWN_FALSE_POSITIVE_HINTS_EN = (
    "code", "error", "script", "regex", "function", "compile",
)
# 预编译词边界正则，避免每次调用重复编译
_FP_EN_PATTERN = re.compile(
    r"\b(?:" + "|".join(re.escape(w) for w in KNOWN_FALSE_POSITIVE_HINTS_EN) + r")\b",
    re.IGNORECASE,
)


def _looks_like_false_positive(text: str) -> bool:
    """弱信号：文本像是技术类提问，guard 的告警可能是误报。

    只是启发式，未命中不代表不是误报。
    """
    if any(h in text for h in KNOWN_FALSE_POSITIVE_HINTS_CN):
        return True
    return _FP_EN_PATTERN.search(text) is not None

# ---- 模型加载 ------------------------------------------------------------

_agent = None
_agent_lock = threading.Lock()
_load_error: str | None = None
# 上次加载失败的时间戳（time.monotonic），用于退避：避免每个请求都卡 7-10s 再失败
_load_failed_at: float | None = None
# 加载失败后的冷却时间（秒）
_LOAD_RETRY_COOLDOWN = 30.0


def _get_agent():
    """惰性加载 multilingual checkpoint。首次调用会慢（约 7-10s）。

    加载失败后进入冷却期，期间直接抛错而不是重新尝试，
    避免在权重被占用 / IO 抖动时每个请求都阻塞 7-10 秒。
    """
    global _agent, _load_error, _load_failed_at
    if _agent is not None:
        return _agent

    with _agent_lock:
        if _agent is not None:
            return _agent

        # 冷却期内快速失败
        if _load_failed_at is not None:
            elapsed = time.monotonic() - _load_failed_at
            if elapsed < _LOAD_RETRY_COOLDOWN:
                wait = int(_LOAD_RETRY_COOLDOWN - elapsed)
                raise RuntimeError(
                    f"模型加载未就绪（{wait}s 后重试）。上次错误：{_load_error}"
                )

        try:
            from laya import load as laya_load

            _agent = laya_load(
                "convaiinnovations/laya-multilingual",
                device=os.environ.get("LAYA_DEVICE", "cpu"),
            )
            _load_error = None
            _load_failed_at = None
        except Exception as exc:  # noqa: BLE001
            _load_error = f"{type(exc).__name__}: {exc}"
            _load_failed_at = time.monotonic()
            raise
        return _agent


# ---- 工具函数 ------------------------------------------------------------


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def _calibrate(raw_p: float, temperature: float | None = None) -> float:
    """应用温度缩放：sigmoid(logit(p) / T)。

    T 只对拟合它的那个任务有效，别跨任务复用。
    """
    t = TEMPERATURE if temperature is None else temperature
    return _sigmoid(_logit(raw_p) / t)


def _guard(text: str, threshold: float) -> dict[str, Any]:
    agent = _get_agent()
    out = agent.predict(text, GUARD_QUESTIONS)
    raw = float(out["answers"]["inject"]["noul"])
    cal = _calibrate(raw)
    flagged = cal >= threshold
    result = {
        "flagged": flagged,
        "probability": round(cal, 4),
        "raw_probability": round(raw, 4),
        "threshold": threshold,
        "temperature": TEMPERATURE,
        # 显式给默认值：消费方可以直接读，不用 .get() 也不用担心 KeyError
        "likely_false_positive": False,
    }
    if flagged:
        result["note"] = (
            "可能为提示注入/越狱。中文技术类提问有误报风险，"
            "请结合上下文判断，不要仅凭此项阻断。"
        )
        # 关键词命中只是弱信号，未命中不等于不是误报。
        if _looks_like_false_positive(text):
            result["likely_false_positive"] = True
            result["note"] += " 文本含技术类关键词，误报可能性较高。"
    return result


# ---- MCP server ----------------------------------------------------------

try:
    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "需要 mcp 依赖：pip install 'laya[mcp]'"
    ) from exc


server = MCPServer("laya")


@server.tool(
    description=(
        "用本地 Laya 决策模型检测一段文本是否在试图对 AI 助手做提示注入/越狱。"
        "单次约 55ms（CPU），完全离线。"
        "适合：网页抓取内容、工具返回结果、第三方文档、邮件正文的初筛。"
        "注意：中文技术类提问有误报，结果是概率不是判决，不要当作安全边界。"
    )
)
def laya_guard(text: str, strict: bool = False) -> str:
    """检测提示注入。

    Args:
        text: 待检测文本。超过 20000 字符会被截断（返回体里 truncated=true）。
        strict: True 用低误报阈值（0.33，精度 0.857 / 召回 0.643），
                False 用平衡阈值（0.21，F1 0.839 / 召回 0.929）
    """
    if not text or not text.strip():
        raise ToolError("text 不能为空")
    truncated = len(text) > MAX_TEXT_CHARS
    if truncated:
        text = text[:MAX_TEXT_CHARS]
    try:
        th = GUARD_THRESHOLD_STRICT if strict else GUARD_THRESHOLD
        result = _guard(text, th)
        if truncated:
            result["truncated"] = True
            result["note"] = (
                result.get("note", "")
                + f" ⚠️ 文本超过 {MAX_TEXT_CHARS} 字符已截断，尾部内容未参与检测。"
            ).strip()
        return json.dumps(result, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"guard 失败: {type(exc).__name__}: {exc}") from exc


@server.tool(
    description=(
        "用本地 Laya 决策模型做一次结构化判断：从给定选项里选一个（choice）、"
        "在量表上打分（score）、或回答是/否（noul）。约 55ms，完全离线。"
        "适合固定、反复、选项可枚举的判断，不适合开放式问题。"
        "注意：零样本准确率有限，重要判断请复核。"
        "概率默认不做温度校准（校准参数只对 guard 任务有效）。"
    )
)
def laya_decide(text: str, questions_json: str, calibrate: bool = False) -> str:
    """结构化决策。

    Args:
        text: 待判断的文本/状态
        questions_json: 问题定义 JSON，格式如：
            {"intent": {"type": "choice", "instructions": "用户在问什么?",
                        "criteria": ["退款", "技术问题", "其他"]},
             "urgent": {"type": "noul", "instructions": "是否紧急?"},
             "priority": {"type": "score", "instructions": "优先级?",
                          "criteria": ["低", "中", "高"]}}
        calibrate: 是否对 noul 概率套用温度校准。**默认关闭**——
            TEMPERATURE 是在「中文提示注入检测」这一个任务上拟合的，
            套到别的二值问题上没有依据，反而可能把原本正常校准的概率
            错误地压向 0.5。只有你确认任务分布与 guard 相近时才开。
    """
    if not text or not text.strip():
        raise ToolError("text 不能为空")
    try:
        questions = json.loads(questions_json)
    except json.JSONDecodeError as exc:
        raise ToolError(f"questions_json 不是合法 JSON: {exc}") from exc
    if not isinstance(questions, dict) or not questions:
        raise ToolError("questions_json 必须是非空对象")

    try:
        agent = _get_agent()
        out = agent.predict(text[:MAX_TEXT_CHARS], questions)
        answers = {}
        for qid, ans in out["answers"].items():
            a = dict(ans)
            if calibrate and a.get("type") == "noul" and "noul" in a:
                a["noul_raw"] = a["noul"]
                a["noul"] = round(_calibrate(float(a["noul"])), 4)
            answers[qid] = a
        return json.dumps(
            {
                "answers": answers,
                "routing": out.get("routing", {}),
                "calibrated": bool(calibrate),
                "temperature": TEMPERATURE if calibrate else None,
            },
            ensure_ascii=False,
        )
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"decide 失败: {type(exc).__name__}: {exc}") from exc


@server.tool(
    description=(
        "Laya 服务状态与实测指标。用于确认模型可用、查看校准参数和已知局限。"
    )
)
def laya_status() -> str:
    loaded = _agent is not None
    return json.dumps(
        {
            "model": "convaiinnovations/laya-multilingual",
            "device": os.environ.get("LAYA_DEVICE", "cpu"),
            "loaded": loaded,
            "load_error": _load_error,
            "temperature": TEMPERATURE,
            "guard_instruction": GUARD_INSTRUCTION,
            "thresholds": {
                "default": GUARD_THRESHOLD,
                "strict": GUARD_THRESHOLD_STRICT,
            },
            "measured": {
                "samples": 64,
                "sample_type": "synthetic",
                "benign": 36,
                "inject": 28,
                "auc": 0.9127,
                "best_f1": 0.839,
                "precision_at_threshold": 0.765,
                "recall_at_threshold": 0.929,
                "latency_ms_cpu": 55,
                "caveat": (
                    "阈值在同一份 64 条样本上选出并评估，存在乐观偏差；"
                    "换真实分布请自行重扫"
                ),
            },
            "known_limits": [
                "中文误报率高于英文，技术类提问（代码/报错/脚本）易误判",
                "温度校准只修正置信度，不提升判别力（AUC 前后一致）",
                "样本为人工构造的 64 条，非真实流量分布",
                "零样本准确率有限，不是安全边界",
            ],
        },
        ensure_ascii=False,
    )


def main() -> None:
    server.run()


if __name__ == "__main__":
    main()
