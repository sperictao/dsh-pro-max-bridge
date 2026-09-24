/**
 * DSH Pro Max bridge：把桌面应用**自己的** Plugin Manager 与 Config Editor
 * 开放给 DSH Pro Max。
 *
 * 为什么需要它：`desktop` 运行档由官方 Electron 应用独占——dsh CLI 对启动、
 * `--dump-config`、`plugin` 一律按名字拒绝，所以管理这个档的插件与配置只能走
 * 应用自己的服务，而不是在应用背后直写 `~/.dsh/profiles/desktop`（那是第二份
 * 实现，且 `--dump-config` 组合预检对 desktop 物理不可执行）。见 DSH Pro Max
 * 仓库的 ADR 0011。
 *
 * 三条上游约束（是上游行为，不是本插件的偏好）：
 * - **只增路由，不接管 connection**：桌面 shell 启动时要向宿主根路径要一次
 *   `303 + set-cookie` 换取 host cookie，替换 connection 会让这条握手失败并直接
 *   进崩溃恢复。
 * - **永不产生未处理异常**：未捕获异常会触发应用的崩溃恢复，那条路径重置 bundle
 *   列表并禁用第三方插件（普通激活失败只是被隔离，应用照常运行）。故每个路由的
 *   handler 整体兜底。
 * - **token 是纵深防御而非安全边界**：同用户的本地进程本就能直写那个 profile；
 *   token 挡的是浏览器页面之类对本机回环端口的越权调用。
 *
 * 契约：路由一律在 `/dsh-pro-max-bridge/*`（`/api` 之外——那套前缀由连接插件按
 * capability 裁决，本插件不参与）。成功的应答是 `{ok: true, data}`，失败是
 * `{ok: false, error}`；HTTP 状态码只区分传输层语义（401/405/500），业务结果在
 * body 里——`pluginManager` 的写操作把管理失败折叠进返回值而不是抛出，调用方要看
 * `data.application` 而不是状态码。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { ConfigEditor } from "@deepseek-ai/dsh-config-editor";
import type {
  BundleInfo,
  InstallBundleOptions,
  PluginEntryId,
  PluginInfo,
  PluginInstallRequestId,
  PluginManager,
} from "@deepseek-ai/dsh-plugin-manager";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

/**
 * 线协议版本。DSH Pro Max 据此判断桥接是否与它期望的接口同代：不匹配时提示升级
 * 桥接，而不是把字段缺失当成应用故障。改路由形状或字段语义时 +1。
 */
const PROTOCOL = 1;
/** 路由前缀。绝对路径，无尾斜杠（webServer 的约定）。 */
const PREFIX = "/dsh-pro-max-bridge";
/** token 文件缺省位置：两个进程只经这一份状态相交。 */
const DEFAULT_TOKEN_PATH = join(homedir(), ".dsh-pro-max", "bridge-token");
/** 请求体上限：够放一份插件 config，又不让应用进程被一个大 body 拖住。 */
const MAX_BODY_BYTES = 1 << 20;

/** 需要的服务。只 inject webServer：另外两个若缺席，路由给出原因，
 * 而不是让插件整体不激活——那样 DSH Pro Max 会把「已装但服务缺失」误报成
 * 「未安装桥接」。 */
export const inject = ["webServer"];

export interface BridgeConfig {
  /**
   * token 文件路径。缺省 `~/.dsh-pro-max/bridge-token`，DSH Pro Max 读同一份；
   * 只有测试需要换地方——两边必须指同一个文件，产品路径不要改。
   */
  tokenPath?: string;
}

interface Request {
  method: "GET" | "POST";
  path: string;
  /** ping 免 token：DSH Pro Max 用它判断桥接在不在；它不改任何东西也不泄露内容。 */
  open?: boolean;
  handle: (body: Record<string, unknown>) => unknown;
}

/**
 * 插件入口。token 写不出来就一条路由也不注册：没有可用的鉴权，注册了也只会全
 * 401，不如让桥接缺席——DSH Pro Max 报「未安装桥接」与真实情况一致。
 */
export function apply(ctx: Context, config?: BridgeConfig): void {
  const path =
    typeof config?.tokenPath === "string" && config.tokenPath !== "" ? config.tokenPath : DEFAULT_TOKEN_PATH;
  const token = ensureToken(path);
  if (token === null) return;
  for (const route of routes(ctx)) register(ctx, token, route);
}

function routes(ctx: Context): Request[] {
  return [
    {
      method: "GET",
      path: "/ping",
      open: true,
      handle: () => ({ bridge: "dsh-pro-max-bridge", protocol: PROTOCOL }),
    },
    {
      method: "GET",
      path: "/plugins",
      handle: async () => {
        const manager = service<PluginManager>(ctx, "pluginManager");
        // listBundles 在 0.1.7-rc.1 是同步、rc.2 起是异步：一律 await，两代都对
        const plugins: PluginInfo[] = await manager.listPlugins();
        const bundles: BundleInfo[] = await manager.listBundles();
        return { plugins, bundles };
      },
    },
    {
      method: "POST",
      path: "/plugins/install",
      handle: (body) => {
        const manager = service<PluginManager>(ctx, "pluginManager");
        const options: InstallBundleOptions = {};
        if (typeof body.requestId === "string") options.requestId = asId<PluginInstallRequestId>(body.requestId);
        if (typeof body.enabled === "boolean") options.enabled = body.enabled;
        if (Array.isArray(body.approvedBuilds)) options.approvedBuilds = strings(body.approvedBuilds, "approvedBuilds");
        return manager.installBundle(text(body, "spec"), options);
      },
    },
    {
      method: "POST",
      path: "/plugins/remove",
      handle: (body) => service<PluginManager>(ctx, "pluginManager").removeBundle(text(body, "name")),
    },
    {
      method: "POST",
      path: "/plugins/enable",
      handle: (body) => {
        const manager = service<PluginManager>(ctx, "pluginManager");
        const enabled = required(body, "enabled");
        if (typeof enabled !== "boolean") throw new Error('"enabled" must be a boolean');
        // 插件行与 bundle 是两套开关：行按 entryId，bundle 按包名（上游如此）
        if (typeof body.pluginId === "string") return manager.setPluginEnabled(asId<PluginEntryId>(body.pluginId), enabled);
        if (typeof body.bundleName === "string") return manager.setBundleEnabled(body.bundleName, enabled);
        throw new Error('either "pluginId" or "bundleName" is required');
      },
    },
    {
      method: "GET",
      path: "/config",
      handle: () => {
        const editor = service<ConfigEditor>(ctx, "configEditor");
        // Entry 是活的 Loader 对象（带 fiber / parent 的循环引用），过不了 JSON：
        // 只挑调用方需要寻址与展示的字段
        return editor.configuration().map(({ entry, inherited, override }) => ({
          id: entry.options.id,
          name: entry.options.name,
          current: entry.options.config ?? null,
          inherited,
          override,
        }));
      },
    },
    {
      method: "POST",
      path: "/config/edit",
      handle: async (body) => {
        const editor = service<ConfigEditor>(ctx, "configEditor");
        const id = text(body, "id");
        const config = required(body, "config");
        if (config === null || typeof config !== "object" || Array.isArray(config)) {
          throw new Error('"config" must be a JSON object');
        }
        // 活对象不能过线，只能按 id 在进程内重新寻址
        const entry = editor.entries().find((row) => row.options.id === id);
        if (entry === undefined) throw new Error(`no configuration entry with id ${JSON.stringify(id)}`);
        // change 回调收 (current, inherited) 返回下一份原始 config；这里要的是绝对值
        await editor.edit(entry, () => config as Record<string, unknown>);
        return { id };
      },
    },
  ];
}

function register(ctx: Context, token: string, route: Request): void {
  const path = `${PREFIX}${route.path}`;
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path,
        handler: async (req, res) => {
          // 整体兜底：这个 handler 里任何未捕获异常都会触发应用的崩溃恢复，
          // 那条路径会重置 bundle 列表并禁用第三方插件。宁可回一条 500。
          try {
            if (route.open !== true && !authorized(req, token)) {
              send(res, 401, { ok: false, error: "unauthorized" });
              return;
            }
            if (req.method !== route.method) {
              send(res, 405, { ok: false, error: `use ${route.method} ${path}` });
              return;
            }
            const body = route.method === "POST" ? await readJson(req) : {};
            send(res, 200, { ok: true, data: await route.handle(body) });
          } catch (error) {
            send(res, 500, { ok: false, error: message(error) });
          }
        },
      } satisfies WebRoute),
    `dsh-pro-max-bridge: ${route.method} ${path}`,
  );
}

/**
 * 取一个服务。桌面应用若没有注册它，路由给出原因而不是整体不激活——见 inject 的说明。
 */
function service<T>(ctx: Context, name: string): T {
  const found = ctx.get(name) as T | undefined;
  if (found === undefined) throw new Error(`${name} is not available in this DeepSeek Harness build`);
  return found;
}

function ensureToken(path: string): string | null {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return existing;
  } catch {
    // 不存在就往下生成；真读不了（权限等）同样在下面写失败时收口
  }
  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    return token;
  } catch (error) {
    console.error(`[dsh-pro-max-bridge] cannot write ${path}:`, message(error));
    return null;
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  // 定长比较：长度不同直接否，避免 timingSafeEqual 抛错
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  // 不回 CORS 头：浏览器页面读不到应答，配合 token 一起挡本机回环端口的越权调用
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * 过线的 id 是不透明品牌类型（PluginEntryId / PluginInstallRequestId）：调用方只能把
 * 从 list 结果里拿到的那一份原样回传，不能自己造。这条断言表达的就是这件事。
 */
function asId<T>(value: string): T {
  return value as unknown as T;
}

function required(body: Record<string, unknown>, key: string): unknown {
  const value = body[key];
  if (value === undefined) throw new Error(`"${key}" is required`);
  return value;
}

function text(body: Record<string, unknown>, key: string): string {
  const value = required(body, key);
  if (typeof value !== "string" || value === "") throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

function strings(value: unknown[], key: string): string[] {
  return value.map((item) => {
    if (typeof item !== "string") throw new Error(`"${key}" must be an array of strings`);
    return item;
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
