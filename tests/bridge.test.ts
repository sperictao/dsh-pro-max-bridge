// 桥接的 HTTP 面：用一个替身 ctx 承接注册的路由，再按真实请求形状驱动它们。
// 这样路由、鉴权、序列化与兜底都能在没有桌面应用的情况下验证——真机只剩「应用
// 自己的服务确实按这个形状应答」这一件事。

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/index.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const TOKEN_HEADER = "authorization";

interface Harness {
  routes: Map<string, Handler>;
  token: string;
  dir: string;
}

/**
 * 替身 ctx：webServer 是属性（cordis 就是这么暴露服务的，插件的写法与真实宿主
 * 插件一致），另外两个经 ctx.get——这样「服务缺失」走的是插件里那条明确的报错
 * 路径，而不是一个 TypeError。ctx.effect 立即执行并返回 disposer。
 */
function fakeCtx(services: Record<string, unknown> = {}): { ctx: unknown; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>();
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    get: (name: string) => services[name],
    webServer: {
      register: (route: { path: string; handler: Handler }) => {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes };
}

function harness(options: { services?: Record<string, unknown> } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "dsh-pro-max-bridge-test-"));
  const { ctx, routes } = fakeCtx(options.services);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply(ctx as any, { tokenPath: join(dir, "bridge-token") });
  return { routes, token: readFileSync(join(dir, "bridge-token"), "utf8").trim(), dir };
}

interface Reply {
  status: number;
  body: { ok: boolean; data?: unknown; error?: string };
}

async function call(
  h: Harness,
  path: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<Reply> {
  const handler = h.routes.get(`/dsh-pro-max-bridge${path}`);
  if (handler === undefined) throw new Error(`no route registered for ${path}`);
  const payload = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? h.token : options.token;
  if (token !== null) headers[TOKEN_HEADER] = `Bearer ${token}`;
  const req = Readable.from(payload) as unknown as IncomingMessage;
  req.method = options.body === undefined ? "GET" : "POST";
  req.headers = headers;
  let status = 0;
  let text = "";
  const res = {
    setHeader: () => undefined,
    end: (chunk: string) => {
      text = chunk;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, "statusCode", {
    set: (value: number) => {
      status = value;
    },
    get: () => status,
  });
  await handler(req, res);
  return { status, body: JSON.parse(text) as Reply["body"] };
}

let h: Harness;
afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("registers every route under the bridge prefix, once each", () => {
    h = harness();
    expect([...h.routes.keys()].sort()).toEqual(
      [
        "/dsh-pro-max-bridge/config",
        "/dsh-pro-max-bridge/config/edit",
        "/dsh-pro-max-bridge/ping",
        "/dsh-pro-max-bridge/plugins",
        "/dsh-pro-max-bridge/plugins/enable",
        "/dsh-pro-max-bridge/plugins/install",
        "/dsh-pro-max-bridge/plugins/remove",
      ].sort(),
    );
  });

  it("writes the token readable only by its owner", () => {
    h = harness();
    expect(statSync(join(h.dir, "bridge-token")).mode & 0o777).toBe(0o600);
  });

  it("reuses an existing token instead of rotating it under the reader", () => {
    const first = harness();
    const second = harness();
    expect(second.token).not.toBe(first.token);
    // 同一目录再激活一次：token 必须原样保留，否则 DSH Pro Max 手上的那份立刻失效
    const dir = first.dir;
    rmSync(second.dir, { recursive: true, force: true });
    const { ctx } = fakeCtx();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply(ctx as any, { tokenPath: join(dir, "bridge-token") });
    expect(readFileSync(join(dir, "bridge-token"), "utf8").trim()).toBe(first.token);
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers nothing when the token cannot be written", () => {
    const { ctx, routes } = fakeCtx();
    // "/" 是个目录：写它必然失败（EISDIR），token 拿不到
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apply(ctx as any, { tokenPath: "/" });
    expect(routes.size).toBe(0);
  });
});

describe("authorization", () => {
  it("answers ping without a token so the bridge stays detectable", async () => {
    h = harness();
    const reply = await call(h, "/ping", { token: null });
    expect(reply.status).toBe(200);
    expect(reply.body.data).toEqual({ bridge: "dsh-pro-max-bridge", protocol: 1 });
  });

  it("refuses every capability route without the token", async () => {
    h = harness();
    for (const path of ["/plugins", "/config", "/plugins/install", "/plugins/remove", "/plugins/enable"]) {
      const reply = await call(h, path, { token: null });
      expect(reply.status, path).toBe(401);
    }
  });

  it("refuses a token that is a different length or value", async () => {
    h = harness();
    expect((await call(h, "/config", { token: "short" })).status).toBe(401);
    expect((await call(h, "/config", { token: `${h.token}extra` })).status).toBe(401);
  });
});

describe("plugins", () => {
  it("returns plugins and bundles as plain data", async () => {
    const listPlugins = vi.fn().mockResolvedValue([{ entryId: "e1", moduleName: "m", enabled: true }]);
    const listBundles = vi.fn().mockResolvedValue([{ name: "b", version: "1.0.0" }]);
    h = harness({ services: { pluginManager: { listPlugins, listBundles } } });

    const reply = await call(h, "/plugins");
    expect(reply.body.data).toEqual({
      plugins: [{ entryId: "e1", moduleName: "m", enabled: true }],
      bundles: [{ name: "b", version: "1.0.0" }],
    });
  });

  it("awaits listBundles so both the sync and async generations work", async () => {
    // 0.1.7-rc.1 同步、rc.2 起异步：同一份代码要两种都对
    const listBundles = vi.fn().mockReturnValue([{ name: "b" }]);
    h = harness({ services: { pluginManager: { listPlugins: vi.fn().mockResolvedValue([]), listBundles } } });
    const reply = await call(h, "/plugins");
    expect(reply.status).toBe(200);
    expect(reply.body.data).toEqual({ plugins: [], bundles: [{ name: "b" }] });
  });

  it("passes only the options the caller supplied", async () => {
    const installBundle = vi.fn().mockResolvedValue({ application: "restart-required" });
    h = harness({ services: { pluginManager: { installBundle } } });

    await call(h, "/plugins/install", { body: { spec: "https://example.test/x.tgz" } });
    expect(installBundle).toHaveBeenCalledWith("https://example.test/x.tgz", {});
  });

  it("carries requestId, enabled and approvedBuilds through", async () => {
    const installBundle = vi.fn().mockResolvedValue({ application: "applied" });
    h = harness({ services: { pluginManager: { installBundle } } });

    await call(h, "/plugins/install", {
      body: { spec: "s", requestId: "r1", enabled: false, approvedBuilds: ["pkg"] },
    });
    expect(installBundle).toHaveBeenCalledWith("s", { requestId: "r1", enabled: false, approvedBuilds: ["pkg"] });
  });

  it("routes enable to the plugin row or the bundle by which id the caller sent", async () => {
    const setPluginEnabled = vi.fn().mockResolvedValue({ application: "applied" });
    const setBundleEnabled = vi.fn().mockResolvedValue({ application: "applied" });
    h = harness({ services: { pluginManager: { setPluginEnabled, setBundleEnabled } } });

    await call(h, "/plugins/enable", { body: { pluginId: "e1", enabled: false } });
    expect(setPluginEnabled).toHaveBeenCalledWith("e1", false);

    await call(h, "/plugins/enable", { body: { bundleName: "b", enabled: true } });
    expect(setBundleEnabled).toHaveBeenCalledWith("b", true);

    const neither = await call(h, "/plugins/enable", { body: { enabled: true } });
    expect(neither.status).toBe(500);
    expect(neither.body.error).toMatch(/pluginId.*bundleName/);
  });

  it("removes a bundle by name", async () => {
    const removeBundle = vi.fn().mockResolvedValue({ application: "applied" });
    h = harness({ services: { pluginManager: { removeBundle } } });
    await call(h, "/plugins/remove", { body: { name: "b" } });
    expect(removeBundle).toHaveBeenCalledWith("b");
  });

  it("reports the manager's failure result rather than masking it as success", async () => {
    // 写操作把管理失败折叠进返回值而不是抛出，调用方要看 application
    const failure = { application: "failed", error: { code: "unknown-plugin" } };
    h = harness({ services: { pluginManager: { removeBundle: vi.fn().mockResolvedValue(failure) } } });

    const reply = await call(h, "/plugins/remove", { body: { name: "b" } });
    expect(reply.status).toBe(200);
    expect(reply.body.data).toEqual(failure);
  });
});

describe("config", () => {
  it("strips live loader entries down to serializable fields", async () => {
    // Entry 带 fiber / parent 循环引用，直接 JSON.stringify 会抛
    const entry = { options: { id: "llm-pi-ai", name: "pkg", config: { providers: [] } }, fiber: {} };
    entry.fiber = { parent: entry };
    const configuration = vi.fn().mockReturnValue([{ entry, inherited: { a: 1 }, override: {} }]);
    h = harness({ services: { configEditor: { configuration } } });

    const reply = await call(h, "/config");
    expect(reply.status).toBe(200);
    expect(reply.body.data).toEqual([
      { id: "llm-pi-ai", name: "pkg", current: { providers: [] }, inherited: { a: 1 }, override: {} },
    ]);
  });

  it("edits by re-addressing the entry by id and writing the absolute config", async () => {
    const target = { options: { id: "agent-default-model", name: "pkg", config: { old: true } } };
    const entries = vi.fn().mockReturnValue([target]);
    const edit = vi.fn().mockResolvedValue(undefined);
    h = harness({ services: { configEditor: { entries, edit } } });

    const next = { model: "x" };
    const reply = await call(h, "/config/edit", { body: { id: "agent-default-model", config: next } });
    expect(reply.status).toBe(200);
    expect(edit).toHaveBeenCalledTimes(1);
    const [entry, change] = edit.mock.calls[0] as [unknown, (c: unknown, i: unknown) => unknown];
    expect(entry).toBe(target);
    expect(change({}, {})).toEqual(next);
  });

  it("refuses an unknown row id and a non-object config", async () => {
    const entries = vi.fn().mockReturnValue([]);
    const edit = vi.fn();
    h = harness({ services: { configEditor: { entries, edit } } });

    expect((await call(h, "/config/edit", { body: { id: "nope", config: {} } })).body.error).toMatch(/no configuration entry/);
    expect((await call(h, "/config/edit", { body: { id: "x", config: [] } })).body.error).toMatch(/JSON object/);
    expect(edit).not.toHaveBeenCalled();
  });
});

describe("containment", () => {
  it("names a missing service instead of failing the whole plugin", async () => {
    // 应用若没注册这两个服务，路由要说明原因：否则 DSH Pro Max 会把
    // 「已装但服务缺失」误报成「未安装桥接」
    h = harness();
    const reply = await call(h, "/plugins");
    expect(reply.status).toBe(500);
    expect(reply.body.error).toBe("pluginManager is not available in this DeepSeek Harness build");
  });

  it("turns a throwing handler into a 500 instead of an unhandled rejection", async () => {
    // 未捕获异常会触发应用的崩溃恢复并禁用第三方插件
    h = harness({ services: { pluginManager: { listPlugins: vi.fn().mockRejectedValue(new Error("boom")) } } });
    const reply = await call(h, "/plugins");
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ ok: false, error: "boom" });
  });

  it("replies 405 with the method to use", async () => {
    h = harness();
    const handler = h.routes.get("/dsh-pro-max-bridge/ping");
    const req = Readable.from([]) as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = {};
    let status = 0;
    let text = "";
    const res = {
      setHeader: () => undefined,
      end: (chunk: string) => {
        text = chunk;
      },
    } as unknown as ServerResponse;
    Object.defineProperty(res, "statusCode", { set: (v: number) => (status = v), get: () => status });
    await handler!(req, res);
    expect(status).toBe(405);
    expect(JSON.parse(text).error).toMatch(/GET/);
  });

  it("rejects a body that is not a JSON object", async () => {
    h = harness({ services: { pluginManager: { removeBundle: vi.fn() } } });
    const handler = h.routes.get("/dsh-pro-max-bridge/plugins/remove")!;
    const req = Readable.from([Buffer.from("[]")]) as unknown as IncomingMessage;
    req.method = "POST";
    req.headers = { [TOKEN_HEADER]: `Bearer ${h.token}` };
    let status = 0;
    let text = "";
    const res = {
      setHeader: () => undefined,
      end: (chunk: string) => {
        text = chunk;
      },
    } as unknown as ServerResponse;
    Object.defineProperty(res, "statusCode", { set: (v: number) => (status = v), get: () => status });
    await handler(req, res);
    expect(status).toBe(500);
    expect(JSON.parse(text).error).toMatch(/JSON object/);
  });

  it("requires the required string fields", async () => {
    h = harness({ services: { pluginManager: { installBundle: vi.fn() } } });
    expect((await call(h, "/plugins/install", { body: {} })).body.error).toMatch(/"spec" is required/);
    expect((await call(h, "/plugins/install", { body: { spec: "" } })).body.error).toMatch(/non-empty string/);
  });
});
