// 用**真实的** WebServer 起一个服务，把桥接注册上去，再走真实 HTTP。
//
// 替身 ctx（bridge.test.ts）验的是路由逻辑；这里验的是「注册在真 WebServer 上能否成立」：
// 精确匹配、重复注册会不会撞、方法不符与未授权各回什么、未匹配路径是否 404。这些只有真
// 服务说了算，也正是桥接装进桌面应用后第一步会遇到的东西。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apply } from "../src/index.ts";

const PREFIX = "/dsh-pro-max-bridge";
const TOKEN_HEADER = "authorization";

let ctx: Context;
let server: WebServer;
let token: string;
let dir: string;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dsh-pro-max-bridge-ws-"));
  ctx = new Context();
  // port 0 = 交给系统分配，测试之间不会撞端口
  server = new WebServer(ctx, { host: "127.0.0.1", port: 0 });
  await server[Service.init]();
  apply(ctx, { tokenPath: join(dir, "bridge-token") });
  token = readFileSync(join(dir, "bridge-token"), "utf8").trim();
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  // WebServer 没有公开的 close：套接字由持有它的 fiber 的 disposer 关，而这里为了少牵扯
  // cordis 的插件生命周期是直接构造的。端口由系统分配（port 0），所以即便这个监听活到进程
  // 结束也不会与别的测试撞——不假装能关。
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, options: { token?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = {};
  const value = options.token === undefined ? token : options.token;
  if (value !== null) headers[TOKEN_HEADER] = `Bearer ${value}`;
  const res = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

describe("the real web server accepts the bridge", () => {
  it("registered every route without a collision", async () => {
    // 重复的 (kind, path) 在真 WebServer 上会抛——能走到这里就说明 7 条路径互不冲突
    const ping = await get(`${PREFIX}/ping`, { token: null });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ ok: true, data: { bridge: "dsh-pro-max-bridge", protocol: 1, ready: true } });
  });

  it("keeps the routes exact, so the prefix itself is not a route", async () => {
    // 前缀是 exact 路由的共同开头，不是 prefix 路由：光访问前缀应当 404
    const res = await get(PREFIX);
    expect(res.status).toBe(404);
  });

  it("answers an unknown path under the prefix with 404 rather than the bridge", async () => {
    const res = await get(`${PREFIX}/nope`);
    expect(res.status).toBe(404);
  });

  it("rejects a capability route before it reaches the handler", async () => {
    const res = await get(`${PREFIX}/config`, { token: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "unauthorized" });
  });

  it("lets an authorized request through to the service guard", async () => {
    // 没有注册 configEditor：能拿到这条具名错误，就说明鉴权已经过了、走到了服务检查
    const res = await get(`${PREFIX}/config`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("configEditor is not available in this DeepSeek Harness build");
  });

  it("names the method to use when the verb is wrong", async () => {
    const res = await get(`${PREFIX}/ping`, { token: null, method: "POST" });
    expect(res.status).toBe(405);
    expect(res.body.error).toContain("GET");
  });

  it("serves the token only to a matching bearer value", async () => {
    const wrong = await get(`${PREFIX}/plugins`, { token: `${token}x` });
    expect(wrong.status).toBe(401);
    const right = await get(`${PREFIX}/plugins`);
    // 鉴权已过：失败原因是服务缺失，不是 401
    expect(right.status).toBe(500);
    expect(right.body.error).toContain("pluginManager");
  });
});
