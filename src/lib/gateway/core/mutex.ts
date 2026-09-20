// 单并发门：同 gate 同时只放 1 个在途上游调用，其余排队。
// 用途：风控敏感上游（如 qwen 网页版）按账号串行，避免客户端 burst 并发触发 WAF。
// - 客户端 abort 即摘除排队，不泄漏、不死锁（后到的照常推进）。
// - 被执行体抛错也释放槽位。
// - 纯内存（单进程常驻），进程内互斥语义与原版同 isolate 等价。

export interface Gate {
  tail: Promise<void>;
  active: number;
  queued: number;
}

export function createGate(): Gate {
  return { tail: Promise.resolve(), active: 0, queued: 0 };
}

function abortError(): Error {
  if (typeof DOMException !== "undefined")
    return new DOMException("The operation was aborted", "AbortError");
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

export async function withGate<T>(
  gate: Gate,
  signal: AbortSignal | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const prev = gate.tail;
  let release: () => void = () => {};
  gate.tail = new Promise<void>((res) => {
    release = res;
  });
  gate.queued += 1;
  let onAbort: (() => void) | null = null;
  try {
    if (signal?.aborted) throw abortError();
    if (signal) {
      await Promise.race([
        prev,
        new Promise<never>((_, rej) => {
          onAbort = () => rej(abortError());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } else {
      await prev;
    }
    if (signal?.aborted) throw abortError();
    gate.active += 1;
    try {
      return await fn();
    } finally {
      gate.active -= 1;
    }
  } finally {
    gate.queued -= 1;
    if (signal && onAbort) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        /* noop */
      }
    }
    release();
  }
}
